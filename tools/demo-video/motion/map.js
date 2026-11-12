// The `map` scene: a camera flight over MapLibre + OpenFreeMap vector tiles with 3D buildings, in confnote's dark
// tokens. Free, no key, commercial use and video allowed with the credit shown in the corner.
//
//   map  path [[t, [lng, lat], zoom, pitch, bearing]] (camera keys in scene seconds, Catmull-Rom between them)
//        venue {lngLat, footprint [[lng, lat]...], height, at, title, sub}: the venue's own building rises in ink
//              white from `at`, with a label on a leader line
//        hud (default true): the camera centre's coordinates, top left
//        credit (default the OpenFreeMap / OpenMapTiles / OpenStreetMap line): always on screen
//        whip (default 0.4 s): the last seconds push in and blur out, for a match cut into the next scene
//
// Determinism: the map is a pure function of the camera. renderFrame calls jumpTo(camera(t)), repaints, and waits
// for MapLibre's `idle` (every tile in view loaded and drawn) before the screenshot. Fades are off.
// Tiles come over the network from tiles.openfreemap.org, so a render needs a connection.

import * as maplibregl from './vendor/maplibre/maplibre-gl.mjs';

const OFM_TILES = 'https://tiles.openfreemap.org/planet';
const OFM_GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
const MAP_CREDIT = 'OpenFreeMap © OpenMapTiles Data from OpenStreetMap';
const LABEL_FONT = ['Noto Sans Regular'];
const IDLE_TIMEOUT_MS = 60_000;
const VENUE_RISE_S = 0.9;
const LEADER_PX = 150;
const WHIP_FADE = 0.55; // how far the map dims during its exit whip

// confnote's dark tokens (style.css): black land, panel parks, accent-soft water, line-grey roads, buildings from
// panel to a lighter grey with height. White is kept for the venue.
const INK = '#ffffff';
const MAP_STYLE = {
  version: 8,
  glyphs: OFM_GLYPHS,
  sources: { omt: { type: 'vector', url: OFM_TILES } },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#000000' } },
    { id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park', paint: { 'fill-color': '#0a0a0a' } },
    {
      id: 'landcover',
      type: 'fill',
      source: 'omt',
      'source-layer': 'landcover',
      filter: ['in', ['get', 'class'], ['literal', ['grass', 'wood']]],
      paint: { 'fill-color': '#0a0a0a' },
    },
    { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': '#1b1b1b' } },
    {
      id: 'water-edge',
      type: 'line',
      source: 'omt',
      'source-layer': 'water',
      paint: { 'line-color': '#3a3a3a', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 16, 1.5] },
    },
    {
      id: 'roads-minor',
      type: 'line',
      source: 'omt',
      'source-layer': 'transportation',
      filter: ['in', ['get', 'class'], ['literal', ['minor', 'service', 'path']]],
      minzoom: 13,
      paint: {
        'line-color': '#161616',
        'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 13, 0.5, 18, 8],
      },
    },
    {
      id: 'roads-major',
      type: 'line',
      source: 'omt',
      'source-layer': 'transportation',
      filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary', 'secondary', 'tertiary']]],
      paint: {
        'line-color': '#2e2e2e',
        'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 10, 0.6, 18, 18],
      },
    },
    {
      id: 'rail',
      type: 'line',
      source: 'omt',
      'source-layer': 'transportation',
      filter: ['in', ['get', 'class'], ['literal', ['rail', 'transit']]],
      paint: { 'line-color': '#222222', 'line-width': 1.2 },
    },
    {
      id: 'buildings',
      type: 'fill-extrusion',
      source: 'omt',
      'source-layer': 'building',
      minzoom: 13,
      paint: {
        'fill-extrusion-color': [
          'interpolate',
          ['linear'],
          ['coalesce', ['get', 'render_height'], 10],
          0,
          '#111111',
          40,
          '#1e1e1e',
          120,
          '#2e2e2e',
          240,
          '#444444',
        ],
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 10],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': 0.96,
        'fill-extrusion-vertical-gradient': true,
      },
    },
    {
      id: 'water-name',
      type: 'symbol',
      source: 'omt',
      'source-layer': 'water_name',
      layout: {
        'text-field': ['upcase', ['coalesce', ['get', 'name:en'], ['get', 'name']]],
        'text-font': LABEL_FONT,
        'text-size': 15,
        'text-letter-spacing': 0.3,
        'symbol-placement': 'line',
      },
      paint: { 'text-color': '#8f8f8f', 'text-halo-color': '#000000', 'text-halo-width': 1 },
    },
    {
      id: 'city',
      type: 'symbol',
      source: 'omt',
      'source-layer': 'place',
      filter: ['==', ['get', 'class'], 'city'],
      maxzoom: 12.5,
      layout: {
        'text-field': ['upcase', ['coalesce', ['get', 'name:en'], ['get', 'name']]],
        'text-font': LABEL_FONT,
        'text-size': 26,
        'text-letter-spacing': 0.5,
      },
      paint: { 'text-color': '#ffffff', 'text-halo-color': '#000000', 'text-halo-width': 1.5 },
    },
  ],
};

// ---------------------------------------------------------------- camera path

function catmull(p0, p1, p2, p3, u) {
  const u2 = u * u;
  const u3 = u2 * u;
  return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}

// Keys as flat rows [lng, lat, zoom, pitch, bearing]; bearings unwrapped so the camera turns the short way.
function cameraKeys(scene) {
  const keys = scene.path.map(([at, [lng, lat], zoom, pitch, bearing]) => [at, [lng, lat, zoom, pitch, bearing]]);
  for (let i = 1; i < keys.length; i++) {
    const prev = keys[i - 1][1][4];
    let b = keys[i][1][4];
    while (b - prev > 180) b -= 360;
    while (b - prev < -180) b += 360;
    keys[i][1][4] = b;
  }
  return keys;
}

function cameraAt(scene, t) {
  const keys = scene.cameraKeys || (scene.cameraKeys = cameraKeys(scene));
  if (t <= keys[0][0]) return keys[0][1];
  const last = keys.length - 1;
  if (t >= keys[last][0]) return keys[last][1];
  let i = 0;
  while (t > keys[i + 1][0]) i++;
  const u = prog(t, keys[i][0], keys[i + 1][0]);
  const at = (j) => keys[Math.min(last, Math.max(0, j))][1];
  return at(i).map((_, c) => catmull(at(i - 1)[c], at(i)[c], at(i + 1)[c], at(i + 2)[c], u));
}

// ---------------------------------------------------------------- the map

let map = null;
let mapReady = null;

function buildMapRoot() {
  const host = root('map');
  host.classList.add('map-scene');
  host.innerHTML = `
    <div class="map-frame"><div id="map"></div></div>
    <div class="map-hud"><span class="tag">London</span><span class="coords"></span></div>
    <div class="map-venue"><i class="leader"></i><div class="card"><b></b><span></span></div></div>
    <div class="map-credit"></div>`;
  return host;
}

function venueSource(scene) {
  const ring = scene.venue && scene.venue.footprint;
  const features = ring ? [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }] : [];
  return { type: 'geojson', data: { type: 'FeatureCollection', features } };
}

function createMap(first) {
  const host = buildMapRoot();
  host.style.display = 'block'; // the canvas needs a size while it is created
  const [lng, lat, zoom, pitch, bearing] = cameraAt(first, 0);
  map = new maplibregl.Map({
    container: host.querySelector('#map'),
    style: MAP_STYLE,
    center: [lng, lat],
    zoom,
    pitch,
    bearing,
    maxPitch: 85,
    interactive: false,
    attributionControl: false, // the credit is drawn in our own corner, large enough to read on video
    fadeDuration: 0,
    pixelRatio: 1,
    canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
  });
  return new Promise((resolve, reject) => {
    map.once('error', (event) => reject(new Error(`map: ${event.error && event.error.message}`)));
    map.once('load', () => {
      map.addSource('venue', venueSource(first));
      map.addLayer({
        id: 'venue',
        type: 'fill-extrusion',
        source: 'venue',
        paint: {
          'fill-extrusion-color': INK,
          'fill-extrusion-height': 0,
          'fill-extrusion-opacity': 0.92,
          'fill-extrusion-vertical-gradient': true,
        },
      });
      map.setLight({ anchor: 'map', color: '#ffffff', intensity: 0.42, position: [1.4, 200, 40] });
      host.style.display = 'none';
      resolve();
    });
  });
}

function settle() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('map: tiles did not load in time')), IDLE_TIMEOUT_MS);
    map.once('idle', () => {
      clearTimeout(timer);
      resolve();
    });
    map.triggerRepaint();
  });
}

function formatCoords(lng, lat) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}° ${ns}   ${Math.abs(lng).toFixed(4)}° ${ew}`;
}

async function updateMap(t, dur, scene) {
  await mapReady;
  const host = root('map');
  if (map.sceneIndex !== scene.index) {
    // One map serves every map scene; each scene brings its own venue.
    map.getSource('venue').setData(venueSource(scene).data);
    map.sceneIndex = scene.index;
  }
  const [lng, lat, zoom, pitch, bearing] = cameraAt(scene, t);
  map.jumpTo({ center: [lng, lat], zoom, pitch, bearing });

  const venue = scene.venue || {};
  const rise = venue.at === undefined ? 0 : easeOut(prog(t, venue.at, venue.at + VENUE_RISE_S));
  map.setPaintProperty('venue', 'fill-extrusion-height', rise * (venue.height || 30));
  await settle();

  host.querySelector('.map-hud').style.display = scene.hud === false ? 'none' : 'flex';
  host.querySelector('.coords').textContent = formatCoords(lng, lat);
  host.querySelector('.map-credit').textContent = scene.credit || MAP_CREDIT;

  const label = host.querySelector('.map-venue');
  if (venue.lngLat && venue.at !== undefined) {
    const p = map.project(venue.lngLat);
    const k = easeOut(prog(t, venue.at + 0.3, venue.at + 0.9));
    label.style.opacity = k;
    label.style.left = `${p.x}px`;
    label.style.top = `${p.y - LEADER_PX * k}px`;
    label.querySelector('.leader').style.height = `${LEADER_PX * k}px`;
    label.querySelector('b').textContent = venue.title || '';
    label.querySelector('span').textContent = venue.sub || '';
  } else {
    label.style.opacity = 0;
  }

  // In from black after the hook; out with a whip push for the match cut.
  const whip = scene.whip ?? 0.4;
  const kin = easeOut(prog(t, 0, 0.35));
  const kout = whip > 0 ? easeInOut(prog(t, dur - whip, dur)) : 0;
  const frame = host.querySelector('.map-frame');
  frame.style.opacity = kin * (1 - WHIP_FADE * kout); // never to black: the next scene whips in from the blur
  frame.style.transform = `scale(${1 + kout * 0.35})`;
  frame.style.filter = kout > 0 ? `blur(${kout * 14}px)` : 'none';
  host.querySelector('.map-hud').style.opacity = kin * (1 - kout);
  label.style.opacity = Number(label.style.opacity) * (1 - kout);
}

const mapScenes = scenesOfKind('map');
if (mapScenes.length) {
  mapReady = createMap(mapScenes[0]);
  KIT_PRELOADS.push(mapReady);
}
UPDATERS.map = updateMap;
