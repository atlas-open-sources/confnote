// Deterministic renderer: renderFrame(i) draws frame i of the storyboard and resolves when every image is
// decoded. Nothing here reads the clock; every animation is a pure function of the frame time.
//
// Scene kinds (fields in the storyboard):
//   cards     kicker, cards [{label, title, body, meta}], arrow (text between two cards), cardAt [s, s], arrowAt
//   code      kicker, url, badge, lines [[kind, text, value]] (kind: p plain, k key, kv key+value, c comment)
//   chapter   n (CHAPTERS[n] gives title and sub)
//   footage   chapter, src, parts [[from, to, speed]], zooms [[t, {x, y, z}]], caption, callouts, url,
//             masks [[x, y, w, h, from?, to?]] (source pixels blurred, e.g. a contact line; times in scene seconds)
//             spot [[from, to, x, y, w, h]] (dims everything outside a source rectangle: the panel the zoom frames,
//             so the page beside a narrow panel never reads as text cut at the window's edge)
//   placeholder  lines (a slot for footage still to shoot)
//   paper     date, lines [[at, text, mark?]] (mark: strike | under), handwritten on a page, a memory
//   layout    url, title, sessions [text], notes [text], beats {notes, concierge, open, close}, tabs [{handle, name, at}]
//   cards3    kicker, cards [{label, title, items}], proof (html), button
//   statement label, title, lines [text], button, footnote (one centred card: the ending's Mac app, a promo)
//   credits   brand, tag, line (html), footnote
// Every scene can carry vo [[offset, block]] for the narration. depth.js adds modules3d, photo and, with
// STORY.depth, the 3D transitions, opening and close. kinetic.js adds hook (GSAP kinetic type), map.js adds map
// (MapLibre + OpenFreeMap), pencil.js adds pencil (handwriting in pencil on paper), three-scene.js adds three
// (three.js rigs: hall, desk). Each of those files lists its kind's fields.

const params = new URLSearchParams(location.search);
const FRAMES_DIR = params.get('frames') || '../frames';
const SRC_FRAMES = Object.fromEntries(
  (params.get('counts') || '')
    .split(',')
    .filter(Boolean)
    .map((pair) => {
      const [id, n] = pair.split(':');
      return [id, Number(n)];
    }),
);
const BRANDMARK = params.get('brandmark') || '';

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const prog = (t, a, b) => clamp01((t - a) / (b - a));
const lerp = (a, b, k) => a + (b - a) * k;
const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const easeOut = (k) => 1 - Math.pow(1 - k, 3);

// Shared by the motion modules (kinetic.js, map.js, pencil.js, three-scene.js). Asset paths in a storyboard are
// relative to tools/demo-video/assets/ (see assets/LICENCES.md) unless they are full URLs.
const ASSETS = new URL('../assets/', location.href).href;
const asset = (path) => new URL(path, ASSETS).href;

// A seeded random source (mulberry32). Never Math.random: every frame must come out the same on every render.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// Smooth 1D value noise in [-1, 1] from a seeded table: the same t always gives the same value.
function noiseTable(seed, size = 256) {
  const rand = seeded(seed);
  const table = Array.from({ length: size }, () => rand() * 2 - 1);
  return (t) => {
    const i = Math.floor(t);
    const f = t - i;
    const k = f * f * (3 - 2 * f);
    return lerp(table[((i % size) + size) % size], table[(((i + 1) % size) + size) % size], k);
  };
}

// Work a scene kind needs before the first frame (fonts, glyphs, models, map style). index.html awaits them all,
// then sets window.KIT_READY, which render.py waits for.
const KIT_PRELOADS = [];
const scenesOfKind = (kind) => SCENES.filter((s) => s.kind === kind);

function el(tag, cls) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

function text(tag, cls, value) {
  const node = el(tag, cls);
  node.textContent = value;
  return node;
}

// Fade + rise for an element that enters at `at` over `dur` seconds.
function rise(node, t, at, dur = 0.55, dy = 26) {
  const k = easeOut(prog(t, at, at + dur));
  node.style.opacity = k;
  node.style.transform = `translateY(${(1 - k) * dy}px)`;
  node.style.filter = k < 1 ? `blur(${(1 - k) * 6}px)` : 'none';
}

const stage = document.getElementById('stage');
const roots = {};
function root(kind) {
  if (!roots[kind]) {
    roots[kind] = el('div', 'scene');
    stage.appendChild(roots[kind]);
  }
  return roots[kind];
}

// Scene content is built once per scene (keyed by index) and reused across its frames.
const built = new Map();
function buildOnce(scene, build) {
  if (!built.has(scene.index)) built.set(scene.index, build());
  const node = built.get(scene.index);
  const host = root(scene.kind);
  if (host.firstChild !== node) host.replaceChildren(node);
  return node;
}

function sceneFade(node, t, dur, out = 0.6) {
  node.style.opacity = 1 - easeInOut(prog(t, dur - out, dur));
}

// ---------------------------------------------------------------- cards

function buildCards(scene) {
  const wrap = el('div');
  if (scene.kicker) wrap.append(text('div', 'ex-kicker', scene.kicker));
  const row = el('div', 'o-cards');
  scene.cards.forEach((card, i) => {
    if (i === 1 && scene.arrow) {
      const arrow = el('div', 'o-arrow');
      arrow.append(text('span', '', scene.arrow), el('i'));
      row.append(arrow);
    }
    const box = el('div', 'o-card');
    box.append(text('div', 'k', card.label), text('h2', '', card.title));
    if (card.body) box.append(text('p', '', card.body));
    if (card.meta) box.append(text('p', 'm', card.meta));
    row.append(box);
  });
  wrap.append(row);
  return wrap;
}

function updateCards(t, dur, scene) {
  const node = buildOnce(scene, () => buildCards(scene));
  const kicker = node.querySelector('.ex-kicker');
  if (kicker) rise(kicker, t, 0.1, 0.6, 14);
  const at = scene.cardAt || [0.5, 3];
  node.querySelectorAll('.o-card').forEach((card, i) => rise(card, t, at[i] ?? at[0], 0.7, 34));
  const arrow = node.querySelector('.o-arrow');
  if (arrow) {
    const a = scene.arrowAt ?? at[1] - 0.6;
    arrow.style.opacity = easeOut(prog(t, a, a + 0.4));
    arrow.querySelector('i').style.width = `${easeInOut(prog(t, a, a + 0.8)) * 100}%`;
  }
  sceneFade(node, t, dur, 0.5);
}

// ---------------------------------------------------------------- code

function buildCode(scene) {
  const wrap = el('div');
  if (scene.kicker) wrap.append(text('div', 'ex-kicker', scene.kicker));
  const box = el('div', 'o-json');
  const bar = el('div', 'bar');
  bar.append(el('span', 'dot'), el('span', 'dot'), el('span', 'dot'), text('span', 'url', scene.url));
  if (scene.badge) bar.append(text('span', 'live', scene.badge));
  const pre = el('pre');
  for (const [kind, a, b] of scene.lines) {
    const line = el('div', `ln ${kind}`);
    line.append(document.createTextNode(a));
    if (kind === 'kv') line.append(text('em', '', b));
    pre.append(line);
  }
  box.append(bar, pre);
  wrap.append(box);
  return wrap;
}

function updateCode(t, dur, scene) {
  const node = buildOnce(scene, () => buildCode(scene));
  const kicker = node.querySelector('.ex-kicker');
  if (kicker) kicker.style.opacity = 1;
  rise(node.querySelector('.o-json'), t, 0.1, 0.7, 30);
  node.querySelectorAll('.ln').forEach((line, i) => {
    line.style.opacity = easeOut(prog(t, 0.5 + i * 0.12, 0.8 + i * 0.12));
  });
  sceneFade(node, t, dur);
}

// ---------------------------------------------------------------- chapter cards

function buildChapter() {
  const wrap = el('div', 'chapter-wrap');
  const head = el('div', 'chapter-head');
  const words = el('div', 'chapter-words');
  words.append(el('div', 'chapter-title'), el('div', 'chapter-sub'));
  head.append(el('div', 'chapter-num'), words);
  const progress = el('div', 'progress');
  for (const _ of Object.keys(CHAPTERS)) {
    const track = el('div');
    track.append(el('i'));
    progress.append(track);
  }
  wrap.append(head, progress);
  return wrap;
}

function updateChapter(t, dur, scene) {
  const node = buildOnce(scene, buildChapter);
  const info = CHAPTERS[scene.n];
  const num = node.querySelector('.chapter-num');
  num.textContent = String(scene.n).padStart(2, '0');
  node.querySelector('.chapter-title').textContent = info.title;
  node.querySelector('.chapter-sub').textContent = info.sub;
  const kn = easeOut(prog(t, 0, 0.55));
  num.style.opacity = kn;
  num.style.transform = `translateX(${(1 - kn) * -50}px)`;
  rise(node.querySelector('.chapter-title'), t, 0.12, 0.55, 22);
  rise(node.querySelector('.chapter-sub'), t, 0.26, 0.55, 16);
  node.querySelectorAll('.progress i').forEach((bar, i) => {
    const n = i + 1;
    bar.style.background = n === scene.n ? 'var(--ink)' : 'var(--muted)';
    let width = 0;
    if (n < scene.n) width = 1;
    else if (n === scene.n) width = easeInOut(prog(t, 0.3, 1.2));
    bar.style.width = `${width * 100}%`;
  });
  const out = easeInOut(prog(t, dur - 0.45, dur));
  node.style.opacity = 1 - out;
  node.style.transform = `translateX(${out * 40}px)`;
}

// ---------------------------------------------------------------- footage

const footage = root('footage');
footage.innerHTML = `
  <div id="window">
    <div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="url"></span><span style="width:60px"></span></div>
    <div class="view"><img id="img-back" alt=""><img id="img-front" alt=""><div id="masks-back"></div><div id="masks-front"></div><div id="spot"></div></div>
  </div>
  <div class="callout"><b></b><span></span></div>`;

const VIEW_W = 1720;
const CROSSFADE = 0.22;

function sourceTime(scene, tau) {
  let left = tau;
  for (const [from, to, speed] of scene.parts) {
    const span = (to - from) / speed;
    if (left <= span) return from + left * speed;
    left -= span;
  }
  return scene.parts[scene.parts.length - 1][1];
}

function frameUrl(src, srcT) {
  const index = Math.min(Math.round(srcT * SRC_FPS) + 1, SRC_FRAMES[src] || Infinity);
  return `${FRAMES_DIR}/${src}/f${String(index).padStart(5, '0')}.jpg`;
}

function toCenter(r) {
  const w = SRC_W / r.z;
  const h = SRC_BAND_H / r.z;
  return { cx: r.x + w / 2, cy: r.y + h / 2, z: r.z };
}

// Clamp a visible span to the source; a span wider than the source is centred (letterboxed).
function clampSpan(start, span, size) {
  if (span >= size) return (size - span) / 2;
  return Math.min(Math.max(start, 0), size - span);
}

function zoomAt(scene, tau) {
  const keys = (scene.zooms || [[0, ALL]]).map(([k, r]) => [k, toCenter(r)]);
  let c = keys[0][1];
  if (tau > keys[0][0]) {
    c = keys[keys.length - 1][1];
    for (let i = 0; i < keys.length - 1; i++) {
      const [t0, a] = keys[i];
      const [t1, b] = keys[i + 1];
      if (tau <= t1) {
        const k = easeInOut(prog(tau, t0, t1));
        c = {
          cx: lerp(a.cx, b.cx, k),
          cy: lerp(a.cy, b.cy, k),
          z: Math.exp(lerp(Math.log(a.z), Math.log(b.z), k)),
        };
        break;
      }
    }
  }
  const w = SRC_W / c.z;
  const h = SRC_BAND_H / c.z;
  return { x: clampSpan(c.cx - w / 2, w, SRC_W), y: clampSpan(c.cy - h / 2, h, SRC_H), z: c.z };
}

// Blur boxes that move with the footage's zoom. One pool per image so a crossfade never uncovers a mask.
const MASK_BLUR_PX = 18;
function placeMasks(pool, scene, tau, r, s) {
  const live = (scene.masks || []).filter(([, , , , from = -Infinity, to = Infinity]) => tau >= from && tau <= to);
  while (pool.children.length < live.length) pool.append(el('div', 'mask'));
  [...pool.children].forEach((box, i) => {
    const m = live[i];
    box.style.display = m ? 'block' : 'none';
    if (!m) return;
    const [x, y, w, h] = m;
    box.style.left = `${(x - r.x) * s}px`;
    box.style.top = `${(y - r.y) * s}px`;
    box.style.width = `${w * s}px`;
    box.style.height = `${h * s}px`;
    box.style.backdropFilter = `blur(${MASK_BLUR_PX * s}px)`;
  });
}

const SPOT_FADE_S = 0.3;

// One spotlight on the front image: a hole the size of the subject, everything around it dimmed.
function placeSpot(scene, tau, r, s) {
  const spot = footage.querySelector('#spot');
  const live = (scene.spot || []).find(([from, to]) => tau >= from && tau <= to);
  if (!live) {
    spot.style.opacity = 0;
    return;
  }
  const [from, to, x, y, w, h] = live;
  spot.style.left = `${(x - r.x) * s}px`;
  spot.style.top = `${(y - r.y) * s}px`;
  spot.style.width = `${w * s}px`;
  spot.style.height = `${h * s}px`;
  spot.style.opacity = prog(tau, from, from + SPOT_FADE_S) * (1 - prog(tau, to - SPOT_FADE_S, to));
}

async function placeImage(img, scene, tau, pool) {
  const url = frameUrl(scene.src, sourceTime(scene, tau));
  if (img.dataset.url !== url) {
    img.src = url;
    img.dataset.url = url;
    await img.decode();
  }
  const r = zoomAt(scene, tau);
  const s = (VIEW_W * r.z) / SRC_W;
  img.style.transform = `translate(${-r.x * s}px, ${-r.y * s}px) scale(${s})`;
  placeMasks(pool, scene, tau, r, s);
  if (img.id === 'img-front') placeSpot(scene, tau, r, s);
}

// Opt-in (STORY.partCrossfade, seconds): dissolve across a cut inside one footage scene, where the next part jumps in
// source time or the zoom snaps at the part boundary (v8, musa 2026-11-13: "some cuts later in the video are
// choppy"). Off when unset, so earlier stories render as before.
const PART_XFADE = STORY.partCrossfade || 0;
const PART_XFADE_FROM = STORY.partCrossfadeFrom || 0; // the first chapter it applies to
const PART_XFADE_LEAD_S = 0.06; // starts just before the boundary, where a zoom snap's two keys sit
const PART_BACK_S = 0.12; // the outgoing frame: before the snap's first key
const SOURCE_JUMP_S = 0.05;
const ZOOM_SNAP_PX = 2;
const ZOOM_SNAP_Z = 0.01;

function partCut(scene, t) {
  if (!PART_XFADE || !scene.parts || (scene.chapter || 0) < PART_XFADE_FROM) return null;
  let b = 0;
  for (let i = 0; i < scene.parts.length - 1; i++) {
    const [from, to, speed] = scene.parts[i];
    b += (to - from) / speed;
    const start = b - PART_XFADE_LEAD_S;
    if (t < start || t >= start + PART_XFADE) continue;
    const jumps = Math.abs(scene.parts[i + 1][0] - to) > SOURCE_JUMP_S;
    const before = zoomAt(scene, b - PART_BACK_S);
    const after = zoomAt(scene, b + 0.01);
    const snaps =
      Math.abs(before.x - after.x) + Math.abs(before.y - after.y) > ZOOM_SNAP_PX ||
      Math.abs(before.z - after.z) > ZOOM_SNAP_Z;
    if (jumps || snaps) return { back: b - PART_BACK_S, k: (t - start) / PART_XFADE };
  }
  return null;
}

async function updateFootage(t, dur, scene) {
  const prev = SCENES[scene.index - 1];
  const next = SCENES[scene.index + 1];
  const win = footage.querySelector('#window');
  footage.querySelector('.url').textContent = scene.url || APP_URL;
  const back = footage.querySelector('#img-back');
  const front = footage.querySelector('#img-front');
  const backMasks = footage.querySelector('#masks-back');
  const frontMasks = footage.querySelector('#masks-front');
  if (prev && prev.kind === 'footage' && t < CROSSFADE && !scene.enter3d) {
    // Masks blur the composite under them, so both sets stay fully on while the images cross.
    await placeImage(front, scene, t, frontMasks);
    await placeImage(back, prev, prev.dur - 1 / FPS, backMasks);
    back.style.opacity = 1;
    front.style.opacity = easeInOut(t / CROSSFADE);
  } else if (partCut(scene, t)) {
    const cut = partCut(scene, t);
    await placeImage(front, scene, t, frontMasks);
    await placeImage(back, scene, cut.back, backMasks);
    back.style.opacity = 1;
    front.style.opacity = easeInOut(cut.k);
  } else {
    await placeImage(front, scene, t, frontMasks);
    placeMasks(backMasks, {}, 0, ALL, 1);
    back.style.opacity = 0;
    front.style.opacity = 1;
  }
  let opacity = 1;
  let flat = 1;
  if (typeof DEPTH !== 'undefined' && DEPTH) {
    // depth.js: the window swings in and out in 3D at section boundaries, and is flat everywhere else
    const pose = windowDepth(scene, t, dur);
    opacity = pose.opacity;
    flat = pose.flat;
    win.style.transform = pose.transform;
    win.style.boxShadow = pose.shadow;
  } else {
    let scale = 1;
    if (!prev || prev.kind !== 'footage') {
      const k = easeOut(prog(t, 0, 0.5));
      opacity = k;
      scale = lerp(0.965, 1, k);
    }
    if (!next || next.kind !== 'footage') {
      const k = easeInOut(prog(t, dur - 0.35, dur));
      opacity *= 1 - k;
      scale *= lerp(1, 0.985, k);
    }
    win.style.transform = `scale(${scale})`;
  }
  win.style.opacity = opacity;

  const callout = footage.querySelector('.callout');
  const active = (scene.callouts || []).find(([a, b]) => t >= a && t <= b);
  if (active) {
    const [a, b, color, title, body] = active;
    callout.style.setProperty('--accent', color);
    callout.querySelector('b').textContent = title;
    callout.querySelector('span').textContent = body;
    const k = easeOut(prog(t, a, a + 0.45)) * (1 - easeInOut(prog(t, b - 0.3, b)));
    callout.style.opacity = k * opacity * flat; // a callout is a detail: only on a square-on window
    callout.style.transform = `translateX(${(1 - k) * 40}px)`;
  } else {
    callout.style.opacity = 0;
  }
}

// ---------------------------------------------------------------- placeholder

function updatePlaceholder(t, dur, scene) {
  const node = buildOnce(scene, () => {
    const wrap = el('div', 'center-col');
    wrap.append(text('div', 'tag', 'Footage to come'));
    const lines = el('div', 'ph-lines');
    for (const line of scene.lines) lines.append(text('div', '', line));
    wrap.append(lines);
    return wrap;
  });
  node.style.opacity = easeOut(prog(t, 0, 0.4)) * (1 - easeInOut(prog(t, dur - 0.4, dur)));
}

// ---------------------------------------------------------------- paper (handwritten notes, a memory)

const WRITE_S_PER_CHAR = 0.045; // handwriting speed
const PAPER_TILT_DEG = -1.6;
const PAPER_DRIFT = 0.06; // slow push-in over the scene

function buildPaper(scene) {
  const wrap = el('div', 'paper-wrap');
  const page = el('div', 'paper');
  const rows = [];
  if (scene.date) rows.push(['paper-date', scene.date, null]);
  for (const [, words, mark] of scene.lines) rows.push(['paper-line', words, mark]);
  for (const [cls, words, mark] of rows) {
    const line = el('div', cls);
    const span = el('span', 'w');
    span.append(text('span', 'ink', words));
    if (mark) span.append(el('i', `mark ${mark}`));
    line.append(span);
    page.append(line);
  }
  wrap.append(page);
  return wrap;
}

function writeIn(node, t, at, words) {
  const end = at + words.length * WRITE_S_PER_CHAR;
  node.querySelector('.ink').style.clipPath = `inset(-30% ${(1 - prog(t, at, end)) * 100}% -30% 0)`;
  const mark = node.querySelector('.mark');
  if (mark) mark.style.transform = `scaleX(${easeInOut(prog(t, end + 0.15, end + 0.55))})`;
}

function updatePaper(t, dur, scene) {
  const node = buildOnce(scene, () => buildPaper(scene));
  const page = node.querySelector('.paper');
  const k = easeOut(prog(t, 0, 0.9));
  const scale = 1 + PAPER_DRIFT * prog(t, 0, dur);
  page.style.opacity = k;
  page.style.transform = `translateY(${(1 - k) * 30}px) rotate(${PAPER_TILT_DEG}deg) scale(${scale})`;
  const date = node.querySelector('.paper-date');
  if (date) writeIn(date, t, 0.4, scene.date);
  node.querySelectorAll('.paper-line').forEach((line, i) => {
    const [at, words] = scene.lines[i];
    writeIn(line, t, at, words);
  });
  const out = easeInOut(prog(t, dur - 0.8, dur));
  node.style.opacity = 1 - out;
  node.style.filter = out > 0 ? `blur(${out * 10}px)` : 'none';
}

// ---------------------------------------------------------------- layout (the app, drawn as a diagram)

const DRAWER_W = 520;

function buildLayout(scene) {
  const wrap = el('div', 'layout-wrap');
  const win = el('div', 'lay-window');
  const bar = el('div', 'bar');
  bar.append(el('span', 'dot'), el('span', 'dot'), el('span', 'dot'), text('span', 'url', scene.url || APP_URL));
  const app = el('div', 'lay-app');

  const side = el('div', 'lay-side');
  side.append(text('div', 'lay-head', scene.title));
  for (const [time, title] of scene.sessions) {
    const row = el('div', 'lay-row');
    row.append(text('span', 'time', time), text('span', 'title', title));
    side.append(row);
  }

  const main = el('div', 'lay-main');
  main.append(text('div', 'lay-kicker', scene.sessions[0][0]), text('h2', '', scene.sessions[0][1]));
  const note = el('div', 'lay-note');
  note.append(text('div', 'lay-kicker', 'My notes'));
  for (const line of scene.notes) note.append(text('p', '', line));
  main.append(note);

  const drawer = el('div', 'lay-drawer');
  drawer.append(text('div', 'lay-kicker', 'Concierge'));
  for (const [who, words] of scene.chat) drawer.append(text('div', `bubble ${who}`, words));

  const strip = el('div', 'lay-strip');
  for (const tab of scene.tabs) {
    const handle = el('div', 'lay-tab');
    handle.append(text('span', '', tab.handle));
    if (tab.name) handle.append(text('b', 'lay-name', tab.name));
    strip.append(handle);
  }

  const callout = el('div', 'lay-callout');
  app.append(side, main, drawer, strip, callout);
  win.append(bar, app);
  wrap.append(win);
  return wrap;
}

function updateLayout(t, dur, scene) {
  const node = buildOnce(scene, () => buildLayout(scene));
  const beats = scene.beats;
  rise(node.querySelector('.lay-window'), t, 0, 0.6, 24);

  const noteOn = prog(t, beats.notes, beats.notes + 0.4) * (1 - prog(t, beats.concierge, beats.concierge + 0.4));
  node.querySelector('.lay-note').style.borderColor = noteOn > 0.5 ? 'var(--ink)' : 'var(--line)';

  const open = easeInOut(prog(t, beats.open, beats.open + 0.6)) * (1 - easeInOut(prog(t, beats.close, beats.close + 0.6)));
  node.querySelector('.lay-drawer').style.transform = `translateX(${(1 - open) * (DRAWER_W + 2)}px)`;
  node.querySelectorAll('.bubble').forEach((b, i) => rise(b, t, beats.open + 0.5 + i * 0.5, 0.45, 12));
  node.querySelector('.lay-strip').style.right = `${open * DRAWER_W}px`;

  node.querySelectorAll('.lay-tab').forEach((handle, i) => {
    const tab = scene.tabs[i];
    const k = easeOut(prog(t, tab.at, tab.at + 0.5));
    handle.style.opacity = k;
    handle.style.transform = `translateX(${(1 - k) * 60}px)`;
    const lit = tab.lit && t >= tab.lit[0] && t <= tab.lit[1];
    handle.classList.toggle('lit', Boolean(lit));
    const name = handle.querySelector('.lay-name');
    if (name) rise(name, t, tab.at + 0.25, 0.5, 10);
  });

  const callout = node.querySelector('.lay-callout');
  const active = (scene.callouts || []).find(([a, b]) => t >= a && t <= b);
  if (active) {
    const [a, b, words, x, y] = active;
    callout.textContent = words;
    callout.style.left = `${x}px`;
    callout.style.top = `${y}px`;
    callout.style.opacity = easeOut(prog(t, a, a + 0.35)) * (1 - easeInOut(prog(t, b - 0.3, b)));
  } else {
    callout.style.opacity = 0;
  }
  sceneFade(node, t, dur, 0.5);
}

// ---------------------------------------------------------------- statement (one centred card)

function buildStatement(scene) {
  const wrap = el('div', 'center-col');
  if (scene.label) wrap.append(text('div', 'label', scene.label));
  const card = el('div', 'statement');
  card.append(text('h3', '', scene.title));
  for (const line of scene.lines || []) card.append(text('p', '', line));
  wrap.append(card);
  if (scene.button) wrap.append(text('div', 'primary', scene.button));
  if (scene.footnote) wrap.append(text('div', 'footnote', scene.footnote));
  return wrap;
}

function updateStatement(t, dur, scene) {
  const node = buildOnce(scene, () => buildStatement(scene));
  const label = node.querySelector('.label');
  if (label) rise(label, t, 0.1, 0.6, 14);
  rise(node.querySelector('.statement'), t, 0.25, 0.65, 30);
  const button = node.querySelector('.primary');
  if (button) rise(button, t, 1.0, 0.6, 14);
  const foot = node.querySelector('.footnote');
  if (foot) rise(foot, t, 1.3, 0.6, 10);
  sceneFade(node, t, dur, 0.5);
}

// ---------------------------------------------------------------- cards3 (closing cards)

function buildCards3(scene) {
  const wrap = el('div', 'center-col');
  if (scene.kicker) wrap.append(text('div', 'label', scene.kicker));
  const row = el('div', 'row3');
  for (const card of scene.cards) {
    const box = el('div', 'card3');
    box.append(text('div', 'k', card.label), text('h3', '', card.title));
    const list = el('ul');
    for (const item of card.items) list.append(text('li', '', item));
    box.append(list);
    row.append(box);
  }
  wrap.append(row);
  if (scene.proof) {
    const proof = el('div', 'proof');
    proof.innerHTML = scene.proof; // authored storyboard markup (code spans), not user data
    wrap.append(proof);
  }
  if (scene.button) wrap.append(text('div', 'primary', scene.button));
  return wrap;
}

function updateCards3(t, dur, scene) {
  const node = buildOnce(scene, () => buildCards3(scene));
  const label = node.querySelector('.label');
  if (label) rise(label, t, 0.15, 0.6, 14);
  node.querySelectorAll('.card3').forEach((card, i) => rise(card, t, 0.4 + i * 0.25, 0.65, 36));
  const proof = node.querySelector('.proof');
  if (proof) rise(proof, t, 2.0, 0.6, 14);
  const button = node.querySelector('.primary');
  if (button) rise(button, t, 2.5, 0.6, 14);
  sceneFade(node, t, dur, 0.5);
}

// ---------------------------------------------------------------- credits

function buildCredits(scene) {
  const wrap = el('div', 'center-col');
  const brand = el('div', 'brand');
  if (BRANDMARK) {
    const img = el('img');
    img.src = BRANDMARK;
    img.alt = '';
    brand.append(img);
  }
  brand.append(document.createTextNode(scene.brand));
  wrap.append(brand, el('div', 'rule'));
  if (scene.tag) wrap.append(text('div', 'tag', scene.tag));
  const line = el('div', 'music');
  line.innerHTML = scene.line; // authored storyboard markup (<b>), not user data
  wrap.append(line);
  if (scene.footnote) wrap.append(text('div', 'footnote', scene.footnote));
  return wrap;
}

function updateCredits(t, dur, scene) {
  const node = buildOnce(scene, () => buildCredits(scene));
  rise(node.querySelector('.brand'), t, 0.1, 0.7, 24);
  node.querySelector('.rule').style.transform = `scaleX(${easeInOut(prog(t, 0.5, 1.4))})`;
  const tag = node.querySelector('.tag');
  if (tag) rise(tag, t, 0.5, 0.6, 12);
  rise(node.querySelector('.music'), t, 0.6, 0.7, 18);
  const foot = node.querySelector('.footnote');
  if (foot) rise(foot, t, 1.5, 0.6, 10);
  sceneFade(node, t, dur, 0.8);
}

// ---------------------------------------------------------------- captions

const caption = el('div');
caption.id = 'caption';
caption.append(el('div', 'chip'), el('div', 'text'));
stage.appendChild(caption);
const CUES = buildCues();

function updateCaption(t) {
  const cue = CUES.find((c) => t >= c[0] && t < c[1]);
  if (!cue) {
    caption.style.opacity = 0;
    return;
  }
  const [start, end, chip, words] = cue;
  const scene = SCENES.find((s) => s.kind === 'footage' && Math.abs(s.start - start) < 1e-6);
  const prev = SCENES[scene.index - 1];
  const next = SCENES[scene.index + 1];
  const kin = prev && prev.kind === 'footage' ? 1 : easeOut(prog(t, start + 0.1, start + 0.45));
  const kout = next && next.kind === 'footage' ? 1 : 1 - easeInOut(prog(t, end - 0.25, end));
  const swap = prev && prev.kind === 'footage' ? easeOut(prog(t, start, start + 0.3)) : 1;
  caption.style.opacity = kin * kout * swap;
  caption.style.transform = `translateY(${(1 - kin) * 12}px)`;
  caption.querySelector('.chip').textContent = chip;
  caption.querySelector('.text').textContent = words;
}

// ---------------------------------------------------------------- frame entry point

const UPDATERS = {
  cards: updateCards,
  code: updateCode,
  chapter: updateChapter,
  footage: updateFootage,
  placeholder: updatePlaceholder,
  paper: updatePaper,
  layout: updateLayout,
  statement: updateStatement,
  cards3: updateCards3,
  credits: updateCredits,
};

function sceneAt(t) {
  return SCENES.find((s) => t >= s.start && t < s.start + s.dur) || SCENES[SCENES.length - 1];
}

window.renderFrame = async function renderFrame(i) {
  const t = i / FPS;
  const scene = sceneAt(t);
  for (const [kind, node] of Object.entries(roots)) node.style.display = kind === scene.kind ? 'block' : 'none';
  root(scene.kind).style.display = 'block';
  await UPDATERS[scene.kind](t - scene.start, scene.dur, scene);
  updateCaption(t);
  return scene.kind;
};

window.TOTAL_FRAMES = TOTAL_FRAMES;
window.ENDING_START_FRAME = ENDING_START_FRAME;
window.exportCues = () => CUES;
window.exportVoiceover = () => buildVoiceover();
window.exportScenes = () =>
  SCENES.map((s) => ({
    kind: s.kind,
    id: s.id || null,
    start: s.start,
    dur: s.dur,
    src: s.src || null,
    parts: s.parts || null,
    zooms: s.zooms || null,
  }));
