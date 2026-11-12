// The `three` scene: real 3D with three.js, lit by a CC0 Poly Haven HDRI, built from CC0 Poly Haven models
// (assets/LICENCES.md). Two rigs, picked with `rig`:
//
//   three rig: 'hall'  a conference hall in confnote's dark tokens: rows of chairs (Poly Haven monobloc chair), a
//                      seeded audience in silhouette, a stage with a lit edge, the screen showing the event.
//                      screen {kicker, title, sub}, rows (default 11), seats (per side, default 7), seed,
//                      camera [[t, [x, y, z], [tx, ty, tz]]] (default: down the aisle towards the stage)
//          rig: 'desk' the notebook (Poly Haven binder notebook) and the laptop (Poly Haven classic laptop, its screen
//                      showing confnote, drawn here) on a dark desk; cards rise off the desk and fan out above it.
//                      cards [{label, title}], cardsAt (s), screen {title, lines}, title, sub (a caption over the
//                      shot, from titleAt), camera (as above; default a slow orbit and push)
//
// Determinism: no requestAnimationFrame, no Clock. renderFrame sets every transform from the scene time t, runs
// glTF animations with mixer.setTime(t), and renders once. Every model, the HDRI and the canvases are loaded before
// window.KIT_READY. The canvas keeps its drawing buffer (preserveDrawingBuffer) for the screenshot.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

const HDRI = 'hdri/events_hall_interior_1k.hdr';
const MODELS = {
  chair: 'models/plastic_monobloc_chair_01/plastic_monobloc_chair_01.gltf',
  laptop: 'models/classic_laptop/classic_laptop.gltf',
  notebook: 'models/binder_notebook/binder_notebook.gltf',
};
const RIG_MODELS = { hall: ['chair'], desk: ['laptop', 'notebook'] };
const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif';
const FADE_IN_S = 0.35;
const FADE_OUT_S = 0.4;

const loaded = { env: null, models: {} };
let renderer = null;

// ---------------------------------------------------------------- shared helpers

function canvasTexture(width, height, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d'), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function interpolateCamera(keys, t) {
  if (t <= keys[0][0]) return keys[0];
  const last = keys[keys.length - 1];
  if (t >= last[0]) return last;
  let i = 0;
  while (t > keys[i + 1][0]) i++;
  const k = easeInOut(prog(t, keys[i][0], keys[i + 1][0]));
  const mixV = (a, b) => a.map((v, c) => lerp(v, b[c], k));
  return [t, mixV(keys[i][1], keys[i + 1][1]), mixV(keys[i][2], keys[i + 1][2])];
}

function placeCamera(camera, keys, t) {
  const [, eye, target] = interpolateCamera(keys, t);
  camera.position.set(...eye);
  camera.lookAt(...target);
}

function mixersFor(gltf, root) {
  if (!gltf.animations.length) return [];
  const mixer = new THREE.AnimationMixer(root);
  for (const clip of gltf.animations) mixer.clipAction(clip).play();
  return [mixer];
}

// ---------------------------------------------------------------- rig: hall

function screenTexture(screen) {
  return canvasTexture(1920, 1080, (g, w, h) => {
    g.fillStyle = '#0a0a0a';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#2e2e2e';
    g.lineWidth = 6;
    g.strokeRect(40, 40, w - 80, h - 80);
    g.textAlign = 'center';
    g.fillStyle = '#8f8f8f';
    g.font = `600 64px ${MONO}`;
    g.fillText((screen.kicker || '').toUpperCase(), w / 2, h / 2 - 190);
    g.fillStyle = '#ffffff';
    g.font = `600 220px ${SANS}`;
    g.fillText(screen.title || '', w / 2, h / 2 + 60);
    g.fillStyle = '#8f8f8f';
    g.font = `400 70px ${SANS}`;
    g.fillText(screen.sub || '', w / 2, h / 2 + 200);
  });
}

function emissiveBox(w, h, d, intensity = 1) {
  return new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(intensity, intensity, intensity) }),
  );
}

function buildHall(scene) {
  const world = new THREE.Scene();
  world.background = new THREE.Color(0x000000);
  world.fog = new THREE.Fog(0x000000, 12, 46);
  world.environment = loaded.env;
  world.environmentIntensity = 0.18;
  const rand = seeded(scene.seed ?? 5);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(44, 80),
    new THREE.MeshStandardMaterial({ color: 0x080808, roughness: 0.7, metalness: 0.0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.z = -10;
  world.add(floor);

  const stage = new THREE.Mesh(
    new THREE.BoxGeometry(18, 0.9, 6),
    new THREE.MeshStandardMaterial({ color: 0x101010, roughness: 0.7 }),
  );
  stage.position.set(0, 0.45, -22);
  world.add(stage);
  const edge = emissiveBox(18, 0.03, 0.03, 0.85);
  edge.position.set(0, 0.92, -19);
  world.add(edge);

  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(12.8, 7.2),
    new THREE.MeshBasicMaterial({ map: screenTexture(scene.screen || {}), toneMapped: false, fog: false }),
  );
  screen.position.set(0, 5.6, -24.6);
  world.add(screen);
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(44, 16), new THREE.MeshStandardMaterial({ color: 0x050505 }));
  wall.position.set(0, 8, -24.8);
  world.add(wall);

  // Ceiling light lines and wall slats: the hall's depth, drawn in the app's line and ink.
  for (let z = -22; z <= 14; z += 3) {
    const strip = emissiveBox(14, 0.04, 0.12, 0.16);
    strip.position.set(0, 9.2, z);
    world.add(strip);
    for (const side of [-1, 1]) {
      const slat = emissiveBox(0.05, 5.5, 0.05, 0.07);
      slat.position.set(side * 13, 3.6, z);
      world.add(slat);
    }
  }

  // Rows of chairs, one instanced mesh, in the app's greys rather than the model's plastic.
  const chair = loaded.models.chair.scene.getObjectByProperty('type', 'Mesh');
  const rows = scene.rows ?? 14;
  const seats = scene.seats ?? 7;
  const chairs = new THREE.InstancedMesh(
    chair.geometry,
    new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.45, metalness: 0.05 }),
    rows * seats * 2,
  );
  const people = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0));
  let n = 0;
  for (let r = 0; r < rows; r++) {
    for (const side of [-1, 1]) {
      for (let s = 0; s < seats; s++) {
        const x = side * (1.25 + s * 0.68);
        const z = -15 + r * 1.2;
        m.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(1, 1, 1));
        chairs.setMatrixAt(n++, m);
        if (rand() < 0.68) people.push([x + (rand() - 0.5) * 0.06, z + 0.05, 0.92 + rand() * 0.16]);
      }
    }
  }
  world.add(chairs);

  // The audience in silhouette: a body and a head per person, rim-lit by the screen.
  const silhouette = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.75 });
  const bodies = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.21, 0.46, 4, 12), silhouette, people.length);
  const heads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.12, 16, 12), silhouette, people.length);
  people.forEach(([x, z, h], i) => {
    m.makeTranslation(x, 0.62 + 0.3 * h, z);
    bodies.setMatrixAt(i, m);
    m.makeTranslation(x, 1.2 * h + 0.2, z - 0.02);
    heads.setMatrixAt(i, m);
  });
  world.add(bodies, heads);

  world.add(new THREE.HemisphereLight(0xffffff, 0x000000, 0.12));
  // The screen's spill: rims the audience's heads and shoulders, so they read as silhouettes against it.
  const glow = new THREE.PointLight(0xffffff, 260, 46, 1.4);
  glow.position.set(0, 5.4, -21.5);
  world.add(glow);
  for (const x of [-5, 5]) {
    const spot = new THREE.SpotLight(0xffffff, 420, 30, 0.32, 0.6, 1.3);
    spot.position.set(x, 10, -15);
    spot.target.position.set(x * 0.25, 0.9, -22);
    world.add(spot, spot.target);
  }

  const camera = new THREE.PerspectiveCamera(40, 1920 / 1080, 0.1, 120);
  const keys = scene.camera || [
    [0, [0.5, 1.75, 9], [0, 3.6, -24]],
    [scene.dur, [0.1, 1.6, -1], [0, 4.4, -24]],
  ];
  return { world, camera, keys, mixers: [], update: () => {} };
}

// ---------------------------------------------------------------- rig: desk

function laptopScreenTexture(screen) {
  return canvasTexture(1600, 1000, (g, w, h) => {
    g.fillStyle = '#000000';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#0a0a0a';
    g.fillRect(0, 0, 360, h);
    g.fillStyle = '#2e2e2e';
    g.fillRect(360, 0, 2, h);
    g.fillRect(0, 70, w, 2);
    g.fillStyle = '#ffffff';
    g.font = `600 40px ${MONO}`;
    g.fillText('confnote', 34, 50);
    g.font = `500 26px ${MONO}`;
    g.fillStyle = '#666666';
    ['09:30', '10:15', '11:15', '12:00', '14:00', '15:30'].forEach((time, i) => {
      g.fillText(time, 34, 140 + i * 74);
      g.fillStyle = i === 1 ? '#ffffff' : '#8f8f8f';
      g.fillRect(130, 124 + i * 74, 190 - (i % 3) * 30, 18);
      g.fillStyle = '#666666';
    });
    g.fillStyle = '#ffffff';
    g.font = `600 64px ${SANS}`;
    g.fillText(screen.title || 'Beyond The Prompt', 420, 170);
    g.font = `400 34px ${SANS}`;
    g.fillStyle = '#8f8f8f';
    (screen.lines || ['My notes', 'Research', 'Transcript']).forEach((line, i) => {
      g.fillText(line, 420, 260 + i * 60);
    });
    g.strokeStyle = '#2e2e2e';
    g.lineWidth = 3;
    g.strokeRect(420, 470, 1120, 440);
    g.fillStyle = '#ffffff';
    for (let i = 0; i < 6; i++) g.fillRect(460, 520 + i * 62, 980 - (i % 3) * 160, 14);
  });
}

function cardTexture(card) {
  return canvasTexture(900, 570, (g, w, h) => {
    g.fillStyle = '#0a0a0a';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#2e2e2e';
    g.lineWidth = 8;
    g.strokeRect(4, 4, w - 8, h - 8);
    g.fillStyle = '#666666';
    g.font = `600 40px ${MONO}`;
    g.fillText((card.label || '').toUpperCase(), 60, 110);
    g.fillStyle = '#ffffff';
    g.font = `600 112px ${SANS}`;
    g.fillText(card.title || '', 60, 330);
    g.fillStyle = '#2e2e2e';
    g.fillRect(60, 400, w - 120, 4);
  });
}

const DEFAULT_CARDS = [
  { label: 'Module', title: 'tldraw' },
  { label: 'Module', title: 'Bryntum' },
  { label: 'Module', title: 'AG Grid' },
];
const CARD_RISE_S = 1.1;
const CARD_STAGGER_S = 0.22;

// The model's screen UVs point at a dark patch of its atlas; give the screen plane its own 0–1 UVs (x, y bounds).
function planarUvs(geometry) {
  const flat = geometry.clone();
  flat.computeBoundingBox();
  const { min, max } = flat.boundingBox;
  const pos = flat.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (pos.getX(i) - min.x) / (max.x - min.x);
    uv[i * 2 + 1] = (pos.getY(i) - min.y) / (max.y - min.y);
  }
  flat.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return flat;
}

const LAPTOP_SHELL = 0x3a3a3a; // the model's beige plastic, toned into the app's greys

function buildDesk(scene) {
  const world = new THREE.Scene();
  world.background = new THREE.Color(0x000000);
  world.fog = new THREE.Fog(0x000000, 2.2, 6);
  world.environment = loaded.env;
  world.environmentIntensity = 0.35;

  const desk = new THREE.Mesh(
    new THREE.PlaneGeometry(30, 30),
    new THREE.MeshStandardMaterial({ color: 0x080808, roughness: 0.42, metalness: 0.1 }),
  );
  desk.rotation.x = -Math.PI / 2;
  desk.receiveShadow = true;
  world.add(desk);

  const laptopGltf = loaded.models.laptop;
  const laptop = laptopGltf.scene.clone(true);
  const screenMap = laptopScreenTexture(scene.screen || {});
  laptop.traverse((node) => {
    if (!node.isMesh) return;
    node.castShadow = true;
    node.receiveShadow = true;
    if (node.material.name === 'classic_laptop_screen') {
      node.geometry = planarUvs(node.geometry);
      node.material = new THREE.MeshBasicMaterial({ map: screenMap, toneMapped: false });
    } else {
      node.material = node.material.clone();
      node.material.color = new THREE.Color(LAPTOP_SHELL);
    }
  });
  laptop.position.set(-0.05, 0, -0.05);
  laptop.rotation.y = 0.1;
  world.add(laptop);

  const notebook = loaded.models.notebook.scene.clone(true);
  const closed = notebook.getObjectByName('binder_notebook_closed');
  if (closed) closed.visible = false;
  notebook.traverse((node) => {
    if (node.isMesh) {
      node.castShadow = true;
      node.receiveShadow = true;
    }
  });
  notebook.scale.setScalar(1.6);
  notebook.position.set(0.6, 0, -0.08);
  notebook.rotation.y = -0.45;
  world.add(notebook);

  const cards = (scene.cards || DEFAULT_CARDS).map((card) => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.19, 0.004),
      new THREE.MeshStandardMaterial({ map: cardTexture(card), roughness: 0.6 }),
    );
    mesh.castShadow = true;
    world.add(mesh);
    return mesh;
  });

  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(-1.6, 2.6, 1.4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -1.5;
  key.shadow.camera.right = 1.5;
  key.shadow.camera.top = 1.5;
  key.shadow.camera.bottom = -1.5;
  key.shadow.bias = -0.0004;
  world.add(key);
  const rim = new THREE.SpotLight(0xffffff, 18, 6, 0.6, 0.8, 1.2);
  rim.position.set(1.2, 1.4, -1.6);
  rim.target.position.set(0, 0.2, 0);
  world.add(rim, rim.target);

  const camera = new THREE.PerspectiveCamera(34, 1920 / 1080, 0.02, 40);
  // The shot sits right of centre, leaving the lower left for the caption.
  const keys = scene.camera || [
    [0, [-1.15, 0.9, 1.7], [-0.32, 0.3, -0.05]],
    [scene.dur, [0.05, 0.78, 1.75], [-0.3, 0.36, -0.1]],
  ];
  const cardsAt = scene.cardsAt ?? 0.5;
  const n = cards.length;
  const update = (t) => {
    cards.forEach((card, i) => {
      const k = easeInOut(prog(t, cardsAt + i * CARD_STAGGER_S, cardsAt + i * CARD_STAGGER_S + CARD_RISE_S));
      const side = i - (n - 1) / 2;
      const rest = new THREE.Vector3(-0.62 + i * 0.012, 0.004 + i * 0.005, 0.34 - i * 0.01);
      const up = new THREE.Vector3(side * 0.36, 0.66 - Math.abs(side) * 0.07, -0.28 - Math.abs(side) * 0.04);
      card.position.lerpVectors(rest, up, k);
      card.position.y += Math.sin(t * 1.7 + i * 1.3) * 0.006 * k;
      card.rotation.set(lerp(-Math.PI / 2, -0.12, k), lerp(0.4, -side * 0.32, k), lerp(0.2, 0, k));
    });
  };
  return { world, camera, keys, mixers: [...mixersFor(laptopGltf, laptop)], update };
}

// ---------------------------------------------------------------- the scene kind

const RIGS = { hall: buildHall, desk: buildDesk };
const rigs = new Map();

function buildThreeRoot() {
  const host = root('three');
  host.classList.add('three-scene');
  host.append(renderer.domElement);
  const caption = el('div', 'three-caption');
  caption.append(el('div', 'label'), el('h2'));
  host.append(caption);
  return host;
}

function updateThree(t, dur, scene) {
  if (!rigs.has(scene.index)) rigs.set(scene.index, RIGS[scene.rig || 'hall'](scene));
  const rig = rigs.get(scene.index);
  const host = root('three');
  rig.update(t);
  for (const mixer of rig.mixers) mixer.setTime(t);
  placeCamera(rig.camera, rig.keys, t);
  renderer.render(rig.world, rig.camera);

  const fade = easeOut(prog(t, 0, FADE_IN_S)) * (1 - easeInOut(prog(t, dur - FADE_OUT_S, dur)));
  renderer.domElement.style.opacity = fade;
  const caption = host.querySelector('.three-caption');
  caption.querySelector('.label').textContent = scene.sub || '';
  caption.querySelector('h2').textContent = scene.title || '';
  rise(caption, t, scene.titleAt ?? 0.8, 0.6, 24);
  caption.style.opacity = Number(caption.style.opacity) * fade;
  caption.style.display = scene.title || scene.sub ? 'flex' : 'none';
}

async function preload(threeScenes) {
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(1920, 1080, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  buildThreeRoot();

  const hdr = await new HDRLoader().loadAsync(asset(HDRI));
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  const pmrem = new THREE.PMREMGenerator(renderer);
  loaded.env = pmrem.fromEquirectangular(hdr).texture;
  hdr.dispose();
  pmrem.dispose();

  const names = new Set(threeScenes.flatMap((s) => RIG_MODELS[s.rig || 'hall'] || []));
  const loader = new GLTFLoader();
  await Promise.all(
    [...names].map(async (name) => {
      loaded.models[name] = await loader.loadAsync(asset(MODELS[name]));
    }),
  );
  // Build every rig now and draw it once, so textures and shaders are uploaded before the first frame.
  for (const scene of threeScenes) {
    const rig = RIGS[scene.rig || 'hall'](scene);
    rigs.set(scene.index, rig);
    renderer.compile(rig.world, rig.camera);
  }
}

const threeScenes = scenesOfKind('three');
if (threeScenes.length) KIT_PRELOADS.push(preload(threeScenes));
UPDATERS.three = updateThree;
