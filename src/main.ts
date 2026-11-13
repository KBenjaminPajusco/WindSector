import './style.css';
import * as maplibregl from 'maplibre-gl';
import { FIELD_BBOX, MODELS, ZONES, Zone } from './config';
import { fetchForecast, fetchHistory, Grid, regionalGrid, sampleField, WindSeries, zoneGrid } from './forecast';
import { WindMap } from './map';
import { loadMeteoFrance, loadMetar, loadOpenWindMap, loadMFHistory, SOURCE_LABEL, Station } from './sources/stations';
import { AnalogOptions, AnalogResult, DEFAULT_OPTIONS, findAnalogs, signatureAt } from './analysis/analogs';
import { histogram, probBar, Pt, windChart } from './ui/charts';
import { compass, el, fmt, fmtTime, speedColor, windName } from './util';

// ---------------------------------------------------------------- state
const state = {
  model: MODELS[0].id,
  grid: regionalGrid(),
  fc: null as WindSeries | null,
  ti: 0,
  stations: [] as Station[],
  zone: ZONES[0] as Zone,
  zoneGrid: zoneGrid(ZONES[0]),
  zoneFc: null as WindSeries | null,
  hist: new Map<string, WindSeries>(),
  result: null as AnalogResult | null,
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const wm = new WindMap($('map'));

function toast(msg: string, ms = 4000) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout((t as any)._h);
  (t as any)._h = setTimeout(() => (t.hidden = true), ms);
}

// ---------------------------------------------------------------- header controls
const modelSel = $<HTMLSelectElement>('model');
for (const m of MODELS) modelSel.append(el('option', { value: m.id }, `${m.name} (${m.res})`));
modelSel.onchange = () => {
  state.model = modelSel.value;
  loadForecast();
};
$('v2d').onclick = () => { wm.set3D(false); $('v2d').classList.add('on'); $('v3d').classList.remove('on'); };
$('v3d').onclick = () => { wm.set3D(true); $('v3d').classList.add('on'); $('v2d').classList.remove('on'); };
$('toggle-left').onclick = () => { document.body.classList.toggle('show-left'); document.body.classList.remove('show-right'); };
$('toggle-right').onclick = () => { document.body.classList.toggle('show-right'); document.body.classList.remove('show-left'); };

const LAYERS: Record<string, string[]> = {
  stations: ['stations-dot', 'stations-arrow'],
  field: ['field'],
  arrows: ['fc-arrows'],
  hillshade: ['hillshade'],
};
document.querySelectorAll<HTMLInputElement>('[data-layer]').forEach((cb) => {
  cb.onchange = () => wm.setLayerVisible(LAYERS[cb.dataset.layer!], cb.checked);
});

// Legend.
{
  const lg = $('legend');
  lg.append(el('span', { class: 'small' }, 'kt'));
  for (const k of [0, 5, 10, 15, 20, 25, 30, 40]) {
    lg.append(el('span', { class: 'sw', style: `background:${speedColor(k)}` }, String(k)));
  }
  lg.append(
    el('span', { class: 'src mf' }, 'Météo-France'),
    el('span', { class: 'src owm' }, 'OpenWindMap'),
    el('span', { class: 'src metar' }, 'METAR'),
  );
}

// ---------------------------------------------------------------- stations
async function loadStations() {
  const status: string[] = [];
  const [mf, owm, metar] = await Promise.allSettled([loadMeteoFrance(), loadOpenWindMap(), loadMetar()]);
  const list: Station[] = [];
  if (mf.status === 'fulfilled') {
    list.push(...mf.value.stations);
    status.push(`Météo-France : ${mf.value.stations.length} (maj ${fmtTime(new Date(mf.value.generated))})`);
  } else status.push('Météo-France : indisponible');
  if (owm.status === 'fulfilled') { list.push(...owm.value); status.push(`OpenWindMap : ${owm.value.length} balises`); }
  else status.push('OpenWindMap : indisponible');
  if (metar.status === 'fulfilled') { list.push(...metar.value); status.push(`METAR : ${metar.value.length}`); }
  else status.push('METAR : indisponible');
  state.stations = list;
  $('sources-status').innerHTML = status.join('<br>');
  await wm.whenReady();
  wm.setStations(list);
  renderStationList();
  if (!refSel.value) fillRefStations();
}

function renderStationList() {
  const box = $('station-list');
  box.replaceChildren();
  const groups = new Map<string, Station[]>();
  for (const s of state.stations) {
    const g = groups.get(s.source) || [];
    g.push(s);
    groups.set(s.source, g);
  }
  for (const [src, list] of groups) {
    box.append(el('h3', {}, SOURCE_LABEL[src as Station['source']]));
    list.sort((a, b) => (b.last?.speed ?? -1) - (a.last?.speed ?? -1));
    for (const s of list) {
      const l = s.last;
      const age = l ? (Date.now() - l.t.getTime()) / 3600e3 : Infinity;
      const row = el(
        'button',
        { class: `st-row${age > (s.source === 'meteofrance' ? 30 : 3) ? ' stale' : ''}`, type: 'button', title: l ? fmtTime(l.t) : '' },
        el('span', { class: 'dot', style: `background:${speedColor(l?.speed ?? 0)}` }),
        el('span', { class: 'nm' }, s.name),
        el('span', { class: 'val' }, l?.speed != null ? `${fmt(l.speed)}${l.gust != null ? `/${fmt(l.gust)}` : ''} kt ${l.dir != null ? compass(l.dir) : ''}` : '–'),
      );
      row.onclick = () => {
        wm.map.flyTo({ center: [s.lon, s.lat], zoom: Math.max(wm.map.getZoom(), 11.5) });
        openStation(s);
        document.body.classList.remove('show-left');
      };
      box.append(row);
    }
  }
}

/** Forecast series at any point from the regional field (bilinear). */
function forecastAt(lon: number, lat: number): Pt[] {
  const fc = state.fc, g = state.grid;
  if (!fc) return [];
  const fx = (lon - FIELD_BBOX.west) / FIELD_BBOX.step, fy = (lat - FIELD_BBOX.south) / FIELD_BBOX.step;
  if (fx < 0 || fy < 0 || fx > g.nx! - 1 || fy > g.ny! - 1) return [];
  return fc.times.map((t, k) => {
    const sp = fc.speed.map((s) => s[k]);
    const gu = fc.gust.map((s) => s[k]);
    // Direction via u/v interpolation.
    const u = fc.speed.map((s, p) => (s[k] == null || fc.dir[p][k] == null ? null : s[k]! * Math.sin((fc.dir[p][k]! * Math.PI) / 180)));
    const v = fc.speed.map((s, p) => (s[k] == null || fc.dir[p][k] == null ? null : s[k]! * Math.cos((fc.dir[p][k]! * Math.PI) / 180)));
    const U = sampleField(u, g.nx!, g.ny!, fx, fy), V = sampleField(v, g.nx!, g.ny!, fx, fy);
    return {
      t,
      v: sampleField(sp, g.nx!, g.ny!, fx, fy),
      g: sampleField(gu, g.nx!, g.ny!, fx, fy),
      d: U == null || V == null ? null : ((Math.atan2(U, V) * 180) / Math.PI + 360) % 360,
    };
  });
}

let popup: maplibregl.Popup | null = null;
async function openStation(s: Station) {
  const body = el('div', { class: 'pop' },
    el('div', { class: 'pop-h' }, el('strong', {}, s.name), el('span', { class: `badge ${s.source}` }, SOURCE_LABEL[s.source])),
    el('div', { class: 'small muted' }, s.last ? `${fmtTime(s.last.t)} — ${fmt(s.last.speed)} kt, rafales ${fmt(s.last.gust)} kt, ${s.last.dir != null ? `${fmt(s.last.dir)}° ${compass(s.last.dir)}` : ''}${s.alt != null ? ` · alt. ${s.alt} m` : ''}` : 'pas de mesure récente'),
    el('div', { class: 'small muted' }, 'Chargement de l’historique…'),
  );
  popup?.remove();
  popup = new maplibregl.Popup({ maxWidth: '360px' }).setLngLat([s.lon, s.lat]).setDOMContent(body).addTo(wm.map);
  try {
    const h = await s.history();
    const obs: Pt[] = h.map((o) => ({ t: o.t.getTime(), v: o.speed, g: o.gust, d: o.dir }));
    const fc = forecastAt(s.lon, s.lat).filter((p) => !obs.length || p.t >= obs[0].t);
    body.lastChild!.replaceWith(
      windChart(obs, fc, { width: 330, height: 150, now: Date.now() }),
      el('div', { class: 'small muted' }, 'Trait plein : mesures (pointillés clairs : rafales) · tirets : prévision ' + (MODELS.find((m) => m.id === state.model)?.name ?? '')),
    );
  } catch (e) {
    (body.lastChild as HTMLElement).textContent = `Historique indisponible (${(e as Error).message})`;
  }
}
wm.onStationClick = openStation;
wm.onMapClick = (ll) => {
  const fc = forecastAt(ll.lng, ll.lat);
  if (!fc.length) return;
  const cur = fc[state.ti];
  const body = el('div', { class: 'pop' },
    el('div', { class: 'pop-h' }, el('strong', {}, `Prévision ${MODELS.find((m) => m.id === state.model)?.name}`)),
    el('div', { class: 'small muted' }, `${ll.lat.toFixed(3)}°N ${ll.lng.toFixed(3)}°E — ${cur ? `${fmt(cur.v)} kt ${cur.d != null ? compass(cur.d) : ''}, raf. ${fmt(cur.g)} kt` : ''}`),
    windChart([], fc, { width: 330, height: 150, now: state.fc?.times[state.ti] }),
  );
  popup?.remove();
  popup = new maplibregl.Popup({ maxWidth: '360px' }).setLngLat(ll).setDOMContent(body).addTo(wm.map);
};

// ---------------------------------------------------------------- forecast + timebar
const slider = $<HTMLInputElement>('time');
async function loadForecast() {
  const model = MODELS.find((m) => m.id === state.model)!;
  $('time-label').textContent = `Chargement ${model.name}…`;
  try {
    state.fc = await fetchForecast(state.grid, model.id, model.days);
  } catch (e) {
    toast(`Prévision ${model.name} indisponible : ${(e as Error).message}`, 8000);
    state.fc = null;
  }
  const fc = state.fc;
  if (fc) {
    // Drop trailing hours where the model has no data.
    let last = fc.times.length - 1;
    const mid = Math.floor(fc.speed.length / 2);
    while (last > 0 && fc.speed[mid][last] == null) last--;
    slider.max = String(last);
    const now = Date.now();
    const idx = fc.times.findIndex((t) => t > now - 1800e3);
    state.ti = idx < 0 ? 0 : Math.min(idx, last);
    slider.value = String(state.ti);
  }
  await wm.whenReady();
  await loadZoneForecast();
  updateTime();
}

function updateTime() {
  const fc = state.fc;
  $('time-label').textContent = fc ? fmtTime(new Date(fc.times[state.ti])) : '–';
  wm.setField(fc, state.grid, state.ti);
  renderZoneNow();
  if (state.result && state.result.signature.start !== fc?.times[state.ti]) {
    $('analysis').classList.add('stale');
  } else $('analysis').classList.remove('stale');
}
slider.oninput = () => {
  state.ti = +slider.value;
  updateTime();
};
wm.map.on('idle', () => {
  // Water polygons may arrive after the first draw.
  if (state.fc && !(wm as any)._drewOnce) {
    (wm as any)._drewOnce = true;
    wm.setField(state.fc, state.grid, state.ti);
  }
});
$('now').onclick = () => {
  if (!state.fc) return;
  const idx = state.fc.times.findIndex((t) => t > Date.now() - 1800e3);
  state.ti = Math.max(0, idx);
  slider.value = String(state.ti);
  updateTime();
};
let playing: number | undefined;
$('play').onclick = () => {
  if (playing) {
    clearInterval(playing);
    playing = undefined;
    $('play').textContent = '▶';
    return;
  }
  $('play').textContent = '❚❚';
  playing = window.setInterval(() => {
    state.ti = state.ti >= +slider.max ? 0 : state.ti + 1;
    slider.value = String(state.ti);
    updateTime();
  }, 900);
};

// ---------------------------------------------------------------- zone
const zoneSel = $<HTMLSelectElement>('zone');
for (const z of ZONES) zoneSel.append(el('option', { value: z.id }, z.name));
zoneSel.onchange = async () => {
  state.zone = ZONES.find((z) => z.id === zoneSel.value)!;
  state.zoneGrid = zoneGrid(state.zone);
  state.result = null;
  $('analysis').replaceChildren();
  wm.flyToZone(state.zone.lon, state.zone.lat);
  fillRefStations();
  await loadZoneForecast();
  renderZoneNow();
};

async function loadZoneForecast() {
  $('zone-note').textContent = state.zone.note;
  const model = MODELS.find((m) => m.id === state.model)!;
  try {
    const zf = await fetchForecast(state.zoneGrid, model.id, model.days);
    // Align on the regional time axis.
    if (state.fc && zf.times[0] !== state.fc.times[0]) {
      const off = zf.times.indexOf(state.fc.times[0]);
      if (off > 0) {
        zf.times = zf.times.slice(off);
        for (const k of ['speed', 'dir', 'gust'] as const) zf[k] = zf[k].map((a) => a.slice(off));
      }
    }
    state.zoneFc = zf;
  } catch (e) {
    state.zoneFc = null;
    toast(`Prévision zone indisponible : ${(e as Error).message}`);
  }
}

function renderZoneNow() {
  const box = $('zone-now');
  wm.setZone(state.zoneGrid, state.zoneFc, state.ti, state.result);
  const zf = state.zoneFc;
  if (!zf) return box.replaceChildren();
  const W = +$<HTMLInputElement>('o-window').value || 3;
  const sig = signatureAt(zf, state.zoneGrid, state.ti, Math.min(W, zf.times.length - state.ti));
  if (!sig) return box.replaceChildren(el('p', { class: 'muted small' }, 'Pas de prévision sur cette fenêtre.'));
  const c = Math.floor(state.zoneGrid.lats.length / 2);
  const pts: Pt[] = zf.times.map((t, k) => ({ t, v: zf.speed[c][k], g: zf.gust[c][k], d: zf.dir[c][k] }));
  box.replaceChildren(
    el('div', { class: 'kpis' },
      kpi('Prévu', `${fmt(sig.meanSpeed)} kt`, `${compass(sig.meanDir)} ${fmt(sig.meanDir)}° · ${windName(sig.meanDir, sig.meanSpeed)}`),
      kpi('Bascule prévue', `${sig.shift > 0 ? '+' : ''}${fmt(sig.shift)}°`, sig.shift > 3 ? 'à droite (adonne)' : sig.shift < -3 ? 'à gauche' : 'stable'),
      kpi('Écart de pression', `${sig.pressure > 0 ? '+' : ''}${fmt(sig.pressure, 1)} kt`, sig.pressure > 0.5 ? 'plus à droite' : sig.pressure < -0.5 ? 'plus à gauche' : 'homogène'),
    ),
    windChart([], pts, { width: 320, height: 130, now: zf.times[state.ti] }),
  );
}

const kpi = (label: string, value: string, sub: string) =>
  el('div', { class: 'kpi' }, el('div', { class: 'k-l' }, label), el('div', { class: 'k-v' }, value), el('div', { class: 'k-s' }, sub));

// ---------------------------------------------------------------- analysis
function readOptions(): AnalogOptions {
  const n = (id: string, d: number) => {
    const v = +$<HTMLInputElement>(id).value;
    return Number.isFinite(v) ? v : d;
  };
  return {
    windowH: n('o-window', DEFAULT_OPTIONS.windowH),
    dirTol: n('o-dir', DEFAULT_OPTIONS.dirTol),
    spdTolRel: n('o-spd', 30) / 100,
    hourTol: n('o-hour', DEFAULT_OPTIONS.hourTol),
    seasonDays: n('o-season', DEFAULT_OPTIONS.seasonDays),
    maxAnalogs: n('o-max', DEFAULT_OPTIONS.maxAnalogs),
  };
}

$('analyse').onclick = runAnalysis;
async function runAnalysis() {
  const out = $('analysis');
  const zf = state.zoneFc;
  if (!zf) return toast('Pas de prévision pour la zone.');
  const o = readOptions();
  const W = Math.min(o.windowH, zf.times.length - state.ti);
  const sig = signatureAt(zf, state.zoneGrid, state.ti, W);
  if (!sig) return toast('Prévision incomplète pour cette fenêtre.');
  const btn = $<HTMLButtonElement>('analyse');
  btn.disabled = true;
  const prog = el('p', { class: 'muted small' }, 'Chargement de l’archive AROME maille fine…');
  out.replaceChildren(prog);
  try {
    let hist = state.hist.get(state.zone.id);
    if (!hist) {
      hist = await fetchHistory(state.zoneGrid, state.zone.id, (m) => (prog.textContent = m));
      state.hist.set(state.zone.id, hist);
    }
    prog.textContent = 'Recherche des analogues…';
    await new Promise((r) => setTimeout(r, 10));
    const res = findAnalogs(sig, hist, state.zoneGrid, o);
    state.result = res;
    await renderAnalysis(res, hist);
    wm.setZone(state.zoneGrid, state.zoneFc, state.ti, res);
    out.classList.remove('stale');
  } catch (e) {
    out.replaceChildren(el('p', { class: 'error' }, `Analyse impossible : ${(e as Error).message}. L’API Open-Meteo limite le nombre de requêtes ; réessayer dans une minute.`));
  } finally {
    btn.disabled = false;
  }
}

/** Météo-France station used for the "vécu" columns: user choice, else nearest low-altitude coastal one. */
const refSel = $<HTMLSelectElement>('ref-station');
function fillRefStations() {
  const z = state.zone;
  const mf = state.stations.filter((s) => s.source === 'meteofrance');
  const dist = (s: Station) => Math.hypot((s.lon - z.lon) * Math.cos((z.lat * Math.PI) / 180), s.lat - z.lat) * 111;
  // Penalise altitude: a station at 200 m "counts" as 20 km further away.
  const score = (s: Station) => dist(s) + (s.alt ?? 0) / 10;
  mf.sort((a, b) => score(a) - score(b));
  refSel.replaceChildren(...mf.map((s) => el('option', { value: s.id }, `${s.name} (${s.alt} m, ${dist(s).toFixed(0)} km)`)));
}
function refStation(): Station | undefined {
  return state.stations.find((s) => s.source === 'meteofrance' && s.id === refSel.value);
}

async function renderAnalysis(r: AnalogResult, hist: WindSeries) {
  const out = $('analysis');
  const n = r.cases.length;
  const sig = r.signature;
  if (!n) {
    out.replaceChildren(el('p', {}, `Aucun analogue trouvé (${hist.times.length} h d’archive). Élargir les tolérances ou la saison.`));
    return;
  }
  const right = compass(r.rightBearing), left = compass((r.rightBearing + 180) % 360);
  const best = (['droite', 'gauche', 'neutre'] as const).reduce((a, b) => (r.probs[a] >= r.probs[b] ? a : b));
  const causePct = (k: string) => `${Math.round(((r.causes as any)[k] || 0) * 100)} %`;
  const st = refStation();
  let vecu: HTMLElement | null = null;
  const rows: HTMLElement[] = [];
  let mfh: Awaited<ReturnType<typeof loadMFHistory>> | null = null;
  if (st) {
    try { mfh = await loadMFHistory(st.id); } catch { mfh = null; }
  }
  const ratios: number[] = [];
  for (const c of r.cases.slice(0, 60)) {
    let obs = '–';
    if (mfh) {
      const h = Math.floor(c.start / 3600e3) - mfh.t0;
      const vals: number[] = [], dirs: number[] = [];
      for (let k = 0; k < sig.dir.length; k++) {
        const v = mfh.ff[h + k], d = mfh.dd[h + k];
        if (v != null) vals.push(v);
        if (d != null) dirs.push(d);
      }
      if (vals.length) {
        const m = vals.reduce((a, b) => a + b, 0) / vals.length;
        ratios.push(m / c.speed);
        obs = `${fmt(m)} kt${dirs.length ? ' ' + compass(dirs[0]) : ''}`;
      }
    }
    const tr = el('tr', { class: c.side },
      el('td', {}, new Date(c.start).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit' }) + 'h'),
      el('td', {}, `${compass(c.dir)} ${fmt(c.speed)}`),
      el('td', {}, `${c.shift > 0 ? '+' : ''}${fmt(c.shift)}°`),
      el('td', {}, `${c.pressure > 0 ? '+' : ''}${fmt(c.pressure, 1)}`),
      el('td', {}, c.side === 'neutre' ? 'neutre' : `${c.side} (${c.cause})`),
      el('td', {}, obs),
    );
    rows.push(tr);
  }
  if (st && ratios.length) {
    const med = [...ratios].sort((a, b) => a - b)[Math.floor(ratios.length / 2)];
    vecu = el('p', { class: 'small' },
      el('strong', {}, 'Vécu mesuré : '),
      `sur ces situations, ${st.name} (Météo-France, ${st.alt} m) a mesuré en médiane ${fmt(med * 100)} % du vent modèle sur le plan d’eau → pour la prévision actuelle ≈ ${fmt(sig.meanSpeed * med)} kt à la station.`,
    );
  }
  const verdict =
    best === 'neutre'
      ? 'Pas de côté nettement favorisé : jouer les oscillations au centre du plan d’eau.'
      : `Côté ${best.toUpperCase()} favorisé dans ${Math.round(r.probs[best] * 100)} % des situations similaires (${best === 'droite' ? right : left} du plan d’eau).`;

  out.replaceChildren(
    el('div', { class: 'verdict ' + best }, el('div', { class: 'v-t' }, verdict),
      el('div', { class: 'small' }, `${n} analogues retenus sur ${r.candidates} heures candidates · archive ${hist.model.replace('meteofrance_', '').toUpperCase()} ${new Date(hist.times[0]).getFullYear()}–${new Date(hist.times[hist.times.length - 1]).getFullYear()}`)),
    el('p', { class: 'small muted' }, `Convention : face au vent (${compass(sig.meanDir)} ${fmt(sig.meanDir)}°), la droite est côté ${right}, la gauche côté ${left}.`),
    probBar([
      { label: 'Gauche', value: r.probs.gauche, color: '#3b6fd8' },
      { label: 'Neutre', value: r.probs.neutre, color: '#9aa3ad' },
      { label: 'Droite', value: r.probs.droite, color: '#e0452b' },
    ]),
    el('table', { class: 'scen' },
      el('tr', {}, el('th', {}, 'Scénario'), el('th', {}, 'Proba')),
      el('tr', {}, el('td', {}, 'Bascule persistante à droite'), el('td', {}, causePct('droite-bascule'))),
      el('tr', {}, el('td', {}, 'Plus de pression à droite'), el('td', {}, causePct('droite-pression'))),
      el('tr', {}, el('td', {}, 'Bascule persistante à gauche'), el('td', {}, causePct('gauche-bascule'))),
      el('tr', {}, el('td', {}, 'Plus de pression à gauche'), el('td', {}, causePct('gauche-pression'))),
      el('tr', {}, el('td', {}, 'Oscillant / homogène'), el('td', {}, causePct('neutre-oscillant'))),
    ),
    el('div', { class: 'kpis' },
      kpi('Bascule (P10/P50/P90)', `${fmt(r.shiftQ[1])}°`, `${fmt(r.shiftQ[0])}° / ${fmt(r.shiftQ[2])}°`),
      kpi('Δ pression D−G', `${fmt(r.pressureQ[1], 1)} kt`, `${fmt(r.pressureQ[0], 1)} / ${fmt(r.pressureQ[2], 1)}`),
      kpi('Force vécue', `${fmt(r.speedQ[1])} kt`, `${fmt(r.speedQ[0])} – ${fmt(r.speedQ[2])}`),
    ),
    histogram(r.cases.map((c) => c.shift), { bin: 3, unit: '°', title: `Bascule sur ${sig.dir.length} h (+ = droite)` }),
    histogram(r.cases.map((c) => c.pressure), { bin: 0.5, unit: ' kt', title: 'Écart de vent droite − gauche' }),
    el('p', { class: 'small muted' }, 'Sur la carte : cercles rouges = zones où il y a eu en moyenne plus de vent dans ces situations, bleus = moins.'),
    vecu ?? "",
    el('details', { class: 'cases' },
      el('summary', {}, `Situations similaires (${n})`),
      el('table', { class: 'cases-t' },
        el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Vent'), el('th', {}, 'Basc.'), el('th', {}, 'ΔP'), el('th', {}, 'Côté'), el('th', {}, st ? `Mesuré ${st.name}` : 'Mesuré')),
        ...rows,
      ),
    ),
  );
}

// ---------------------------------------------------------------- boot
loadStations();
loadForecast();
setInterval(loadStations, 5 * 60e3);
