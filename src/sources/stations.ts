// Public anemometers: Météo-France (static JSON built by the pipeline), OpenWindMap/Pioupiou (live API),
// METAR airports (live via Iowa Environmental Mesonet, CORS enabled).
import { METAR_STATIONS, STATION_BBOX } from '../config';
import { fetchJSON, KMH_TO_KT, MS_TO_KT } from '../util';

export type Source = 'meteofrance' | 'openwindmap' | 'metar';

export interface Obs { t: Date; speed: number | null; gust: number | null; dir: number | null }

export interface Station {
  key: string; // source:id
  id: string;
  name: string;
  lat: number;
  lon: number;
  alt?: number;
  source: Source;
  last: Obs | null;
  /** Loads recent history (kt). */
  history: () => Promise<Obs[]>;
}

export const SOURCE_LABEL: Record<Source, string> = {
  meteofrance: 'Météo-France',
  openwindmap: 'OpenWindMap / Pioupiou',
  metar: 'METAR aéroport',
};

const base = import.meta.env.BASE_URL;

const ms = (v: number | null | undefined) => (v == null ? null : v * MS_TO_KT);
const kmh = (v: number | null | undefined) => (v == null ? null : v * KMH_TO_KT);

export async function loadMeteoFrance(): Promise<{ stations: Station[]; generated: string }> {
  const j = await fetchJSON<any>(`${base}data/mf/stations.json`, { cache: 'no-cache' });
  const stations = j.stations.map((s: any): Station => ({
    key: `meteofrance:${s.id}`,
    id: s.id,
    name: s.name,
    lat: s.lat,
    lon: s.lon,
    alt: s.alt,
    source: 'meteofrance',
    last: s.last ? { t: new Date(s.last.t * 1000), speed: ms(s.last.ff), gust: ms(s.last.fxi), dir: s.last.dd } : null,
    history: async () =>
      s.recent.map((r: number[]) => ({ t: new Date(r[0] * 3600 * 1000), speed: ms(r[1]), dir: r[2], gust: ms(r[3]) })),
  }));
  return { stations, generated: j.generated };
}

/** Full hourly history (since 2020) of a Météo-France station, in kt. Index by hour since epoch. */
export interface MFHistory { t0: number; ff: (number | null)[]; dd: (number | null)[]; fxi: (number | null)[] }
const mfHist = new Map<string, Promise<MFHistory>>();
export function loadMFHistory(id: string): Promise<MFHistory> {
  if (!mfHist.has(id)) {
    mfHist.set(
      id,
      fetchJSON<any>(`${base}data/mf/history/${id}.json`).then((j) => ({
        t0: j.t0,
        ff: j.ff.map((v: number | null) => (v == null ? null : v * 0.1 * MS_TO_KT)),
        dd: j.dd,
        fxi: j.fxi.map((v: number | null) => (v == null ? null : v * 0.1 * MS_TO_KT)),
      })),
    );
  }
  return mfHist.get(id)!;
}

export async function loadOpenWindMap(): Promise<Station[]> {
  const j = await fetchJSON<any>('https://api.pioupiou.fr/v1/live-with-meta/all');
  const b = STATION_BBOX;
  return j.data
    .filter((s: any) => {
      const l = s.location;
      return l && l.latitude != null && l.latitude > b.south && l.latitude < b.north && l.longitude > b.west && l.longitude < b.east;
    })
    .filter((s: any) => s.measurements?.date && Date.now() - Date.parse(s.measurements.date) < 3 * 24 * 3600e3)
    .map((s: any): Station => ({
      key: `openwindmap:${s.id}`,
      id: String(s.id),
      name: (s.meta?.name || '').trim() || `Balise ${s.id}`,
      lat: s.location.latitude,
      lon: s.location.longitude,
      source: 'openwindmap',
      last: {
        t: new Date(s.measurements.date),
        speed: kmh(s.measurements.wind_speed_avg),
        gust: kmh(s.measurements.wind_speed_max),
        dir: s.measurements.wind_heading,
      },
      history: async () => {
        const a = await fetchJSON<any>(`https://api.pioupiou.fr/v1/archive/${s.id}?start=last-day&stop=now&format=json`);
        return a.data.map((r: any[]) => ({ t: new Date(r[0]), speed: kmh(r[4]), gust: kmh(r[5]), dir: r[6] }));
      },
    }));
}

export async function loadMetar(): Promise<Station[]> {
  const out = await Promise.allSettled(
    METAR_STATIONS.map(async (m): Promise<Station> => {
      const j = await fetchJSON<any>(`https://mesonet.agron.iastate.edu/json/current.py?station=${m.id}&network=FR__ASOS`, undefined, 0);
      const o = j.last_ob || {};
      return {
        key: `metar:${m.id}`,
        id: m.id,
        name: m.name,
        lat: m.lat,
        lon: m.lon,
        source: 'metar',
        last: o.utc_valid
          ? { t: new Date(o.utc_valid), speed: o['windspeed[kt]'], gust: o['windgust[kt]'] ?? null, dir: o['winddirection[deg]'] }
          : null,
        history: async () => {
          const now = new Date();
          const start = new Date(now.getTime() - 36 * 3600e3);
          const p = (d: Date) => `year1=${d.getUTCFullYear()}&month1=${d.getUTCMonth() + 1}&day1=${d.getUTCDate()}`;
          const e = new Date(now.getTime() + 24 * 3600e3);
          const url = `https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=${m.id}&data=sknt&data=drct&data=gust&${p(start)}&year2=${e.getUTCFullYear()}&month2=${e.getUTCMonth() + 1}&day2=${e.getUTCDate()}&tz=Etc/UTC&format=onlycomma&missing=empty`;
          const txt = await (await fetch(url)).text();
          return txt
            .trim()
            .split('\n')
            .slice(1)
            .map((l) => l.split(','))
            .map((c) => ({
              t: new Date(c[1].replace(' ', 'T') + 'Z'),
              speed: c[2] ? +c[2] : null,
              dir: c[3] ? +c[3] : null,
              gust: c[4] ? +c[4] : null,
            }))
            .filter((o) => o.t >= start);
        },
      };
    }),
  );
  return out.filter((r): r is PromiseFulfilledResult<Station> => r.status === 'fulfilled').map((r) => r.value);
}
