// Gridded wind forecasts from Open-Meteo (decoded from the Météo-France / DWD / ECMWF / NOAA GRIB runs).
import { FIELD_BBOX, HISTORY_MODELS, HISTORY_START, Zone } from './config';
import { cacheGet, cacheSet, fetchJSON, offset } from './util';

export interface Grid {
  lats: number[];
  lons: number[];
  /** Optional regular-grid shape (for interpolation). */
  nx?: number;
  ny?: number;
}

export interface WindSeries {
  times: number[]; // epoch ms
  /** [point][time] in knots / degrees. */
  speed: (number | null)[][];
  dir: (number | null)[][];
  gust: (number | null)[][];
  model: string;
}

const API = 'https://api.open-meteo.com/v1/forecast';
const HIST_API = 'https://historical-forecast-api.open-meteo.com/v1/forecast';
const CHUNK = 100;

export function regionalGrid(): Grid {
  const { west, east, south, north, step } = FIELD_BBOX;
  const lats: number[] = [], lons: number[] = [];
  const nx = Math.round((east - west) / step) + 1;
  const ny = Math.round((north - south) / step) + 1;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      lats.push(+(south + j * step).toFixed(4));
      lons.push(+(west + i * step).toFixed(4));
    }
  return { lats, lons, nx, ny };
}

/** n×n grid over the zone (row-major from south-west). Index (n*n-1)/2 is the centre. */
export function zoneGrid(z: Zone, n = 3): Grid {
  const lats: number[] = [], lons: number[] = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const dx = -z.halfKm + (2 * z.halfKm * i) / (n - 1);
      const dy = -z.halfKm + (2 * z.halfKm * j) / (n - 1);
      const [lo, la] = offset(z.lat, z.lon, dx, dy);
      lats.push(+la.toFixed(4));
      lons.push(+lo.toFixed(4));
    }
  return { lats, lons, nx: n, ny: n };
}

function parse(res: any | any[], model: string): WindSeries {
  const arr = Array.isArray(res) ? res : [res];
  const h0 = arr[0].hourly;
  const sfx = h0[`wind_speed_10m_${model}`] ? `_${model}` : '';
  return {
    times: h0.time.map((t: number) => t * 1000),
    speed: arr.map((r) => r.hourly[`wind_speed_10m${sfx}`]),
    dir: arr.map((r) => r.hourly[`wind_direction_10m${sfx}`]),
    gust: arr.map((r) => r.hourly[`wind_gusts_10m${sfx}`] ?? r.hourly.time.map(() => null)),
    model,
  };
}

function merge(parts: WindSeries[]): WindSeries {
  return {
    times: parts[0].times,
    speed: parts.flatMap((p) => p.speed),
    dir: parts.flatMap((p) => p.dir),
    gust: parts.flatMap((p) => p.gust),
    model: parts[0].model,
  };
}

async function query(api: string, grid: Grid, model: string, extra: string, vars: string): Promise<WindSeries> {
  const parts: WindSeries[] = [];
  for (let i = 0; i < grid.lats.length; i += CHUNK) {
    const la = grid.lats.slice(i, i + CHUNK).join(',');
    const lo = grid.lons.slice(i, i + CHUNK).join(',');
    const url = `${api}?latitude=${la}&longitude=${lo}&hourly=${vars}&models=${model}&wind_speed_unit=kn&timeformat=unixtime&cell_selection=sea${extra}`;
    parts.push(parse(await fetchJSON(url), model));
  }
  return merge(parts);
}

export async function fetchForecast(grid: Grid, model: string, days: number): Promise<WindSeries> {
  const key = `fc:${model}:${grid.lats.length}:${grid.lats[0]}:${grid.lons[0]}`;
  const cached = await cacheGet<{ at: number; data: WindSeries }>(key);
  if (cached && Date.now() - cached.at < 30 * 60e3) return cached.data;
  const data = await query(API, grid, model, `&forecast_days=${days}&past_days=1`, 'wind_speed_10m,wind_direction_10m,wind_gusts_10m');
  await cacheSet(key, { at: Date.now(), data });
  return data;
}

/** True when most values are missing (model not available for this point/period). */
const mostlyNull = (s: WindSeries) => {
  const v = s.speed[Math.floor(s.speed.length / 2)];
  return v.filter((x) => x == null).length > v.length * 0.5;
};

/**
 * Historical fine-mesh archive (hourly AROME runs since HISTORY_START) for a zone grid.
 * Fetched year by year and cached in IndexedDB (≈ 1–3 MB per zone).
 */
export async function fetchHistory(
  grid: Grid,
  zoneId: string,
  onProgress?: (msg: string) => void,
): Promise<WindSeries> {
  const end = new Date(Date.now() - 2 * 86400e3).toISOString().slice(0, 10);
  const key = `hist:v1:${zoneId}:${grid.lats.join(',')}:${grid.lons.join(',')}`;
  const cached = await cacheGet<{ end: string; data: WindSeries }>(key);
  if (cached && cached.end >= new Date(Date.now() - 10 * 86400e3).toISOString().slice(0, 10)) return cached.data;

  // Static pre-built archive (pipeline/build_analog_db.py) if present.
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}data/analogs/${zoneId}.json`);
    if (r.ok && (r.headers.get('content-type') || '').includes('json')) {
      const data = (await r.json()) as WindSeries;
      await cacheSet(key, { end, data });
      return data;
    }
  } catch {
    /* fall back to live API */
  }

  const startY = +HISTORY_START.slice(0, 4);
  const endY = +end.slice(0, 4);
  for (const model of HISTORY_MODELS) {
    const parts: WindSeries[] = [];
    for (let y = startY; y <= endY; y++) {
      const s = y === startY ? HISTORY_START : `${y}-01-01`;
      const e = y === endY ? end : `${y}-12-31`;
      onProgress?.(`Archive ${model.replace('meteofrance_', '').toUpperCase()} ${y}…`);
      parts.push(await query(HIST_API, grid, model, `&start_date=${s}&end_date=${e}`, 'wind_speed_10m,wind_direction_10m'));
    }
    const data: WindSeries = {
      times: parts.flatMap((p) => p.times),
      speed: grid.lats.map((_, i) => parts.flatMap((p) => p.speed[i])),
      dir: grid.lats.map((_, i) => parts.flatMap((p) => p.dir[i])),
      gust: [],
      model,
    };
    if (!mostlyNull(data)) {
      await cacheSet(key, { end, data });
      return data;
    }
  }
  throw new Error('Archive historique indisponible pour cette zone.');
}

/** Bilinear sample of a regular grid at fractional coords. */
export function sampleField(values: (number | null)[], nx: number, ny: number, fx: number, fy: number): number | null {
  const i = Math.max(0, Math.min(nx - 1.0001, fx)), j = Math.max(0, Math.min(ny - 1.0001, fy));
  const i0 = Math.floor(i), j0 = Math.floor(j), tx = i - i0, ty = j - j0;
  const g = (a: number, b: number) => values[b * nx + a];
  const corners = [g(i0, j0), g(i0 + 1, j0), g(i0, j0 + 1), g(i0 + 1, j0 + 1)];
  const w = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
  let s = 0, ws = 0;
  corners.forEach((c, k) => {
    if (c != null) { s += c * w[k]; ws += w[k]; }
  });
  return ws > 0 ? s / ws : null;
}
