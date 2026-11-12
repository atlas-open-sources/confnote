# Demo video kit

The building blocks for confnote demo videos: record real takes on the site with Playwright, cut them in a motion
renderer that wears confnote's own look, voice them with Azure TTS, mix in a music bed, and check the result
for private data. The 2026-11-09 PayPal AI Hackathon submission was made with this kit.

Nothing personal lives here. The account email comes from `CONFNOTE_DEMO_EMAIL`, keys are read in-process, and
media (takes, frames, wavs, cuts) stays outside the repo, in the project's `artifacts/` or a scratch work folder.

| Folder | What |
|---|---|
| `record/` | `signin.py` (an off-camera sign-in to a saved session), `take.py` (take helpers), `paypal.py` (sandbox guest checkout), `take_sample.py` (a sample take) |
| `motion/` | The renderer: `index.html` + `timeline.js` + `scenes.js` + `depth.js` (CSS 3D motion, `photo`) + `kinetic.js` (`hook`, GSAP) + `map.js` (`map`, MapLibre) + `pencil.js` (`pencil`) + `three-scene.js` (`three`, three.js) + `style.css` (the app's dark tokens), driven by `render.py`. `vendor/` holds the libraries, unmodified, with their licences (`vendor/README.md`) |
| `assets/` | Media the scenes use: a Poly Haven HDRI and models, a paper scan, two photos of the venue, handwriting stroke data. `assets/LICENCES.md` has one row per asset with its source, licence and credit line |
| `voice/` | `tts.py` (Azure neural TTS), `lexicon.json` (checked pronunciations), `mix.py` (voice + ducked music bed), `check_transcript.py` |
| `gate/` | `privacy_gate.py`: OCR every frame and fail on the account's identifiers or any real email |
| `storyboard.sample.js` | A sample storyboard covering every scene kind |
| `ending.sample.js` | A sample ending: the closing screens as swappable segments |

## Setup

Run from the repo root, with the repo's venv (`make e2e-install` gives it Playwright and Chromium):

```sh
PY=packages/local-app/.venv/bin/python
KIT=tools/demo-video
WORK=../my-video-work        # outside the repo: takes, frames, chunks, wavs
export CONFNOTE_DEMO_EMAIL=… # the recording account (a staging user)
```

Also needed: `ffmpeg`, `tesseract` and, for voice, the `az` CLI signed in to the subscription with the Speech
resource. A `map` scene needs a network connection (OpenFreeMap tiles); everything else renders offline.

`render.py` serves the page from a localhost-only server that maps just the kit, the work frames and the
storyboard's folder (MapLibre's worker and three.js's modules do not load from `file://`). Chromium draws WebGL on
the GPU (ANGLE Metal); `DEMO_VIDEO_SOFTWARE_GL=1` falls back to SwiftShader, which is far slower. On the M5 the
v7 opening (hook, map, photo, hall, pencil, desk; 19.3 s) renders in about 29 s with 6 workers, 20 frames a second.
`stills` prints how long each frame took to draw. `mlx_whisper` is optional, for the transcript check. Pillow is needed only for `render.py frames --popup`.
`voice/mix.py` needs numpy, which the repo venv doesn't have: run it with a Python that does (the `mlx_whisper` tool's
own Python works).

## One command per stage

1. **Sign in, off camera.** Write the emailed code to `$WORK/.authkit-code` when the script prints `CODE SCREEN`.

   ```sh
   $PY $KIT/record/signin.py $WORK/state.json
   ```

2. **Record a take.** Copy `take_sample.py` for your story. Its `timeline.json` marks give the footage times.

   ```sh
   $PY $KIT/record/take_sample.py --state $WORK/state.json --out $WORK/take1 --record
   ```

3. **Extract frames.** Each take becomes a source id for the storyboard; `--popup` is for PayPal's popup video.

   ```sh
   $PY $KIT/motion/render.py frames --work $WORK --src a=$WORK/take1/video/<page>.webm
   ```

4. **Write the storyboard.** Start from `storyboard.sample.js`. Check scene times and stills as you go:

   ```sh
   $PY $KIT/motion/render.py stills --work $WORK --storyboard story.js --at 3,20,41.5 --out $WORK/stills
   ```

5. **Voice the narration.** Put the `voice` lines into `blocks-text.json` (`[{"n": 1, "text": "…"}]`). This also writes `speech-seconds.json`.

   ```sh
   CONFNOTE_TTS_ACCOUNT=<speech resource> CONFNOTE_TTS_GROUP=<resource group> \
     $PY $KIT/voice/tts.py blocks-text.json $WORK/voice
   ```

6. **Render the silent cut.**

   ```sh
   $PY $KIT/motion/render.py video --work $WORK --storyboard story.js --out $WORK/cut.mp4
   ```

7. **Write the captions and the voice cues.** This produces the narration `.srt`, the voiceover script and `blocks.json` for the mix.

   ```sh
   $PY $KIT/motion/render.py captions --work $WORK --storyboard story.js --speech $WORK/voice/speech-seconds.json \
     --srt cut.srt --vo voiceover.md --blocks $WORK/blocks.json
   ```

8. **Mix the voice and music.** The voice goes to −16 LUFS and the bed is ducked 9 dB under every line.

   ```sh
   $PY $KIT/voice/mix.py $WORK/blocks.json $WORK/voice music-bed.wav $WORK/cut.mp4 cut-voiced.mp4 $WORK/mix
   ```

9. **Check the transcript.** This never plays audio; it only transcribes.

   ```sh
   mlx_whisper cut-voiced.mp4 --word-timestamps True --output-format json --output-dir $WORK/stt
   $PY $KIT/voice/check_transcript.py $WORK/blocks.json $WORK/mix/placement.json $WORK/stt/cut-voiced.json
   ```

10. **Run the privacy gate.** Exit 0 is required before anything is published.

    ```sh
    $PY $KIT/gate/privacy_gate.py cut-voiced.mp4 $WORK/gate
    ```

Pass `--ending ending.js` to `scenes`, `stills`, `video` and `captions` when the story has a separate ending (next
section).

## Change the ending

The closing screens (hosted and BYOK, the Mac app, a promo, the music credit, the brand) live in their own file,
`window.ENDING = { segments: [...] }` (start from `ending.sample.js`). A segment is any scene kind plus:

- `id`: its name, shown in the voiceover script as `ending: <id>`;
- `enabled: false` to leave it out without deleting it;
- `voice: [[offset, block, "text"]]`: its narration. Use block numbers of 90 and up, one per line, so the story's
  blocks never move.

To swap, add, reorder or re-word a segment without re-rendering the story:

```sh
ARGS="--work $WORK --storyboard story.js --ending ending.js"
$PY $KIT/motion/render.py video $ARGS --part body --out $WORK/body.mp4      # once; keep it
$PY $KIT/motion/render.py video $ARGS --part ending --out $WORK/ending-2.mp4  # seconds
$PY $KIT/motion/render.py join --body $WORK/body.mp4 --ending-video $WORK/ending-2.mp4 --out cut-2.mp4
```

Then voice any new ending line (`tts.py blocks-text.json $WORK/voice 94`), and redo step 7 (captions) and step 8
(mix) on `cut-2.mp4`. Both are quick. The body only re-renders when a body scene changes, or when the ending gets
longer or shorter than a frame boundary allows (the join is a stream copy at `ENDING_START_FRAME`).

## Scene kinds

`scenes.js` lists each kind's fields. These are the ones beyond plain footage:

- `paper`: a handwritten page, written line by line. Use it for a memory (the v3 opening: notes on paper at the
  event). Marks are `strike` or `under`.
- `layout`: the app drawn as a diagram, the same frame as the footage window: the sidebar agenda, a session note, the
  Concierge drawer, and the right-edge strip whose tabs slide in at their `at` times with a name chip.
- `statement`: one centred card (label, title, lines, button). Most ending segments use it.
- Footage `masks: [[x, y, w, h, from?, to?]]`: blur boxes in source pixels that follow the zoom. Use them for private
  text that is on screen in a take you cannot re-record, such as an organiser's email in a public agenda JSON. The
  privacy gate must still pass on the result.

### The opening kinds (v7)

Each file's header lists every field; `storyboard.sample.js` opens with all of them, and
`artifacts/2026-11-12/motion-kit/opening-preview.js` is the v7 opening they were made for.

- `hook` (`kinetic.js`, GSAP): an explosive title. `words: [[at, text, {brand}]]` slam in one after another from
  behind the camera (letters burst in with an overshoot, a seeded camera shake, a shock ring, sparks, a two-frame
  flash), each blown apart by the next; the last shatters at `outAt`. Keep it to two or three short words, about
  0.75 s apart.
- `map` (`map.js`, MapLibre + OpenFreeMap): a camera flight with 3D buildings in the app's greys. `path: [[t, [lng,
  lat], zoom, pitch, bearing]]` (Catmull-Rom between keys); `venue: {lngLat, footprint, height, at, title, sub}`
  raises the venue's own building in white with a label. The credit "OpenFreeMap © OpenMapTiles Data from
  OpenStreetMap" is always in the corner. It ends on a whip (push and blur) for a match cut. Each frame waits for
  every tile in view, so the first render of a path is the slow one.
- `photo` (`depth.js`): a still in 2.5D. `fore` is a polygon (0–1 frame units) around the foreground, cut out with a
  feathered edge; it grows and slides faster than the rest, so the photo reads as depth. It starts blurred and half
  lit, to take the map's whip. `credit` stays on screen; `label` names the place.
- `three` (`three-scene.js`, three.js, a Poly Haven HDRI and CC0 models): real 3D. `rig: 'hall'` is a conference
  hall in silhouette (chairs, a seeded audience, the stage, a `screen` showing the event); `rig: 'desk'` is the
  notebook and the laptop (its screen drawn as confnote) with `cards` rising off the desk and fanning out above
  it, and an optional `title`/`sub` caption. `camera: [[t, [x, y, z], [tx, ty, tz]]]` overrides the default move.
- `pencil` (`pencil.js`): handwriting in pencil on paper. `lines: [[at, text, mark?]]` are written stroke by stroke
  (Tegaki's stroke order for Caveat, outlines by perfect-freehand), in graphite with a grainy, boiling edge over a
  paper scan, with a pencil following the point. `speed` 5 writes a 15-letter line in about a second. It replaces
  `paper` (the pen) for the origin.

Determinism holds for all of them: a GSAP timeline is paused and sought (`tl.seek(t)`), three.js sets every
transform from `t` and runs glTF animations with `mixer.setTime(t)`, the map is a function of its camera, and every
random choice comes from `seeded()` (scenes.js), never `Math.random`. Preloads (models, the HDRI, glyphs, the map
style) finish before `window.KIT_READY`, which `render.py` waits for.

Credits: a story that uses the map or a venue photo must carry their credit lines in its end card (they are listed
at the bottom of `assets/LICENCES.md`).

## Depth (3D motion)

`motion/depth.js` adds CSS 3D motion in confnote's own look: the same window, panels, lines and mono labels, moved
in perspective, with no new colours or surfaces. Turn it on with `depth: {}` in the storyboard (optionally
`{ enter, exit }` in seconds; defaults 0.7 and 0.55).

- **Section transitions:** at a chapter boundary (or next to a motion scene) the footage window tilts back and
  floats away with a soft shadow, and the next section's window swings in. Within a chapter, shots still cut with
  the plain crossfade.
- **`modules3d`:** a reveal of real screens. `panels: [{name, src, at, zoom, url}]` rise out of depth, fan into a
  triptych with their names above, then the `focus` panel comes forward flat while the others fall back. Give the
  focus panel the next footage scene's source, time and first zoom, so the cut into it is seamless.
- **One module at a time:** a short `modules3d` with `fanned: true` opens on the fan and brings the next module
  forward before its beat (v4: Bryntum before DevDay's Day view, AG Grid before the catalogue).
- **The opening and the close:** the `paper` page tilts in depth with its writing a hair above it (parallax),
  `statement` cards swing up out of depth and tip back as they leave, and `cards3` cards start as a stack in depth
  and deal out into their row.

The rule: 3D is for transitions, reveals, the opening and the close, never for reading. Whenever the voice talks
about a detail on screen, the window is flat and square-on. Callouts only show on a flat window, and motion cards
settle flat before their words are read. Every 3D moment goes on the per-shot review page (first, middle and last
frame), like any zoom.

## Pronunciation

`voice/lexicon.json` holds every word the voice gets wrong, as IPA (`ipa`), a spoken alias (`alias`) or a `say_as`
(e.g. `characters` for initialisms). `tts.py` applies it inline: whole words, longest first, in one pass. Azure's own
`<lexicon>` element needs a public URL, so it isn't used. Each entry notes what the voice said without it and what it
says now.

To add or change a word, synthesize a few variants in a carrier sentence ("Next, I tried X on my laptop.") and
transcribe each with `mlx_whisper` (large-v3-turbo) twice: unprompted, to hear it as a stranger would, and with the
vocabulary as `initial_prompt`, to check it is recognised. Never play them. Keep the variant whose unprompted
transcript is closest to the intended sound. Watch for aliases that start with a lone letter: "A G Grid" was read
as "a G-Grid".

The lexicon belongs to one voice (its `voice` field). The default voice is the British `en-GB-RyanNeural` (v4);
the SSML is spoken in the voice's own locale. Changing the voice means re-checking every entry: the American IPA
for confnote was heard as "CanfNote" from British voices, and AG Grid needs no entry with Ryan. Three carrier
sentences per variant catch words that only fail in some sentences.

## Recording PayPal and auto top-up

- **The popup can close under you.** PayPal sometimes closes its checkout popup between a take's `is_closed()`
  check and its next wait, which raises `TargetClosedError` after the payment has gone through. Treat that error as
  "the popup is done" and go on to wait for the credits (v5's first credit take lost its ending to this).
- **"Topping up…" depends on PayPal's timing.** With a saved card, a step that meets an auto top-up still in flight
  makes the Concierge say "Topping up your AI credits…", wait for the refill, say "Credits added. Carrying on." and
  run the step. A drain on meow to below the threshold already triggers the top-up, and when PayPal answers fast the
  credits land inside that same charge, so the next step never sees it in flight and no notice shows (v5: one take
  of four). Each try spends a $5 top-up against the monthly cap, so set the cap with the retries in mind.
- **Find the notices in `document.body`.** The Concierge drawer is not inside `#app`.

## Review every cut and zoom

Musa's rule: watch your own cut. For each footage scene, render stills just after the cut in, before, mid and
after each zoom, and just before the cut out (`render.py scenes` lists the times), and look at every one. A zoom
must land on what the voice is talking about, hold long enough to read, and never crop text mid-word.

A zoom frames a whole subject: a column, a panel, a grid, centred, with no text cut at an edge and no half-empty
frame. The footage window shows a 1920x936 band (about 2:1) at zoom 1, so derive each zoom from the subject's
source rectangle rather than guessing `{x, y, z}` (v4's storyboard has a `fit(x0, y0, x1, y1)` helper). A narrow
subject such as the Concierge drawer or the account panel cannot fill a 2:1 window without cutting the page beside
it. Frame it exactly on its own width (the Concierge drawer is 480 px wide, so a zoom of 4), or a little wider
with a footage `spot: [[from, to, x, y, w, h]]` that dims everything outside the panel so the page beside it falls
back. Callouts sit in the window's top right: leave that corner of a panel framing empty, or carry the line in the
caption instead.

The gate OCRs 4 frames a second, so it can miss something that is on screen for only a few frames. When pasted
data could hold someone's details (an agenda's organiser contact, for example), OCR the source frames of that
moment at full rate and cut them.

## Style

`motion/style.css` copies the app's dark tokens from `packages/core-ui/static/style.css`:

- black and `#0a0a0a` surfaces with `#2e2e2e` lines
- white ink, with inverted white `.primary` buttons
- monospace uppercase labels and `.tag`s
- `--live` green as the only colour, for status

When the app's tokens change, change them here too. Don't add a palette of the video's own.
