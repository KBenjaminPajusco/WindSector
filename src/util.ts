export const MS_TO_KT = 1.943844;
export const KMH_TO_KT = 0.539957;

export const deg2rad = (d: number) => (d * Math.PI) / 180;
export const rad2deg = (r: number) => (r * 180) / Math.PI;

/** Signed smallest difference b - a in degrees, in (-180, 180]. Positive = clockwise (veer). */
export function angDiff(a: number, b: number): number {
  let d = ((b - a) % 360 + 540) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

/** Vector mean of meteorological directions (deg, where the wind comes FROM), weighted. */
export function circMean(dirs: number[], weights?: number[]): number {
  let s = 0, c = 0;
  dirs.forEach((d, i) => {
    const w = weights ? weights[i] : 1;
    s += w * Math.sin(deg2rad(d));
    c += w * Math.cos(deg2rad(d));
  });
  return (rad2deg(Math.atan2(s, c)) + 360) % 360;
}

export function circStd(dirs: number[]): number {
  if (!dirs.length) return 0;
  let s = 0, c = 0;
  for (const d of dirs) { s += Math.sin(deg2rad(d)); c += Math.cos(deg2rad(d)); }
  const R = Math.min(1, Math.hypot(s, c) / dirs.length);
  return rad2deg(Math.sqrt(-2 * Math.log(Math.max(R, 1e-9))));
}

export const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

export function quantile(a: number[], q: number): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const p = (s.length - 1) * q;
  const lo = Math.floor(p), hi = Math.ceil(p);
  return s[lo] + (s[hi] - s[lo]) * (p - lo);
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
export const compass = (d: number) => COMPASS[Math.round(((d % 360) + 360) % 360 / 22.5) % 16];

/** Local names of the winds in Provence (approximate sectors). */
export function windName(d: number, kt: number): string {
  if (kt < 4) return 'Pétole';
  if (d >= 290 || d < 20) return d >= 300 && d <= 350 ? 'Mistral' : 'Tramontane / Mistral';
  if (d >= 20 && d < 70) return 'Grégal';
  if (d >= 70 && d < 115) return 'Levant';
  if (d >= 115 && d < 160) return 'Sirocco / Est-Sud-Est';
  if (d >= 160 && d < 200) return 'Marin';
  if (d >= 200 && d < 250) return 'Labéch / thermique';
  return 'Ponant';
}

// Beaufort-like palette for knots (hue stops), used both on map and in charts.
const STOPS: [number, [number, number, number]][] = [
  [0, [160, 196, 255]],
  [5, [86, 170, 240]],
  [10, [60, 200, 140]],
  [15, [230, 214, 60]],
  [20, [245, 150, 40]],
  [25, [230, 70, 50]],
  [32, [190, 40, 140]],
  [40, [120, 40, 170]],
];

export function speedRGB(kt: number): [number, number, number] {
  if (!(kt >= 0)) return [128, 128, 128];
  for (let i = 1; i < STOPS.length; i++) {
    if (kt <= STOPS[i][0]) {
      const [k0, c0] = STOPS[i - 1], [k1, c1] = STOPS[i];
      const t = (kt - k0) / (k1 - k0);
      return [0, 1, 2].map((j) => Math.round(c0[j] + (c1[j] - c0[j]) * t)) as [number, number, number];
    }
  }
  return STOPS[STOPS.length - 1][1];
}
export const speedColor = (kt: number) => `rgb(${speedRGB(kt).join(',')})`;

/** MapLibre expression equivalent to speedColor on property `prop`. */
export function speedColorExpr(prop: string): unknown[] {
  const e: unknown[] = ['interpolate', ['linear'], ['coalesce', ['get', prop], 0]];
  for (const [k, c] of STOPS) e.push(k, `rgb(${c.join(',')})`);
  return e;
}

export const fmt = (v: number | null | undefined, d = 0) => (v == null || Number.isNaN(v) ? '–' : v.toFixed(d));

export function fmtTime(t: Date, withDay = true): string {
  return t.toLocaleString('fr-FR', {
    timeZone: 'Europe/Paris',
    weekday: withDay ? 'short' : undefined,
    day: withDay ? '2-digit' : undefined,
    month: withDay ? '2-digit' : undefined,
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** km offsets -> lon/lat around a point. */
export function offset(lat: number, lon: number, dxKm: number, dyKm: number): [number, number] {
  return [lon + dxKm / (111.32 * Math.cos(deg2rad(lat))), lat + dyKm / 110.57];
}

export async function fetchJSON<T = any>(url: string, init?: RequestInit, retries = 2): Promise<T> {
  let last: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, init);
      if (r.status === 429 || r.status >= 500) {
        const body = await r.text();
        throw new Error(`${r.status} ${body.slice(0, 160)}`);
      }
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 160)}`);
      return (await r.json()) as T;
    } catch (e) {
      last = e;
      if (i < retries) await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
    }
  }
  throw last;
}

/** Tiny IndexedDB key/value cache (falls back to memory). */
const mem = new Map<string, unknown>();
function db(): Promise<IDBDatabase | null> {
  return new Promise((res) => {
    try {
      const req = indexedDB.open('windsector', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => res(req.result);
      req.onerror = () => res(null);
    } catch {
      res(null);
    }
  });
}
export async function cacheGet<T>(key: string): Promise<T | undefined> {
  if (mem.has(key)) return mem.get(key) as T;
  const d = await db();
  if (!d) return undefined;
  return new Promise((res) => {
    try {
      const r = d.transaction('kv').objectStore('kv').get(key);
      r.onsuccess = () => res(r.result as T);
      r.onerror = () => res(undefined);
    } catch {
      res(undefined);
    }
  });
}
export async function cacheSet(key: string, v: unknown): Promise<void> {
  mem.set(key, v);
  const d = await db();
  if (!d) return;
  try {
    d.transaction('kv', 'readwrite').objectStore('kv').put(v, key);
  } catch {
    /* quota or private mode: memory cache only */
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...kids: (Node | string | null | undefined)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, String(v));
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}
