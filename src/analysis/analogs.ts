// Analog ("vent similaire déjà vécu") search and left/right scenario statistics on a water zone.
//
// 1. Signature of the forecast on the zone for the chosen window (zone-mean direction & speed, hour by hour).
// 2. Search the fine-mesh historical archive (AROME runs) for windows with the same direction, strength,
//    time of day and season. One analog per day max (avoid autocorrelation).
// 3. For each analog, measure on the 3×3 zone grid:
//      - pressure gradient across the course (right − left, looking upwind),
//      - persistent shift over the window (veer = right, back = left),
//      - oscillation amplitude.
// 4. Aggregate into scenario probabilities + mean spatial anomaly map.
import { Grid, WindSeries } from '../forecast';
import { angDiff, circMean, circStd, deg2rad, mean, quantile } from '../util';

export interface AnalogOptions {
  windowH: number; // race window length (h)
  dirTol: number; // deg
  spdTolRel: number; // fraction
  hourTol: number; // h
  seasonDays: number; // ± days of year (0 = all year)
  maxAnalogs: number;
}

export const DEFAULT_OPTIONS: AnalogOptions = {
  windowH: 3,
  dirTol: 20,
  spdTolRel: 0.3,
  hourTol: 2,
  seasonDays: 60,
  maxAnalogs: 40,
};

export type Side = 'droite' | 'gauche' | 'neutre';
export type Cause = 'bascule' | 'pression' | 'oscillant';

export interface AnalogCase {
  start: number; // epoch ms
  distance: number;
  dir: number;
  speed: number;
  shift: number; // deg, + = veer (right)
  pressure: number; // kt, + = more wind on the right
  dirSpread: number; // deg (right − left direction difference)
  oscillation: number; // deg std
  side: Side;
  cause: Cause;
  score: number;
  pointSpeed: number[]; // mean speed per grid point
  pointDir: number[];
}

export interface Signature {
  start: number;
  dir: number[];
  speed: number[];
  meanDir: number;
  meanSpeed: number;
  shift: number;
  pressure: number;
}

export interface AnalogResult {
  signature: Signature;
  cases: AnalogCase[];
  candidates: number;
  probs: Record<Side, number>;
  causes: Record<`${Side}-${Cause}`, number>;
  meanShift: number;
  meanPressure: number;
  shiftQ: [number, number, number];
  pressureQ: [number, number, number];
  speedQ: [number, number, number];
  anomaly: number[]; // per grid point, % vs zone mean
  meanPointDir: number[];
  rightBearing: number; // compass bearing of the "right" side looking upwind
}

const fmtHour = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: 'numeric', hourCycle: 'h23' });
const localHour = (ms: number) => +fmtHour.format(ms);
const dayOfYear = (ms: number) => {
  const d = new Date(ms);
  return Math.floor((ms - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400e3);
};

/** Zone-mean vector wind per hour. */
function zoneMean(s: WindSeries, ti: number): { dir: number; speed: number } | null {
  let u = 0, v = 0, sp = 0, n = 0;
  for (let p = 0; p < s.speed.length; p++) {
    const S = s.speed[p][ti], D = s.dir[p][ti];
    if (S == null || D == null) continue;
    u += S * Math.sin(deg2rad(D));
    v += S * Math.cos(deg2rad(D));
    sp += S;
    n++;
  }
  if (n < Math.ceil(s.speed.length / 2)) return null;
  return { dir: ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360, speed: sp / n };
}

/** Lateral coordinate (km) of each grid point relative to the zone centre, + = right looking upwind. */
function lateral(grid: Grid, windFrom: number): number[] {
  const c = Math.floor(grid.lats.length / 2);
  const lat0 = grid.lats[c], lon0 = grid.lons[c];
  const rb = deg2rad(windFrom + 90); // right-hand bearing when facing the wind
  return grid.lats.map((la, i) => {
    const dx = (grid.lons[i] - lon0) * 111.32 * Math.cos(deg2rad(lat0));
    const dy = (la - lat0) * 110.57;
    return dx * Math.sin(rb) + dy * Math.cos(rb);
  });
}

/** Window metrics on a series starting at time index ti. */
function windowMetrics(s: WindSeries, grid: Grid, ti: number, W: number) {
  const dirs: number[] = [], spds: number[] = [];
  for (let k = 0; k < W; k++) {
    const m = zoneMean(s, ti + k);
    if (!m) return null;
    dirs.push(m.dir);
    spds.push(m.speed);
  }
  const axis = circMean(dirs, spds);
  const x = lateral(grid, axis);
  const P = grid.lats.length;
  const pointSpeed: number[] = [], pointDir: number[] = [];
  for (let p = 0; p < P; p++) {
    const sp: number[] = [], dd: number[] = [];
    for (let k = 0; k < W; k++) {
      const S = s.speed[p][ti + k], D = s.dir[p][ti + k];
      if (S != null) sp.push(S);
      if (D != null) dd.push(D);
    }
    pointSpeed.push(sp.length ? mean(sp) : NaN);
    pointDir.push(dd.length ? circMean(dd) : NaN);
  }
  // Least-squares slope of speed vs lateral position -> difference across the zone width.
  const width = Math.max(...x) - Math.min(...x) || 1;
  const reg = (vals: number[]) => {
    const ok = vals.map((v, i) => [x[i], v] as const).filter(([, v]) => Number.isFinite(v));
    const mx = mean(ok.map((o) => o[0])), my = mean(ok.map((o) => o[1]));
    let num = 0, den = 0;
    for (const [a, b] of ok) { num += (a - mx) * (b - my); den += (a - mx) ** 2; }
    return den ? (num / den) * width : 0;
  };
  const pressure = reg(pointSpeed);
  const dirSpread = reg(pointDir.map((d) => angDiff(axis, d)));
  // Persistent shift: mean of last third vs first third (robust to single-hour noise).
  const third = Math.max(1, Math.round(W / 3));
  const shift = W > 1 ? angDiff(circMean(dirs.slice(0, third)), circMean(dirs.slice(-third))) : 0;
  return { dirs, spds, axis, speed: mean(spds), pressure, dirSpread, shift, oscillation: circStd(dirs), pointSpeed, pointDir };
}

function classify(shift: number, pressure: number, speed: number): { side: Side; cause: Cause; score: number } {
  const relP = pressure / Math.max(speed, 4);
  const sShift = Math.sign(shift) * Math.min(Math.abs(shift) / 10, 1.5);
  const sPress = Math.sign(pressure) * Math.min(Math.abs(relP) / 0.08, 1.5);
  const score = sShift + sPress;
  if (Math.abs(score) < 0.6) return { side: 'neutre', cause: 'oscillant', score };
  const side: Side = score > 0 ? 'droite' : 'gauche';
  const cause: Cause = Math.abs(sShift) >= Math.abs(sPress) ? 'bascule' : 'pression';
  return { side, cause, score };
}

export function signatureAt(fc: WindSeries, grid: Grid, ti: number, W: number): Signature | null {
  const m = windowMetrics(fc, grid, ti, W);
  if (!m) return null;
  return {
    start: fc.times[ti],
    dir: m.dirs,
    speed: m.spds,
    meanDir: m.axis,
    meanSpeed: m.speed,
    shift: m.shift,
    pressure: m.pressure,
  };
}

export function findAnalogs(sig: Signature, hist: WindSeries, grid: Grid, o: AnalogOptions): AnalogResult {
  const W = sig.dir.length;
  const targetHour = localHour(sig.start);
  const targetDoy = dayOfYear(sig.start);
  // Pre-compute zone means once.
  const zm = hist.times.map((_, i) => zoneMean(hist, i));
  const best = new Map<string, { ti: number; d: number }>();
  let candidates = 0;
  for (let ti = 0; ti + W <= hist.times.length; ti++) {
    const t = hist.times[ti];
    if (t >= sig.start - 86400e3) break; // never use the future / the target day itself
    const hd = Math.abs(localHour(t) - targetHour);
    if (Math.min(hd, 24 - hd) > o.hourTol) continue;
    if (o.seasonDays > 0) {
      const dd = Math.abs(dayOfYear(t) - targetDoy);
      if (Math.min(dd, 365 - dd) > o.seasonDays) continue;
    }
    let d = 0, ok = true;
    for (let k = 0; k < W; k++) {
      const m = zm[ti + k];
      if (!m) { ok = false; break; }
      const da = angDiff(sig.dir[k], m.dir);
      const tolS = Math.max(o.spdTolRel * sig.speed[k], 2.5);
      const ds = m.speed - sig.speed[k];
      // Light winds: direction is less meaningful.
      const dirW = sig.speed[k] < 5 ? 0.4 : 1;
      if (Math.abs(da) > o.dirTol * (sig.speed[k] < 5 ? 3 : 1.5) || Math.abs(ds) > tolS * 1.5) { ok = false; break; }
      d += dirW * (da / o.dirTol) ** 2 + (ds / tolS) ** 2;
    }
    if (!ok) continue;
    d = Math.sqrt(d / W);
    if (d > 1.2) continue;
    candidates++;
    const day = new Date(t).toISOString().slice(0, 10);
    const prev = best.get(day);
    if (!prev || d < prev.d) best.set(day, { ti, d });
  }
  const picked = [...best.values()].sort((a, b) => a.d - b.d).slice(0, o.maxAnalogs);
  const cases: AnalogCase[] = [];
  for (const { ti, d } of picked) {
    const m = windowMetrics(hist, grid, ti, W);
    if (!m) continue;
    const c = classify(m.shift, m.pressure, m.speed);
    cases.push({
      start: hist.times[ti], distance: d, dir: m.axis, speed: m.speed, shift: m.shift, pressure: m.pressure,
      dirSpread: m.dirSpread, oscillation: m.oscillation, ...c, pointSpeed: m.pointSpeed, pointDir: m.pointDir,
    });
  }
  const n = cases.length || 1;
  const probs = { droite: 0, gauche: 0, neutre: 0 } as Record<Side, number>;
  const causes = {} as Record<`${Side}-${Cause}`, number>;
  for (const c of cases) {
    probs[c.side] += 1 / n;
    const k = `${c.side}-${c.cause}` as const;
    causes[k] = (causes[k] || 0) + 1 / n;
  }
  const P = grid.lats.length;
  const anomaly: number[] = [], meanPointDir: number[] = [];
  for (let p = 0; p < P; p++) {
    anomaly.push(mean(cases.map((c) => c.pointSpeed[p] / mean(c.pointSpeed.filter(Number.isFinite)) - 1)) * 100);
    meanPointDir.push(circMean(cases.map((c) => c.pointDir[p]).filter(Number.isFinite)));
  }
  const q = (a: number[]) => [quantile(a, 0.1), quantile(a, 0.5), quantile(a, 0.9)] as [number, number, number];
  return {
    signature: sig,
    cases,
    candidates,
    probs,
    causes,
    meanShift: mean(cases.map((c) => c.shift)),
    meanPressure: mean(cases.map((c) => c.pressure)),
    shiftQ: q(cases.map((c) => c.shift)),
    pressureQ: q(cases.map((c) => c.pressure)),
    speedQ: q(cases.map((c) => c.speed)),
    anomaly,
    meanPointDir,
    rightBearing: (sig.meanDir + 90) % 360,
  };
}
