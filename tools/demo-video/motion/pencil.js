// The `pencil` scene: handwriting in pencil on paper, stroke by stroke.
//
//   pencil  lines [[at, text, mark?]] (mark: under | strike, drawn in pencil once the line is written)
//           date (written top right first), speed (default 1.25: glyphs per Tegaki's natural time), size (font px,
//           default 84), paper (asset, default the CC0 paper scan), seed (default 3), tool (default true: a pencil
//           follows the tip)
//
// How: Tegaki's stroke-ordered glyph data for Caveat (assets/glyphs/caveat.json: points [x, y, width] in font units
// per stroke, with each stroke's delay and duration) gives the path a hand takes. Each frame cuts every stroke to
// its progress at t and rebuilds its outline with perfect-freehand, so the tip tapers like a real pencil. The ink
// goes through an SVG graphite filter (a seeded feTurbulence roughens the edge, a second one punches grain into it)
// and is multiplied over a CC0 paper scan. The edge "boils" like hand-drawn animation: its seed steps every 3
// frames from the frame index.

import { getStroke } from './vendor/perfect-freehand/perfect-freehand.mjs';

const GLYPHS_URL = asset('glyphs/caveat.json');
const UNITS_PER_EM = 1000;
const SPACE_UNITS = 230;
const DEFAULT_SIZE_PX = 84;
const LINE_GAP = 1.45; // line height in ems
const PAGE_W = 1240;
const PAGE_H = 820;
const MARGIN_X = 170;
const FIRST_BASELINE = 250;
const RULE_BELOW_PX = 12; // a ruled line sits this far under each baseline
const GRAPHITE = '#202023';
const PRESSURE_FLOOR = 0.25;
const MARK_S = 0.4;
const BOIL_EVERY = 3; // frames
const BOIL_SEEDS = 4;
const TOOL_LIFT_S = 0.12; // the pencil hops to the next stroke over this long at most

let glyphs = null;

function glyphFor(ch) {
  return glyphs[ch] || null;
}

// Lay out one line: absolute strokes in page px, each with its own start and duration in scene seconds.
function layoutLine(words, x0, baseline, at, scale, speed) {
  const strokes = [];
  let x = x0;
  let t = at;
  for (const ch of words) {
    const g = glyphFor(ch);
    if (!g) {
      x += SPACE_UNITS * scale;
      t += 0.08 / speed;
      continue;
    }
    for (const s of g.s) {
      const maxW = Math.max(...s.p.map((p) => p[2]), 1);
      strokes.push({
        start: t + s.d / speed,
        dur: Math.max(s.a / speed, 1 / 60),
        points: s.p.map(([px, py, w]) => [x + px * scale, baseline + py * scale, w / maxW]),
        size: maxW * scale * 0.62,
      });
    }
    x += g.w * scale;
    t += g.t / speed;
  }
  return { strokes, end: t, x1: x };
}

// A pencil line under or through a written line, with a seeded wobble.
function markStroke(kind, x0, x1, baseline, at, scale, rand) {
  const y = kind === 'strike' ? baseline - 0.28 * UNITS_PER_EM * scale : baseline + 0.14 * UNITS_PER_EM * scale;
  const n = 14;
  const points = Array.from({ length: n }, (_, i) => {
    const k = i / (n - 1);
    return [lerp(x0 - 8, x1 + 10, k), y + (rand() - 0.5) * 5 + k * 4, 0.7 + 0.3 * Math.sin(k * Math.PI)];
  });
  return { start: at, dur: MARK_S, points, size: 4.2 };
}

function arcLengths(points) {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    lengths.push(lengths[i - 1] + Math.hypot(bx - ax, by - ay));
  }
  return lengths;
}

// The stroke's points up to fraction k of its length, ending on an interpolated point.
function cutStroke(stroke, k) {
  if (k >= 1) return stroke.points;
  const lengths = stroke.lengths || (stroke.lengths = arcLengths(stroke.points));
  const target = k * lengths[lengths.length - 1];
  const out = [stroke.points[0]];
  for (let i = 1; i < stroke.points.length; i++) {
    if (lengths[i] < target) {
      out.push(stroke.points[i]);
      continue;
    }
    const f = (target - lengths[i - 1]) / Math.max(lengths[i] - lengths[i - 1], 1e-6);
    const a = stroke.points[i - 1];
    const b = stroke.points[i];
    out.push([lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)]);
    break;
  }
  return out;
}

function outlinePath(points, size, done) {
  const outline = getStroke(
    points.map(([x, y, p]) => [x, y, PRESSURE_FLOOR + (1 - PRESSURE_FLOOR) * p]),
    { size, thinning: 0.55, smoothing: 0.6, streamline: 0.35, simulatePressure: false, last: done },
  );
  if (outline.length < 3) return '';
  const d = outline.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`);
  return `${d.join('')}Z`;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

// Graphite: a roughened edge (displacement by low-frequency noise) with grain punched into it.
function graphiteFilter(id, seed) {
  const filter = svgEl('filter', { id, x: '-2%', y: '-10%', width: '104%', height: '120%' });
  filter.append(
    svgEl('feTurbulence', {
      type: 'fractalNoise',
      baseFrequency: '0.08',
      numOctaves: '2',
      seed: String(seed),
      result: 'wobble',
      class: 'boil',
    }),
    svgEl('feDisplacementMap', {
      in: 'SourceGraphic',
      in2: 'wobble',
      scale: '2.6',
      xChannelSelector: 'R',
      yChannelSelector: 'G',
      result: 'rough',
    }),
    svgEl('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.9', numOctaves: '2', seed: String(seed + 50), result: 'grain' }),
    svgEl('feColorMatrix', {
      in: 'grain',
      type: 'matrix',
      values: '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -2.4 1.75',
      result: 'tooth',
    }),
    svgEl('feComposite', { in: 'rough', in2: 'tooth', operator: 'in' }),
  );
  return filter;
}

// A plain pencil, drawn here: graphite body, bare wood cone, graphite point at the origin (the tip). Held in a
// right hand: the body runs down and to the right of the point, away from what is already written.
const PENCIL_ANGLE_DEG = 145;
function pencilTool() {
  const g = svgEl('g', { class: 'pencil-tool' });
  const body = svgEl('g', { transform: `rotate(${PENCIL_ANGLE_DEG})` });
  body.append(
    svgEl('path', { d: 'M0 0 L9 -26 L-9 -26 Z', fill: '#c9c4bb' }),
    svgEl('path', { d: 'M0 0 L3.2 -9 L-3.2 -9 Z', fill: '#2a2a2a' }),
    svgEl('rect', { x: -9, y: -330, width: 18, height: 304, fill: '#1c1c1c' }),
    svgEl('rect', { x: -9, y: -330, width: 6, height: 304, fill: '#2e2e2e' }),
    svgEl('rect', { x: -9.5, y: -362, width: 19, height: 34, fill: '#8f8f8f' }),
  );
  g.append(body);
  return g;
}

function buildPencil(scene) {
  const size = scene.size || DEFAULT_SIZE_PX;
  const scale = size / UNITS_PER_EM;
  const speed = scene.speed || 1.25;
  const rand = seeded(scene.seed ?? 3);
  const strokes = [];
  const lineGap = Math.round(LINE_GAP * size);
  if (scene.date) {
    const date = layoutLine(scene.date, 0, 0, 0.3, scale * 0.7, speed * 1.4);
    const shift = PAGE_W - 90 - date.x1;
    for (const s of date.strokes) s.points = s.points.map(([x, y, p]) => [x + shift, y + FIRST_BASELINE - lineGap, p]);
    strokes.push(...date.strokes);
  }
  scene.lines.forEach(([at, words, mark], i) => {
    const baseline = FIRST_BASELINE + i * lineGap;
    const line = layoutLine(words, MARGIN_X, baseline, at, scale, speed);
    strokes.push(...line.strokes);
    if (mark) strokes.push(markStroke(mark, MARGIN_X, line.x1, baseline, line.end + 0.12, scale, rand));
  });
  strokes.sort((a, b) => a.start - b.start);

  const wrap = el('div', 'pencil-wrap');
  const page = el('div', 'pencil-page');
  page.style.backgroundImage = `url("${asset(scene.paper || 'paper/paper001-color.jpg')}")`;
  // Ruled lines sit just under each baseline (style.css draws them from these two variables).
  page.style.setProperty('--rule', `${lineGap}px`);
  page.style.setProperty('--rule-y', `${(FIRST_BASELINE + RULE_BELOW_PX + 1) % lineGap}px`);
  const svg = svgEl('svg', { class: 'pencil-ink', width: PAGE_W, height: PAGE_H, viewBox: `0 0 ${PAGE_W} ${PAGE_H}` });
  const filterId = `graphite-${scene.index}`;
  const defs = svgEl('defs');
  defs.append(graphiteFilter(filterId, scene.seed ?? 3));
  const ink = svgEl('g', { filter: `url(#${filterId})`, fill: GRAPHITE });
  for (const _ of strokes) ink.append(svgEl('path'));
  svg.append(defs, ink);
  const tool = svgEl('svg', { class: 'pencil-tool-layer', width: PAGE_W, height: PAGE_H });
  tool.append(pencilTool());
  page.append(svg, tool);
  wrap.append(page);
  wrap.strokes = strokes;
  return wrap;
}

// Where the pencil's point is at t: on the live stroke's tip, hopping between strokes, off the page before and after.
function toolAt(strokes, t) {
  const first = strokes[0];
  const last = strokes[strokes.length - 1];
  const offPage = [PAGE_W + 200, PAGE_H + 260];
  if (!first) return { xy: offPage, lift: 1 };
  if (t < first.start) {
    const k = easeInOut(prog(t, first.start - 0.6, first.start));
    const p = first.points[0];
    return { xy: [lerp(offPage[0], p[0], k), lerp(offPage[1], p[1], k)], lift: 1 - k };
  }
  for (let i = 0; i < strokes.length; i++) {
    const s = strokes[i];
    if (t >= s.start && t <= s.start + s.dur) {
      const cut = cutStroke(s, (t - s.start) / s.dur);
      const tip = cut[cut.length - 1];
      return { xy: [tip[0], tip[1]], lift: 0 };
    }
    const next = strokes[i + 1];
    const end = s.start + s.dur;
    if (next && t > end && t < next.start) {
      const hop = Math.min(next.start - end, TOOL_LIFT_S * 4);
      const k = easeInOut(prog(t, next.start - hop, next.start));
      const a = s.points[s.points.length - 1];
      const b = next.points[0];
      return { xy: [lerp(a[0], b[0], k), lerp(a[1], b[1], k)], lift: Math.sin(k * Math.PI) };
    }
  }
  const end = last.start + last.dur;
  const k = easeInOut(prog(t, end + 0.2, end + 0.9));
  const p = last.points[last.points.length - 1];
  return { xy: [lerp(p[0], offPage[0], k), lerp(p[1], offPage[1], k)], lift: k };
}

function updatePencil(t, dur, scene) {
  const node = buildOnce(scene, () => buildPencil(scene));
  const strokes = node.strokes;
  const paths = node.querySelectorAll('.pencil-ink g path');
  strokes.forEach((s, i) => {
    const k = prog(t, s.start, s.start + s.dur);
    const key = Math.round(k * 1000) / 1000; // k is already clamped to [0, 1]
    if (paths[i].dataset.k === String(key)) return;
    paths[i].dataset.k = String(key);
    paths[i].setAttribute('d', key > 0 ? outlinePath(cutStroke(s, key), s.size, key >= 1) : '');
  });

  // The edge boils: a new noise seed every few frames, from the frame index.
  const frame = Math.round((scene.start + t) * FPS);
  const boil = (scene.seed ?? 3) + (Math.floor(frame / BOIL_EVERY) % BOIL_SEEDS);
  node.querySelector('.boil').setAttribute('seed', String(boil));

  const tool = node.querySelector('.pencil-tool');
  const showTool = scene.tool !== false;
  tool.style.display = showTool ? 'block' : 'none';
  if (showTool) {
    const { xy, lift } = toolAt(strokes, t);
    tool.setAttribute('transform', `translate(${xy[0]} ${xy[1] - lift * 10})`);
    tool.style.filter = `drop-shadow(${10 + lift * 18}px ${14 + lift * 22}px ${6 + lift * 8}px rgba(0,0,0,0.35))`;
  }

  const page = node.querySelector('.pencil-page');
  const k = easeOut(prog(t, 0, 0.8));
  const drift = prog(t, 0, dur);
  page.style.opacity = k;
  page.style.transform =
    `perspective(2200px) translateY(${(1 - k) * 40}px) rotateX(${lerp(16, 9, drift)}deg) ` +
    `rotateY(${lerp(-8, -3, drift)}deg) rotateZ(-1.4deg) scale(${1.02 + 0.06 * drift})`;
  const out = easeInOut(prog(t, dur - 0.6, dur));
  node.style.opacity = 1 - out;
}

async function loadGlyphs() {
  const response = await fetch(GLYPHS_URL);
  if (!response.ok) throw new Error(`pencil: ${GLYPHS_URL} ${response.status}`);
  glyphs = await response.json();
}

if (scenesOfKind('pencil').length) KIT_PRELOADS.push(loadGlyphs());
UPDATERS.pencil = updatePencil;
