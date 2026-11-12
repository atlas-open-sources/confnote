// Lays out a storyboard (window.STORY, loaded before this file) into absolute times.
// One source of truth for the renderer, the on-screen captions, the .srt and the voice cues.

const STORY = window.STORY;
const FPS = STORY.fps || 30;
const SRC_FPS = STORY.srcFps || 25;
const SRC_W = 1920;
const SRC_H = 1080;
const SRC_BAND_H = 936; // the footage window shows a 1920x936 band at zoom 1
const ALL = { x: 0, y: 0, z: SRC_BAND_H / SRC_H }; // zoom that shows the whole 1080p frame
const CHAPTERS = STORY.chapters || {};
const VOICE = { ...(STORY.voice || {}) };
const APP_URL = STORY.appUrl || '';

// The ending is a list of segments in its own file (window.ENDING, see ending.sample.js), so it can be swapped,
// reordered or re-voiced and re-rendered on its own (`render.py video --part ending`). A segment is a scene plus
// `id`, `enabled` and `voice: [[offset, block, text]]`; its lines join the narration like any other block.
const ENDING_SEGMENTS = ((window.ENDING && window.ENDING.segments) || []).filter((s) => s.enabled !== false);
for (const segment of ENDING_SEGMENTS) {
  segment.ending = true;
  segment.vo = (segment.voice || []).map(([offset, n]) => [offset, n]);
  for (const [, n, words] of segment.voice || []) VOICE[n] = words;
}
const SCENES = STORY.scenes.concat(ENDING_SEGMENTS);

function footageDuration(scene) {
  return scene.parts.reduce((sum, [from, to, speed]) => sum + (to - from) / speed, 0);
}

function layoutTimeline() {
  let t = 0;
  SCENES.forEach((scene, i) => {
    if (scene.kind === 'footage') scene.dur = footageDuration(scene);
    scene.start = t;
    scene.index = i;
    t += scene.dur;
  });
  return t;
}

const TOTAL_SECONDS = layoutTimeline();
const TOTAL_FRAMES = Math.round(TOTAL_SECONDS * FPS);
const ENDING_START_FRAME = ENDING_SEGMENTS.length ? Math.round(ENDING_SEGMENTS[0].start * FPS) : TOTAL_FRAMES;

function chapterLabel(n) {
  return `${n} · ${CHAPTERS[n].title}`;
}

// On-screen captions, footage only: [start, end, chip, text].
function buildCues() {
  return SCENES.filter((s) => s.kind === 'footage' && s.caption).map((s) => [
    s.start,
    s.start + s.dur,
    chapterLabel(s.chapter),
    s.caption,
  ]);
}

// Voice blocks in absolute seconds: [n, cue, heading, text].
function buildVoiceover() {
  const blocks = [];
  for (const scene of SCENES) {
    let heading = `${scene.kind} (motion)`;
    if (scene.kind === 'footage') heading = chapterLabel(scene.chapter);
    else if (scene.ending) heading = `ending: ${scene.id}`;
    for (const [offset, n] of scene.vo || []) blocks.push([n, scene.start + offset, heading, VOICE[n]]);
  }
  return blocks;
}
