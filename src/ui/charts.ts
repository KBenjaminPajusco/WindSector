// Minimal SVG charts (no dependency).
import { speedColor } from '../util';

const NS = 'http://www.w3.org/2000/svg';
const s = (tag: string, a: Record<string, string | number>, text?: string) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(a)) e.setAttribute(k, String(v));
  if (text) e.textContent = text;
  return e;
};

export interface Pt { t: number; v: number | null; g?: number | null; d?: number | null }

/** Speed (line) + gust (dots) + direction arrows over time. Optional forecast series (dashed). */
export function windChart(obs: Pt[], fc: Pt[] = [], opts: { width?: number; height?: number; now?: number } = {}) {
  const W = opts.width ?? 300, H = opts.height ?? 140, L = 26, R = 6, T = 8, B = 30;
  const all = [...obs, ...fc].filter((p) => p.v != null);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img' });
  if (!all.length) {
    svg.append(s('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'muted' }, 'Pas de données'));
    return svg;
  }
  const t0 = Math.min(...all.map((p) => p.t)), t1 = Math.max(...all.map((p) => p.t));
  const vmax = Math.max(10, ...all.map((p) => Math.max(p.v ?? 0, p.g ?? 0))) * 1.1;
  const x = (t: number) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R);
  const y = (v: number) => T + (1 - v / vmax) * (H - T - B);
  for (let v = 0; v <= vmax; v += vmax > 40 ? 10 : 5) {
    svg.append(s('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid' }));
    svg.append(s('text', { x: L - 4, y: y(v) + 3, 'text-anchor': 'end', class: 'axis' }, String(v)));
  }
  // Day / hour ticks.
  const hourMs = 3600e3;
  const span = t1 - t0;
  const stepH = span > 72 * hourMs ? 24 : span > 30 * hourMs ? 12 : 6;
  for (let t = Math.ceil(t0 / (stepH * hourMs)) * stepH * hourMs; t <= t1; t += stepH * hourMs) {
    const d = new Date(t);
    const lab = d.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', ...(stepH >= 12 ? { weekday: 'short' } : {}) });
    svg.append(s('line', { x1: x(t), x2: x(t), y1: T, y2: H - B, class: 'grid' }));
    svg.append(s('text', { x: x(t), y: H - B + 11, 'text-anchor': 'middle', class: 'axis' }, lab));
  }
  if (opts.now && opts.now >= t0 && opts.now <= t1)
    svg.append(s('line', { x1: x(opts.now), x2: x(opts.now), y1: T, y2: H - B, class: 'now' }));
  const path = (pts: Pt[], key: 'v' | 'g') => {
    let d = '', pen = false;
    for (const p of pts) {
      const v = p[key];
      if (v == null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };
  if (fc.length) {
    svg.append(s('path', { d: path(fc, 'g'), class: 'fc-gust' }));
    svg.append(s('path', { d: path(fc, 'v'), class: 'fc-line' }));
  }
  svg.append(s('path', { d: path(obs, 'g'), class: 'obs-gust' }));
  svg.append(s('path', { d: path(obs, 'v'), class: 'obs-line' }));
  // Direction arrows along the bottom.
  const series = obs.length ? obs : fc;
  const every = Math.max(1, Math.ceil(series.length / 18));
  series.forEach((p, i) => {
    if (i % every || p.d == null) return;
    const g = s('g', { transform: `translate(${x(p.t)},${H - 9}) rotate(${p.d + 180})` });
    g.append(s('path', { d: 'M0,-6 L4,2 L0,0 L-4,2 Z', fill: speedColor(p.v ?? 0), stroke: '#222', 'stroke-width': 0.6 }));
    svg.append(g);
  });
  return svg;
}

/** Horizontal stacked bar of probabilities. */
export function probBar(items: { label: string; value: number; color: string }[]) {
  const wrap = document.createElement('div');
  wrap.className = 'probbar';
  for (const it of items) {
    if (it.value <= 0) continue;
    const seg = document.createElement('div');
    seg.style.flex = String(it.value);
    seg.style.background = it.color;
    seg.title = `${it.label} ${(it.value * 100).toFixed(0)} %`;
    seg.textContent = it.value > 0.12 ? `${it.label} ${(it.value * 100).toFixed(0)}%` : '';
    wrap.append(seg);
  }
  return wrap;
}

/** Histogram of values with a vertical zero line; negative = left, positive = right. */
export function histogram(values: number[], opts: { bin: number; unit: string; title: string; width?: number }) {
  const W = opts.width ?? 300, H = 110, L = 8, R = 8, T = 18, B = 20;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart' });
  svg.append(s('text', { x: L, y: 11, class: 'axis strong' }, opts.title));
  if (!values.length) return svg;
  const lim = Math.max(opts.bin * 3, ...values.map((v) => Math.abs(v)));
  const nb = Math.ceil(lim / opts.bin);
  const counts = new Map<number, number>();
  for (const v of values) {
    const b = Math.max(-nb, Math.min(nb - 1, Math.floor(v / opts.bin)));
    counts.set(b, (counts.get(b) || 0) + 1);
  }
  const cmax = Math.max(...counts.values());
  const x = (v: number) => L + ((v + nb * opts.bin) / (2 * nb * opts.bin)) * (W - L - R);
  for (let b = -nb; b < nb; b++) {
    const c = counts.get(b) || 0;
    if (!c) continue;
    const h = (c / cmax) * (H - T - B);
    svg.append(s('rect', {
      x: x(b * opts.bin) + 0.5, y: H - B - h, width: Math.max(1, x((b + 1) * opts.bin) - x(b * opts.bin) - 1), height: h,
      fill: b < 0 ? '#3b6fd8' : '#e0452b', opacity: 0.8,
    }));
  }
  svg.append(s('line', { x1: x(0), x2: x(0), y1: T, y2: H - B, class: 'now' }));
  svg.append(s('text', { x: L, y: H - 5, class: 'axis' }, `◀ gauche  −${(nb * opts.bin).toFixed(0)}${opts.unit}`));
  svg.append(s('text', { x: W - R, y: H - 5, 'text-anchor': 'end', class: 'axis' }, `+${(nb * opts.bin).toFixed(0)}${opts.unit}  droite ▶`));
  return svg;
}
