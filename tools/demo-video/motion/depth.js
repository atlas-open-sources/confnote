// Depth: CSS 3D motion for transitions, reveals, the opening and the close. Opt in with `STORY.depth = {}` (an
// object, optionally { enter, exit } in seconds). Loaded after scenes.js; every animation is still a pure
// function of the frame time.
//
// The rule (musa's seat, 2026-11-10): 3D is for transitions, reveals, the opening and the close, never for
// reading. Whenever the voice talks about a detail on screen, the window is flat and square-on. So:
//   - footage tilts only in its first DEPTH_IN_S seconds (the window swings in) and last DEPTH_OUT_S seconds (it
//     tilts back and floats away), and only at a section boundary (a new chapter, or a motion scene next door);
//   - callouts wait until the window is flat;
//   - `modules3d` fans real screens out in depth, then brings the chosen one forward until it is exactly the
//     next footage scene's first frame, so the cut into it is seamless and flat;
//   - paper, statement and cards3 scenes enter in depth and settle flat before their words are read.
//
// Scene kind added here:
//   modules3d  panels [{name, src, at, zoom, url}], focus (index of the panel that comes forward), fanAt, focusAt,
//              fanned (start already fanned out: a short scene that only brings the next module forward)
//              (the focused panel should show the next footage scene's first frame at its first zoom)

const DEPTH = STORY.depth || null;
const DEPTH_IN_S = (DEPTH && DEPTH.enter) || 0.7;
const DEPTH_OUT_S = (DEPTH && DEPTH.exit) || 0.55;
const PERSPECTIVE_PX = 2200;
const SWING_DEG = 26; // rotateY of a window swinging in or out
const SWING_TILT_DEG = 4; // a little rotateX, so it reads as floating, not sliding
const SWING_Z_PX = 420;
const SWING_X_PX = 240;
const FLAT_RAMP = 6; // callouts fade in over the last sixth of the swing
const FLOAT_SHADOW = '0 40px 120px rgba(0, 0, 0, 0.7)';

// Section boundaries, marked once on the scenes so the review page can list the 3D moments.
if (DEPTH) {
  for (const scene of SCENES) {
    if (scene.kind !== 'footage') continue;
    const prev = SCENES[scene.index - 1];
    const next = SCENES[scene.index + 1];
    scene.enter3d = !prev || (prev.kind === 'footage' ? prev.chapter !== scene.chapter : prev.kind !== 'modules3d');
    scene.exit3d = !next || next.kind !== 'footage' || next.chapter !== scene.chapter;
  }
}

// The footage window's pose at scene time t: { transform, opacity, shadow, flat (1 = square-on, 0 = tilted) }.
function windowDepth(scene, t, dur) {
  const away = scene.enter3d ? 1 - easeOut(prog(t, 0, DEPTH_IN_S)) : 0;
  const gone = scene.exit3d ? easeInOut(prog(t, dur - DEPTH_OUT_S, dur)) : 0;
  const tilt = away + gone;
  const rotY = (away - gone) * SWING_DEG;
  const x = (away - gone) * SWING_X_PX;
  const transform =
    `perspective(${PERSPECTIVE_PX}px) translateX(${x}px) translateZ(${-tilt * SWING_Z_PX}px) ` +
    `rotateY(${rotY}deg) rotateX(${tilt * SWING_TILT_DEG}deg)`;
  return {
    transform,
    opacity: Math.min(1, (1 - away) * 1.6) * (1 - gone * gone),
    shadow: tilt > 0.001 ? `${FLOAT_SHADOW}, var(--shadow-lg)` : '',
    flat: clamp01(1 - tilt * FLAT_RAMP), // reaches 1 only once the window is square-on
  };
}

// ---------------------------------------------------------------- modules3d (real screens, fanned in depth)

// Fanned: a triptych in depth. The middle panel is in front; the side panels sit behind it, turned in towards it,
// far enough apart that every panel and its name show and nothing leaves the frame.
const FAN_X_PX = 980;
const FAN_Z_PX = -2600;
const FAN_SIDE_Z_PX = -3000;
const FAN_ROT_DEG = 24;
const STACK_Z_PX = -2600;
const STACK_STEP_PX = 140;
const BACK_Z_PX = -3600;

function buildModules3d(scene) {
  const wrap = el('div', 'm3d-wrap');
  for (const panel of scene.panels) {
    const box = el('div', 'm3d-panel');
    const bar = el('div', 'bar');
    bar.append(el('span', 'dot'), el('span', 'dot'), el('span', 'dot'), text('span', 'url', panel.url || APP_URL));
    const view = el('div', 'view');
    const img = el('img');
    img.alt = '';
    view.append(img);
    // Each name is centred over its panel. The panels carry no float shadow: the middle one's would darken the
    // side panels' names behind it.
    box.append(bar, view, text('div', 'm3d-name', panel.name));
    wrap.append(box);
  }
  return wrap;
}

async function placePanelImage(img, panel) {
  const url = frameUrl(panel.src, panel.at);
  if (img.dataset.url !== url) {
    img.src = url;
    img.dataset.url = url;
    await img.decode();
  }
  const r = zoomAt({ zooms: [[0, panel.zoom || ALL]] }, 0);
  const s = (VIEW_W * r.z) / SRC_W;
  img.style.transform = `translate(${-r.x * s}px, ${-r.y * s}px) scale(${s})`;
}

function pose(x, z, rotY, opacity) {
  return { x, z, rotY, opacity };
}

function mix(a, b, k) {
  return pose(lerp(a.x, b.x, k), lerp(a.z, b.z, k), lerp(a.rotY, b.rotY, k), lerp(a.opacity, b.opacity, k));
}

async function updateModules3d(t, dur, scene) {
  const node = buildOnce(scene, () => buildModules3d(scene));
  const boxes = [...node.querySelectorAll('.m3d-panel')];
  const mid = (scene.panels.length - 1) / 2;
  const fanAt = scene.fanAt ?? 0.4;
  const focusAt = scene.focusAt ?? dur - 1.2;
  const rise3 = scene.fanned ? 1 : easeOut(prog(t, 0, 0.7));
  const fan = scene.fanned ? 1 : easeInOut(prog(t, fanAt, fanAt + 1.1));
  const appear = scene.fanned ? easeOut(prog(t, 0, 0.35)) : 1;
  const focus = easeInOut(prog(t, focusAt, focusAt + 1.0));
  await Promise.all(
    boxes.map(async (box, i) => {
      await placePanelImage(box.querySelector('img'), scene.panels[i]);
      const side = i - mid; // -1 left, 0 middle, 1 right
      const stacked = pose(0, STACK_Z_PX - i * STACK_STEP_PX, 0, rise3);
      const fanned = pose(side * FAN_X_PX, side ? FAN_SIDE_Z_PX : FAN_Z_PX, -side * FAN_ROT_DEG, 1);
      let p = mix(stacked, fanned, fan);
      const chosen = i === scene.focus;
      p = mix(p, chosen ? pose(0, 0, 0, 1) : pose(side * FAN_X_PX * 1.3, BACK_Z_PX, -side * FAN_ROT_DEG, 0), focus);
      box.style.transform = `translateX(${p.x}px) translateZ(${p.z}px) rotateY(${p.rotY}deg)`;
      box.style.opacity = p.opacity * appear;
      const name = box.querySelector('.m3d-name');
      const named = scene.fanned ? 1 : easeOut(prog(t, fanAt + 0.6, fanAt + 1.1));
      name.style.opacity = named * (1 - easeOut(prog(t, focusAt, focusAt + 0.4)));
    }),
  );
}

// ---------------------------------------------------------------- the opening and the close, in depth

const PAPER_TILT_X_DEG = [14, 6]; // from, to over the scene: a page on a desk, slowly lifting
const PAPER_TILT_Y_DEG = [-12, -4];
const PAPER_LINE_Z_PX = 26; // the writing floats a hair above the page: parallax as it turns

function paperDepth(t, dur, scene) {
  const node = built.get(scene.index);
  const page = node.querySelector('.paper');
  const p = prog(t, 0, dur);
  const k = easeOut(prog(t, 0, 0.9));
  const scale = 1 + PAPER_DRIFT * p;
  page.style.transform =
    `perspective(${PERSPECTIVE_PX}px) translateY(${(1 - k) * 30}px) ` +
    `rotateX(${lerp(PAPER_TILT_X_DEG[0], PAPER_TILT_X_DEG[1], p)}deg) ` +
    `rotateY(${lerp(PAPER_TILT_Y_DEG[0], PAPER_TILT_Y_DEG[1], p)}deg) rotateZ(${PAPER_TILT_DEG}deg) scale(${scale})`;
  page.style.transformStyle = 'preserve-3d';
  node.querySelectorAll('.paper-line, .paper-date').forEach((line) => {
    line.style.transform = `translateZ(${PAPER_LINE_Z_PX}px)`;
  });
}

const CARD_IN_DEG = 22;
const CARD_IN_Z_PX = 300;
const CARD_OUT_DEG = 12;
const CARD_OUT_Z_PX = 240;
const ENTER_S = 0.9;
const EXIT_S = 0.5;

// A centred card swings up out of depth, holds flat, and tips back as it leaves.
function cardDepth(node, t, dur, at = 0.15) {
  const k = easeOut(prog(t, at, at + ENTER_S));
  const out = easeInOut(prog(t, dur - EXIT_S, dur));
  node.style.transform =
    `perspective(${PERSPECTIVE_PX}px) translateZ(${-(1 - k) * CARD_IN_Z_PX - out * CARD_OUT_Z_PX}px) ` +
    `rotateX(${(1 - k) * CARD_IN_DEG - out * CARD_OUT_DEG}deg)`;
}

function statementDepth(t, dur, scene) {
  const node = built.get(scene.index);
  node.querySelector('.statement').style.filter = 'none';
  cardDepth(node.querySelector('.statement'), t, dur, 0.25);
  node.style.transformStyle = 'preserve-3d';
}

const STACK_STEP_Z_PX = 140;
const STACK_ROT_X_DEG = 18;
const STACK_ROT_Y_DEG = -14;
const UNSTACK_AT = 0.35;
const UNSTACK_STAGGER_S = 0.2;
const UNSTACK_S = 1.0;

// The closing cards start as a stack in depth, then deal out into their row, flat, before the voice reads them.
function cards3Depth(t, dur, scene) {
  const node = built.get(scene.index);
  const row = node.querySelector('.row3');
  const cards = [...row.querySelectorAll('.card3')];
  const centre = row.offsetLeft + row.offsetWidth / 2; // same offsetParent as the cards
  const out = easeInOut(prog(t, dur - EXIT_S, dur));
  cards.forEach((card, i) => {
    const at = UNSTACK_AT + i * UNSTACK_STAGGER_S;
    const k = easeInOut(prog(t, at, at + UNSTACK_S));
    const dx = centre - (card.offsetLeft + card.offsetWidth / 2);
    const fromStack = 1 - k;
    card.style.opacity = Math.min(1, prog(t, 0, 0.4) * 1.5);
    card.style.filter = 'none';
    card.style.transform =
      `perspective(${PERSPECTIVE_PX}px) translateX(${fromStack * dx}px) translateY(${fromStack * -i * 18}px) ` +
      `translateZ(${-fromStack * (i + 1) * STACK_STEP_Z_PX - out * CARD_OUT_Z_PX}px) ` +
      `rotateX(${fromStack * STACK_ROT_X_DEG - out * CARD_OUT_DEG}deg) rotateY(${fromStack * STACK_ROT_Y_DEG}deg)`;
    card.style.zIndex = String(cards.length - i);
  });
}

// ---------------------------------------------------------------- photo (a still in 2.5D parallax)
//
//   photo  src (asset), credit (shown bottom right, readable), label {title, sub} (bottom left, from labelAt),
//          fore [[x, y]...] (a polygon in 0–1 image units around the foreground; it is cut out with a feathered
//          edge and moves faster than the rest, so the still reads as depth), push [from, to] (scale over the
//          scene, default [1.16, 1.04]: it arrives pushed in, matching the map's whip, and settles), pan [dx, dy]
//          (px over the scene), whipIn (default 0.35 s of blur at the start)

const PHOTO_FORE_GAIN = 1.9; // the foreground's pan, relative to the background's
const PHOTO_FORE_PUSH = 0.035; // how much more the foreground grows over the scene
const PHOTO_FEATHER_PX = 14;

function featherMask(points) {
  const poly = points.map(([x, y]) => `${(x * 1000).toFixed(1)},${(y * 1000).toFixed(1)}`).join(' ');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" preserveAspectRatio="none">` +
    `<filter id="f"><feGaussianBlur stdDeviation="${PHOTO_FEATHER_PX / 2}"/></filter>` +
    `<polygon points="${poly}" fill="white" filter="url(#f)"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function buildPhoto(scene) {
  const wrap = el('div', 'photo-wrap');
  const url = asset(scene.src);
  const back = el('div', 'photo-layer');
  back.style.backgroundImage = `url("${url}")`;
  wrap.append(back);
  if (scene.fore) {
    const fore = el('div', 'photo-layer fore');
    fore.style.backgroundImage = `url("${url}")`;
    fore.style.maskImage = featherMask(scene.fore);
    fore.style.maskSize = '100% 100%';
    wrap.append(fore);
  }
  const label = el('div', 'photo-label');
  if (scene.label) label.append(text('b', '', scene.label.title || ''), text('span', '', scene.label.sub || ''));
  const credit = text('div', 'photo-credit', scene.credit || '');
  wrap.append(label, credit);
  return wrap;
}

async function updatePhoto(t, dur, scene) {
  const node = buildOnce(scene, () => buildPhoto(scene));
  const img = new Image();
  img.src = asset(scene.src);
  await img.decode(); // cached after the first frame
  const [from, to] = scene.push || [1.16, 1.04];
  const [dx, dy] = scene.pan || [-30, -8];
  const k = easeOut(prog(t, 0, dur));
  const back = node.querySelector('.photo-layer');
  const fore = node.querySelector('.photo-layer.fore');
  const scale = lerp(from, to, k);
  back.style.transform = `translate(${dx * k}px, ${dy * k}px) scale(${scale})`;
  if (fore) {
    // Near things grow and slide faster as the camera moves: the two layers start aligned and drift apart.
    const foreScale = scale * (1 + PHOTO_FORE_PUSH * k);
    fore.style.transform = `translate(${dx * k * PHOTO_FORE_GAIN}px, ${dy * k * PHOTO_FORE_GAIN}px) scale(${foreScale})`;
  }
  const whip = scene.whipIn ?? 0.35;
  const kw = whip > 0 ? easeOut(prog(t, 0, whip)) : 1;
  node.style.filter = kw < 1 ? `blur(${(1 - kw) * 16}px)` : 'none';
  // A match cut: it starts half lit and blurred, the way the map's whip leaves the frame, and sharpens.
  node.style.opacity = Math.min(1, 0.45 + kw) * (1 - easeInOut(prog(t, dur - 0.4, dur)));
  const label = node.querySelector('.photo-label');
  if (scene.label) rise(label, t, scene.labelAt ?? 0.35, 0.55, 18);
}

UPDATERS.photo = updatePhoto;

function withDepth(kind, after) {
  const base = UPDATERS[kind];
  UPDATERS[kind] = async (t, dur, scene) => {
    await base(t, dur, scene);
    after(t, dur, scene);
  };
}

UPDATERS.modules3d = updateModules3d;
if (DEPTH) {
  withDepth('paper', paperDepth);
  withDepth('statement', statementDepth);
  withDepth('cards3', cards3Depth);
}
