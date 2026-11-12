// Kinetic type with GSAP: the `hook` scene, an explosive title for the first seconds.
//
//   hook  words [[at, text, {brand, size}]]: each word slams in from behind the camera at `at` (letters burst in
//         with an overshoot, a seeded camera shake, a shock ring and sparks), and is blown apart when the next
//         word lands. The last word holds, then shatters towards the camera at `outAt` (default dur - 0.5).
//         `brand: true` sets a word in the brand's mono face. seed (default 7) fixes every random choice.
//
// Determinism: one paused GSAP timeline per scene, sought with tl.seek(t) on every frame; GSAP's own ticker never
// drives it. Per-letter scatter, the shake and the sparks come from seeded(), never Math.random.

gsap.registerPlugin(SplitText);
gsap.defaults({ lazy: false }); // a lazy first render waits for GSAP's ticker; a seek must draw at once

const HOOK_LAND_S = 0.42; // a word's letters burst in over this long
const HOOK_STAGGER_S = 0.026;
const HOOK_BLAST_S = 0.38; // a word is blown apart over this long
const HOOK_SHAKE_PX = 26;
const HOOK_SHAKE_DECAY = 7.5; // per second
const HOOK_SHAKE_HZ = 34;
const HOOK_SPARKS = 22;
const HOOK_SPARK_S = 0.6;
const HOOK_RING_S = 0.7;
const HOOK_IMPACT_DELAY_S = 0.16; // the slam lands a beat after a word starts

function hookWords(scene) {
  return scene.words.map(([at, words, opts = {}]) => ({ at, words, ...opts }));
}

function buildHook(scene) {
  const wrap = el('div', 'hook-wrap');
  const cam = el('div', 'hook-cam');
  const ring = el('div', 'hook-ring');
  const sparks = el('div', 'hook-sparks');
  for (let i = 0; i < HOOK_SPARKS; i++) sparks.append(el('i'));
  cam.append(ring, sparks);
  const words = hookWords(scene);
  for (const word of words) {
    const node = text('div', word.brand ? 'hook-word brand-word' : 'hook-word', word.words);
    if (word.size) node.style.fontSize = `${word.size}px`;
    cam.append(node);
  }
  wrap.append(cam, el('div', 'hook-flash'));
  return wrap;
}

// The paused master timeline: letters in, letters blown out, all from seeded scatter.
function hookTimeline(scene, node) {
  const rand = seeded(scene.seed ?? 7);
  const words = hookWords(scene);
  const outAt = scene.outAt ?? scene.dur - 0.5;
  const tl = gsap.timeline({ paused: true });
  node.querySelectorAll('.hook-word').forEach((wordNode, w) => {
    const split = new SplitText(wordNode, { type: 'chars', charsClass: 'hook-char' });
    const chars = split.chars;
    const scatter = chars.map(() => ({
      x: (rand() - 0.5) * 1400,
      y: (rand() - 0.5) * 900,
      rot: (rand() - 0.5) * 140,
      z: 300 + rand() * 900,
    }));
    const at = words[w].at;
    const leave = w + 1 < words.length ? words[w + 1].at : outAt;
    tl.set(wordNode, { autoAlpha: 1 }, at);
    tl.fromTo(
      chars,
      { opacity: 0, z: 1600, yPercent: (i) => (scatter[i].y / 900) * 60, rotationX: -50, filter: 'blur(14px)' },
      {
        opacity: 1,
        z: 0,
        yPercent: 0,
        rotationX: 0,
        filter: 'blur(0px)',
        duration: HOOK_LAND_S,
        ease: 'back.out(2.2)',
        stagger: { each: HOOK_STAGGER_S, from: 'center' },
      },
      at,
    );
    // fromTo with the landed pose, not to(): a to() tween records its start values the first time it renders,
    // so a render chunk that starts mid-scene would blow the letters apart from a different pose than a
    // sequential render does.
    tl.fromTo(
      chars,
      { x: 0, y: 0, z: 0, rotation: 0, opacity: 1, filter: 'blur(0px)', immediateRender: false },
      {
        x: (i) => scatter[i].x,
        y: (i) => scatter[i].y,
        z: (i) => scatter[i].z,
        rotation: (i) => scatter[i].rot,
        opacity: 0,
        filter: 'blur(10px)',
        duration: HOOK_BLAST_S,
        ease: 'power3.in',
        stagger: { each: 0.008, from: 'center' },
      },
      leave - 0.1,
    );
    tl.set(wordNode, { autoAlpha: 0 }, leave + HOOK_BLAST_S);
  });
  tl.seek(0);
  return tl;
}

const hookState = new Map(); // scene index -> { tl, impacts, sparks, noise }

function hookSetup(scene, node) {
  if (hookState.has(scene.index)) return hookState.get(scene.index);
  const rand = seeded((scene.seed ?? 7) + 101);
  const impacts = hookWords(scene).map((w) => w.at + HOOK_IMPACT_DELAY_S);
  const sparks = Array.from({ length: HOOK_SPARKS }, () => ({
    angle: rand() * Math.PI * 2,
    reach: 260 + rand() * 520,
    len: 14 + rand() * 46,
  }));
  const state = {
    tl: hookTimeline(scene, node),
    impacts,
    sparks,
    noiseX: noiseTable((scene.seed ?? 7) + 11),
    noiseY: noiseTable((scene.seed ?? 7) + 23),
    noiseR: noiseTable((scene.seed ?? 7) + 37),
  };
  hookState.set(scene.index, state);
  return state;
}

function updateHook(t, dur, scene) {
  const node = buildOnce(scene, () => buildHook(scene));
  const state = hookSetup(scene, node);
  // Replay from zero every frame: overlapping tweens on the same letters otherwise depend on which times were
  // sought before, and a render chunk that starts mid-scene has sought none of them.
  state.tl.seek(0, false);
  state.tl.seek(t, false);

  // Seeded camera shake: every impact kicks it, and it decays.
  const last = state.impacts.filter((at) => t >= at).pop();
  const kick = last === undefined ? 0 : Math.exp(-(t - last) * HOOK_SHAKE_DECAY);
  const n = t * HOOK_SHAKE_HZ;
  const cam = node.querySelector('.hook-cam');
  cam.style.transform =
    `translate(${state.noiseX(n) * HOOK_SHAKE_PX * kick}px, ${state.noiseY(n) * HOOK_SHAKE_PX * kick}px) ` +
    `rotate(${state.noiseR(n) * 1.4 * kick}deg) scale(${1 + 0.035 * kick})`;

  // A shock ring and sparks from the latest impact.
  const since = last === undefined ? Infinity : t - last;
  const ring = node.querySelector('.hook-ring');
  const kr = prog(since, 0, HOOK_RING_S);
  ring.style.opacity = since === Infinity ? 0 : (1 - kr) * 0.9;
  ring.style.transform = `translate(-50%, -50%) scale(${0.2 + easeOut(kr) * 2.6})`;
  const ks = prog(since, 0, HOOK_SPARK_S);
  node.querySelectorAll('.hook-sparks i').forEach((spark, i) => {
    const s = state.sparks[i];
    const d = easeOut(ks) * s.reach;
    spark.style.opacity = since === Infinity ? 0 : 1 - ks;
    spark.style.width = `${s.len * (1 - ks * 0.7)}px`;
    spark.style.transform = `rotate(${s.angle}rad) translateX(${120 + d}px)`;
  });

  // A white flash on each impact, two frames long, and the last word's shatter fades to black.
  node.querySelector('.hook-flash').style.opacity = since < 2 / FPS ? 0.12 : 0;
  const outAt = scene.outAt ?? dur - 0.5;
  node.style.opacity = 1 - easeInOut(prog(t, outAt + 0.15, dur));
}

UPDATERS.hook = updateHook;
