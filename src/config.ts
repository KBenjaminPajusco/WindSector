// Static configuration: Marseille area, water zones ("plans d'eau"), forecast models.
import zones from './zones.json';

export const MARSEILLE = { lon: 5.33, lat: 43.27 };

/** Box used for the regional forecast field over the water. */
export const FIELD_BBOX = { west: 4.86, east: 5.98, south: 43.04, north: 43.56, step: 0.04 };

export interface Zone {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Half-size of the sampled square in km. */
  halfKm: number;
  note: string;
}

/** Preset racing / sailing areas (shared with the Python pipeline). The analysis samples a 3×3 grid on each. */
export const ZONES: Zone[] = zones;

export interface Model {
  id: string;
  name: string;
  res: string;
  days: number;
}

export const MODELS: Model[] = [
  { id: 'meteofrance_arome_france_hd', name: 'AROME HD', res: '1,5 km', days: 2 },
  { id: 'meteofrance_arome_france', name: 'AROME', res: '2,5 km', days: 2 },
  { id: 'meteofrance_arpege_europe', name: 'ARPEGE', res: '11 km', days: 4 },
  { id: 'icon_eu', name: 'ICON-EU', res: '7 km', days: 5 },
  { id: 'ecmwf_ifs025', name: 'ECMWF IFS', res: '25 km', days: 7 },
  { id: 'gfs_seamless', name: 'GFS', res: '25 km', days: 7 },
];

/** Historical fine-mesh model used for analogs (Open-Meteo archive of AROME GRIB runs). */
export const HISTORY_MODELS = ['meteofrance_arome_france_hd', 'meteofrance_arome_france'];
export const HISTORY_START = '2023-01-01';

export const METAR_STATIONS = [
  { id: 'LFML', name: 'Marseille-Provence (METAR)', lat: 43.4367, lon: 5.2150 },
  { id: 'LFMI', name: 'Istres (METAR)', lat: 43.5227, lon: 4.9238 },
  { id: 'LFMQ', name: 'Le Castellet (METAR)', lat: 43.2525, lon: 5.7853 },
  { id: 'LFTH', name: 'Toulon-Hyères (METAR)', lat: 43.0973, lon: 6.1460 },
];

/** Box used to filter OpenWindMap / Pioupiou stations. */
export const STATION_BBOX = { west: 4.75, east: 6.0, south: 42.95, north: 43.7 };
