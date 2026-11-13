import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, ImageSource, Map as MLMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

// MapLibre 6 loads its worker from a separate module; let Vite emit it and give its URL.
maplibregl.setWorkerUrl(workerUrl);
import { FIELD_BBOX, MARSEILLE } from './config';
import type { Grid, WindSeries } from './forecast';
import { sampleField } from './forecast';
import type { Station } from './sources/stations';
import type { AnalogResult } from './analysis/analogs';
import { deg2rad, speedColorExpr, speedRGB } from './util';

const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const STYLE = 'https://tiles.openfreemap.org/styles/liberty';

export class WindMap {
  map: MLMap;
  private ready: Promise<void>;
  private fieldCanvas = document.createElement('canvas');
  private lastField: { fc: WindSeries; grid: Grid; ti: number } | null = null;
  onStationClick?: (s: Station) => void;
  onMapClick?: (lngLat: maplibregl.LngLat) => void;
  private stationsByKey = new Map<string, Station>();

  constructor(container: HTMLElement) {
    this.map = new maplibregl.Map({
      container,
      style: STYLE,
      center: [MARSEILLE.lon, MARSEILLE.lat],
      zoom: 10.3,
      pitch: 50,
      bearing: -10,
      maxPitch: 80,
      attributionControl: { compact: true, customAttribution: 'Vent : Météo-France, OpenWindMap, IEM, Open-Meteo · Relief : Mapzen/AWS Terrain Tiles' },
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'nautical' }), 'bottom-left');
    this.ready = new Promise((res) => this.map.on('load', () => { this.init(); res(); }));
    // Start with the attribution collapsed (it would hide the time bar on small screens).
    this.map.once('idle', () => container.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
    let t: number | undefined;
    this.map.on('moveend', () => {
      clearTimeout(t);
      t = window.setTimeout(() => this.redrawField(), 250);
    });
  }

  whenReady() { return this.ready; }

  private init() {
    const m = this.map;
    m.addSource('dem', { type: 'raster-dem', tiles: [TERRAIN_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 14 });
    m.addSource('dem-hs', { type: 'raster-dem', tiles: [TERRAIN_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 14 });
    const firstSymbol = m.getStyle().layers.find((l) => l.type === 'symbol')?.id;
    m.addLayer({
      id: 'hillshade', type: 'hillshade', source: 'dem-hs',
      paint: { 'hillshade-exaggeration': 0.45, 'hillshade-shadow-color': '#3d3a33', 'hillshade-highlight-color': '#ffffff' },
    }, firstSymbol);
    m.setTerrain({ source: 'dem', exaggeration: 1.3 });
    m.setSky?.({ 'sky-color': '#9cc8f0', 'horizon-color': '#dfeaf3', 'fog-color': '#f0f4f8', 'sky-horizon-blend': 0.5 } as any);

    m.addImage('wind-arrow', arrowImage(), { sdf: true, pixelRatio: 2 });

    // Forecast field over the water (image clipped by the basemap water polygons).
    const { west, east, south, north } = FIELD_BBOX;
    m.addSource('field', {
      type: 'image',
      url: blankPNG(),
      coordinates: [[west, north], [east, north], [east, south], [west, south]],
    });
    m.addLayer({ id: 'field', type: 'raster', source: 'field', paint: { 'raster-opacity': 0.72, 'raster-resampling': 'linear', 'raster-fade-duration': 0 } }, firstSymbol);

    m.addSource('fc-arrows', { type: 'geojson', data: empty() });
    m.addLayer({
      id: 'fc-arrows', type: 'symbol', source: 'fc-arrows',
      layout: {
        'icon-image': 'wind-arrow', 'icon-rotate': ['+', ['get', 'dir'], 180], 'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true, 'icon-size': ['interpolate', ['linear'], ['get', 'speed'], 0, 0.45, 25, 0.95],
      },
      paint: { 'icon-color': '#10212f', 'icon-opacity': 0.75 },
    });

    // Zone grid (forecast + analog anomaly).
    m.addSource('zone', { type: 'geojson', data: empty() });
    m.addLayer({ id: 'zone-outline', type: 'line', source: 'zone', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'line-color': '#0b3d91', 'line-width': 2, 'line-dasharray': [2, 1.5] } });
    m.addSource('zone-pts', { type: 'geojson', data: empty() });
    m.addLayer({
      id: 'zone-anom', type: 'circle', source: 'zone-pts', filter: ['has', 'anom'],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 10, 13, 28],
        'circle-color': ['interpolate', ['linear'], ['get', 'anom'], -15, '#3b6fd8', 0, 'rgba(255,255,255,0.4)', 15, '#e0452b'],
        'circle-opacity': 0.55, 'circle-stroke-width': 1, 'circle-stroke-color': '#fff',
      },
    });
    m.addLayer({
      id: 'zone-arrows', type: 'symbol', source: 'zone-pts',
      layout: {
        'icon-image': 'wind-arrow', 'icon-rotate': ['+', ['get', 'dir'], 180], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true,
        'icon-size': 1.1, 'text-field': ['get', 'label'], 'text-size': 11, 'text-offset': [0, 1.6], 'text-allow-overlap': true,
        'text-font': ['Noto Sans Bold'],
      },
      paint: { 'icon-color': speedColorExpr('speed') as any, 'icon-halo-color': '#000', 'icon-halo-width': 1, 'text-color': '#0b1b2b', 'text-halo-color': '#fff', 'text-halo-width': 1.4 },
    });

    // Stations.
    m.addSource('stations', { type: 'geojson', data: empty() });
    m.addLayer({
      id: 'stations-dot', type: 'circle', source: 'stations',
      paint: {
        'circle-radius': 7,
        'circle-color': speedColorExpr('speed') as any,
        'circle-stroke-width': 2.5,
        'circle-stroke-color': ['match', ['get', 'source'], 'meteofrance', '#0b3d91', 'metar', '#6b2bb5', '#0f7d4a'],
        'circle-opacity': ['case', ['get', 'stale'], 0.35, 1],
      },
    });
    m.addLayer({
      id: 'stations-arrow', type: 'symbol', source: 'stations', filter: ['has', 'dir'],
      layout: {
        'icon-image': 'wind-arrow', 'icon-rotate': ['+', ['get', 'dir'], 180], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true,
        'icon-size': 1.15, 'icon-offset': [0, 0],
        'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-offset': [0, 1.5], 'text-anchor': 'top', 'text-allow-overlap': false,
      },
      paint: {
        'icon-color': '#111', 'icon-opacity': ['case', ['get', 'stale'], 0.35, 0.9],
        'text-color': '#111', 'text-halo-color': '#fff', 'text-halo-width': 1.6,
      },
    });
    m.on('click', 'stations-dot', (e) => {
      const k = e.features?.[0]?.properties?.key;
      const s = k && this.stationsByKey.get(k);
      if (s) this.onStationClick?.(s);
    });
    m.on('mouseenter', 'stations-dot', () => (m.getCanvas().style.cursor = 'pointer'));
    m.on('mouseleave', 'stations-dot', () => (m.getCanvas().style.cursor = ''));
    m.on('click', (e) => {
      if (m.queryRenderedFeatures(e.point, { layers: ['stations-dot'] }).length) return;
      this.onMapClick?.(e.lngLat);
    });
  }

  set3D(on: boolean) {
    const m = this.map;
    if (on) {
      m.setTerrain({ source: 'dem', exaggeration: 1.3 });
      m.easeTo({ pitch: 55, duration: 700 });
    } else {
      m.setTerrain(null as any);
      m.easeTo({ pitch: 0, bearing: 0, duration: 700 });
    }
  }

  setLayerVisible(ids: string[], on: boolean) {
    for (const id of ids) if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }

  setStations(list: Station[]) {
    this.stationsByKey = new Map(list.map((s) => [s.key, s]));
    const now = Date.now();
    const features = list.map((s) => {
      const l = s.last;
      const stale = !l || now - l.t.getTime() > (s.source === 'meteofrance' ? 30 : 3) * 3600e3;
      const props: Record<string, unknown> = { key: s.key, source: s.source, stale, name: s.name };
      if (l?.speed != null) {
        props.speed = l.speed;
        props.label = `${Math.round(l.speed)}${l.gust != null ? `–${Math.round(l.gust)}` : ''} kt`;
      }
      if (l?.dir != null && l.speed != null && l.speed > 0.5) props.dir = l.dir;
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] }, properties: props };
    });
    (this.map.getSource('stations') as GeoJSONSource)?.setData({ type: 'FeatureCollection', features } as any);
  }

  setField(fc: WindSeries | null, grid: Grid | null, ti: number) {
    this.lastField = fc && grid ? { fc, grid, ti } : null;
    this.redrawField();
    const src = this.map.getSource('fc-arrows') as GeoJSONSource | undefined;
    if (!src) return;
    if (!fc || !grid) return src.setData(empty() as any);
    // Arrows on every other grid node, only at sea cells.
    const features = [];
    for (let p = 0; p < grid.lats.length; p++) {
      const i = p % grid.nx!, j = Math.floor(p / grid.nx!);
      if (i % 2 || j % 2) continue;
      const sp = fc.speed[p][ti], d = fc.dir[p][ti];
      if (sp == null || d == null) continue;
      if (!this.isWater(grid.lons[p], grid.lats[p])) continue;
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [grid.lons[p], grid.lats[p]] }, properties: { speed: sp, dir: d } });
    }
    src.setData({ type: 'FeatureCollection', features } as any);
  }

  private isWater(lon: number, lat: number): boolean {
    if (!this.map.getCanvas()) return true;
    const pt = this.map.project([lon, lat]);
    const c = this.map.getCanvas();
    if (pt.x < 0 || pt.y < 0 || pt.x > c.clientWidth || pt.y > c.clientHeight) return true;
    const f = this.map.queryRenderedFeatures(pt);
    return f.some((x) => x.sourceLayer === 'water');
  }

  /** Render the interpolated speed field, clipped to the basemap water polygons. */
  private redrawField() {
    const src = this.map.getSource('field') as ImageSource | undefined;
    if (!src) return;
    const lf = this.lastField;
    const { west, east, south, north } = FIELD_BBOX;
    const W = 480;
    const my = (lat: number) => Math.log(Math.tan(Math.PI / 4 + deg2rad(lat) / 2));
    const yN = my(north), yS = my(south);
    const H = Math.round((W * (yN - yS)) / deg2rad(east - west));
    const cv = this.fieldCanvas;
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    if (!lf) {
      src.updateImage({ url: cv.toDataURL() });
      return;
    }
    // 1. Water mask.
    const toPx = (lon: number, lat: number): [number, number] => [((lon - west) / (east - west)) * W, ((yN - my(lat)) / (yN - yS)) * H];
    let nWater = 0;
    try {
      const feats = this.map.querySourceFeatures('openmaptiles', { sourceLayer: 'water' });
      ctx.fillStyle = '#000';
      for (const f of feats) {
        const g = f.geometry as any;
        const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
        for (const poly of polys) {
          ctx.beginPath();
          for (const ring of poly) {
            ring.forEach(([lo, la]: number[], k: number) => {
              const [x, y] = toPx(lo, la);
              k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
            });
            ctx.closePath();
          }
          ctx.fill('evenodd');
          nWater++;
        }
      }
    } catch {
      /* style not ready */
    }
    // 2. Field (drawn "source-in" so it only appears over water).
    const { fc, grid, ti } = lf;
    const vals = fc.speed.map((s) => s[ti]);
    const img = ctx.createImageData(W, H);
    const step = FIELD_BBOX.step;
    for (let y = 0; y < H; y++) {
      const yy = yN - ((y + 0.5) / H) * (yN - yS);
      const lat = (2 * Math.atan(Math.exp(yy)) - Math.PI / 2) * (180 / Math.PI);
      const fy = (lat - south) / step;
      for (let x = 0; x < W; x++) {
        const lon = west + ((x + 0.5) / W) * (east - west);
        const v = sampleField(vals, grid.nx!, grid.ny!, (lon - west) / step, fy);
        const o = (y * W + x) * 4;
        if (v == null) continue;
        const [r, g, b] = speedRGB(v);
        img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
      }
    }
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    if (nWater > 0) ctx.globalCompositeOperation = 'source-in';
    else ctx.globalAlpha = 0.5;
    ctx.drawImage(tmp, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    src.updateImage({ url: cv.toDataURL() });
  }

  setZone(grid: Grid | null, fc: WindSeries | null, ti: number, res: AnalogResult | null) {
    const zs = this.map.getSource('zone') as GeoJSONSource | undefined;
    const ps = this.map.getSource('zone-pts') as GeoJSONSource | undefined;
    if (!zs || !ps) return;
    if (!grid) {
      zs.setData(empty() as any);
      ps.setData(empty() as any);
      return;
    }
    const n = grid.nx!;
    const corner = (i: number) => [grid.lons[i], grid.lats[i]];
    const pad = (a: number[], b: number[]) => [a[0] + (a[0] - b[0]) * 0.25, a[1] + (a[1] - b[1]) * 0.25];
    const c = Math.floor(grid.lats.length / 2);
    const ring = [0, n - 1, n * n - 1, n * (n - 1), 0].map((i) => pad(corner(i), corner(c)));
    zs.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} }] } as any);
    const features = grid.lats.map((la, p) => {
      const props: Record<string, unknown> = {};
      const sp = fc?.speed[p]?.[ti], d = fc?.dir[p]?.[ti];
      if (sp != null && d != null) { props.speed = sp; props.dir = d; props.label = `${Math.round(sp)}`; }
      if (res && Number.isFinite(res.anomaly[p])) props.anom = res.anomaly[p];
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [grid.lons[p], la] }, properties: props };
    });
    ps.setData({ type: 'FeatureCollection', features } as any);
  }

  flyToZone(lon: number, lat: number) {
    this.map.flyTo({ center: [lon, lat], zoom: 12, duration: 1200 });
  }
}

function empty() {
  return { type: 'FeatureCollection', features: [] };
}

function blankPNG() {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  return c.toDataURL();
}

function arrowImage(): ImageData {
  const s = 48;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.beginPath();
  // Arrow pointing up (north); rotated by dir+180 so it points downwind.
  g.moveTo(s / 2, 4);
  g.lineTo(s / 2 + 12, 22);
  g.lineTo(s / 2 + 4, 20);
  g.lineTo(s / 2 + 4, s - 6);
  g.lineTo(s / 2 - 4, s - 6);
  g.lineTo(s / 2 - 4, 20);
  g.lineTo(s / 2 - 12, 22);
  g.closePath();
  g.fill();
  return g.getImageData(0, 0, s, s);
}
