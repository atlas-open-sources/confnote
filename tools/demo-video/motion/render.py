#!/usr/bin/env python3
"""Render a storyboard to video: index.html, frame by frame in headless Chromium, encoded with ffmpeg.

  render.py frames   --work DIR --src a=take1.webm --src b=take2.webm [--popup q=popup.webm]
  render.py scenes   --work DIR --storyboard S.js [--ending E.js]
  render.py stills   --work DIR --storyboard S.js [--ending E.js] --at 3,40.5 --out STILLS_DIR
  render.py video    --work DIR --storyboard S.js [--ending E.js] --out CUT.mp4 [--workers 6] [--part all|body|ending]
  render.py join     --body BODY.mp4 --ending-video ENDING.mp4 --out CUT.mp4
  render.py captions --work DIR --storyboard S.js [--ending E.js] --speech SPEECH.json --srt CUT.srt --vo VO.md \
                     --blocks BLOCKS.json

`frames` extracts each take to DIR/frames/<id>/fNNNNN.jpg at 25 fps. A Playwright popup video only fills its own
small viewport in the top-left corner; `--popup` crops that and centres it, scaled, on the app's black.
`--ending` is the ending's segment file (see ending.sample.js). `video --part body` renders everything before it,
`--part ending` only the ending (video only, no audio), and `join` puts the two back together, so a changed ending
re-renders in seconds without touching the body.
`captions` needs SPEECH.json ({"<block>": spoken seconds}, from voice/tts.py) for the subtitle ends.
Output files are never overwritten.

The page is served from a localhost-only HTTP server that maps a few folders (the kit, the work frames, the
storyboard's and the ending's folders, the brandmark's): MapLibre's module worker and three.js's module imports
do not load from file:// URLs. Chromium draws WebGL on the GPU (ANGLE Metal on a Mac); set DEMO_VIDEO_SOFTWARE_GL=1
to fall back to SwiftShader.
"""

import argparse
import http.server
import json
import os
import subprocess
import sys
import threading
import time
import urllib.parse
from contextlib import contextmanager
from pathlib import Path
from typing import NamedTuple

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
KIT = HERE.parent
BRANDMARK = HERE.parents[2] / "packages" / "core-ui" / "static" / "icon.svg"
GPU_ARGS = ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"]
READY_TIMEOUT_MS = (
    120_000  # the kit preloads 3D models, an HDRI and glyph data before the first frame
)
FPS = 30
SRC_FPS = 25
JPEG_QUALITY = 92
SUBTITLE_TAIL = 0.4  # s a narration subtitle stays up after the line ends
POPUP_SCALE = 1.2
POPUP_TOP = 108
APP_BLACK = (0, 0, 0)


def frame_counts(work: Path) -> str:
    counts = []
    if not (
        work / "frames"
    ).is_dir():  # a story with no footage (an opening made only of motion scenes)
        return ""
    for folder in sorted((work / "frames").iterdir()):
        if folder.is_dir():
            counts.append(f"{folder.name}:{len(list(folder.glob('f*.jpg')))}")
    return ",".join(counts)


class Story(NamedTuple):
    storyboard: Path
    ending: Path | None = None

    def args(self) -> list[str]:
        extra = ["--ending", str(self.ending)] if self.ending else []
        return ["--storyboard", str(self.storyboard), *extra]


def mounts_for(work: Path, story: Story) -> dict[str, Path]:
    """URL prefix -> folder. Only these folders are served."""
    mounts = {
        "kit": KIT,
        "frames": (work / "frames").resolve(),
        "story": story.storyboard.resolve().parent,
        "brand": BRANDMARK.parent,
    }
    if story.ending:
        mounts["ending"] = story.ending.resolve().parent
    return mounts


def resolve_mounted(mounts: dict[str, Path], url_path: str) -> Path | None:
    """The file a request path names, or None when it is outside every mount."""
    parts = urllib.parse.unquote(urllib.parse.urlsplit(url_path).path).lstrip("/").split("/", 1)
    folder = mounts.get(parts[0])
    if folder is None or len(parts) < 2:
        return None
    target = (folder / parts[1]).resolve()
    if target != folder and folder not in target.parents:
        return None
    return target


class MountedHandler(http.server.SimpleHTTPRequestHandler):
    mounts: dict[str, Path] = {}

    def translate_path(self, path: str) -> str:
        target = resolve_mounted(self.mounts, path)
        return str(target) if target else "/nonexistent"

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args) -> None:  # quiet: one line per frame would drown the render log
        pass


class PageServer(http.server.ThreadingHTTPServer):
    # Chromium opens many connections at once; the default backlog of 5 resets some of them.
    request_queue_size = 128
    daemon_threads = True


@contextmanager
def serve(mounts: dict[str, Path]):
    handler = type("Handler", (MountedHandler,), {"mounts": mounts})
    server = PageServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


def report_failed_request(request) -> None:
    # ERR_ABORTED is a request the page dropped itself (shutting down, a superseded fetch), not a failure.
    if request.failure != "net::ERR_ABORTED":
        print(f"request failed: {request.url} {request.failure}", file=sys.stderr)


def launch(playwright):
    args = [] if os.environ.get("DEMO_VIDEO_SOFTWARE_GL") else GPU_ARGS
    return playwright.chromium.launch(args=args)


def open_page(playwright, work: Path, story: Story, origin: str):
    browser = launch(playwright)
    page = browser.new_page(viewport={"width": 1920, "height": 1080}, device_scale_factor=1)
    page.on("pageerror", lambda error: print(f"page error: {error}", file=sys.stderr))
    page.on("requestfailed", report_failed_request)
    query = urllib.parse.urlencode(
        {
            "storyboard": f"{origin}/story/{story.storyboard.name}",
            "frames": f"{origin}/frames",
            "counts": frame_counts(work),
            "brandmark": f"{origin}/brand/{BRANDMARK.name}",
            **({"ending": f"{origin}/ending/{story.ending.name}"} if story.ending else {}),
        }
    )
    page.goto(f"{origin}/kit/motion/index.html?{query}")
    page.wait_for_function("window.KIT_READY || window.KIT_ERROR", timeout=READY_TIMEOUT_MS)
    error = page.evaluate("window.KIT_ERROR || ''")
    if error:
        browser.close()
        sys.exit(f"the kit could not preload: {error}")
    page.evaluate("document.fonts.ready.then(() => true)")
    return browser, page


def evaluate(work: Path, story: Story, expression: str):
    with serve(mounts_for(work, story)) as origin, sync_playwright() as p:
        browser, page = open_page(p, work, story, origin)
        value = page.evaluate(expression)
        browser.close()
    return value


def popup_size(first_frame: Path) -> tuple[int, int]:
    """The popup's viewport: the box in the top-left corner that is not Playwright's grey fill."""
    from PIL import Image

    image = Image.open(first_frame).convert("RGB")
    grey = image.getpixel((image.width - 1, image.height - 1))
    width = next(x for x in range(image.width) if image.getpixel((x, 1)) == grey)
    height = next(y for y in range(image.height) if image.getpixel((1, y)) == grey)
    return width, height


def composite_popup(folder: Path) -> None:
    from PIL import Image

    frames = sorted(folder.glob("f*.jpg"))
    width, height = popup_size(frames[len(frames) // 2])
    scaled = (round(width * POPUP_SCALE), round(height * POPUP_SCALE))
    left = (1920 - scaled[0]) // 2
    for frame in frames:
        canvas = Image.new("RGB", (1920, 1080), APP_BLACK)
        popup = (
            Image.open(frame)
            .convert("RGB")
            .crop((0, 0, width, height))
            .resize(scaled, Image.LANCZOS)
        )
        canvas.paste(popup, (left, POPUP_TOP))
        canvas.save(frame, quality=93)


def extract(work: Path, sources: list[str], popups: list[str]) -> None:
    for spec in sources + popups:
        source_id, path = spec.split("=", 1)
        folder = work / "frames" / source_id
        if folder.exists():
            sys.exit(f"{folder} exists; remove it first")
        folder.mkdir(parents=True)
        subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-i",
                path,
                "-r",
                str(SRC_FPS),
                "-q:v",
                "2",
                str(folder / "f%05d.jpg"),
            ],
            check=True,
        )
        if spec in popups:
            composite_popup(folder)
        print(f"{source_id}: {len(list(folder.glob('f*.jpg')))} frames")


def render_range(work: Path, story: Story, start: int, end: int, out: Path) -> None:
    encoder = subprocess.Popen(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "image2pipe",
            "-framerate",
            str(FPS),
            "-c:v",
            "mjpeg",
            "-i",
            "-",
            "-vf",
            "scale=out_range=tv,format=yuv420p",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "17",
            "-color_range",
            "tv",
            "-r",
            str(FPS),
            str(out),
        ],
        stdin=subprocess.PIPE,
    )
    with serve(mounts_for(work, story)) as origin, sync_playwright() as p:
        browser, page = open_page(p, work, story, origin)
        for i in range(start, end):
            page.evaluate("i => window.renderFrame(i)", i)
            encoder.stdin.write(page.screenshot(type="jpeg", quality=JPEG_QUALITY))
        browser.close()
    encoder.stdin.close()
    if encoder.wait() != 0:
        sys.exit(f"encoder failed for frames {start}-{end}")


def concat_videos(parts: list[Path], listing: Path, out: Path, with_silence: bool) -> None:
    """Stream-copy the parts into one file; the full cut gets a silent stereo track for mix.py to replace."""
    listing.write_text("".join(f"file '{part.resolve()}'\n" for part in parts))
    audio = (
        ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
        if with_silence
        else []
    )
    maps = (
        ["-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", "128k", "-shortest"]
        if with_silence
        else ["-an"]
    )
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-n",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(listing),
            *audio,
            *maps,
            "-c:v",
            "copy",
            "-movflags",
            "+faststart",
            str(out),
        ],
        check=True,
    )


def render_video(work: Path, story: Story, out: Path, workers: int, part: str) -> None:
    total, ending_start = evaluate(work, story, "[window.TOTAL_FRAMES, window.ENDING_START_FRAME]")
    first, last = {"all": (0, total), "body": (0, ending_start), "ending": (ending_start, total)}[
        part
    ]
    n = last - first
    started = time.monotonic()
    chunk = -(-n // workers)
    procs, chunks = [], []
    for w in range(workers):
        a, b = first + w * chunk, min(last, first + (w + 1) * chunk)
        if a >= b:
            break
        chunk_file = work / f"chunk-{part}-{w:02d}.mp4"
        chunks.append(chunk_file)
        procs.append(
            subprocess.Popen(
                [
                    sys.executable,
                    __file__,
                    "chunk",
                    "--work",
                    str(work),
                    *story.args(),
                    "--range",
                    f"{a}:{b}",
                    "--out",
                    str(chunk_file),
                ]
            )
        )
    if any(proc.wait() != 0 for proc in procs):
        sys.exit("a render chunk failed")
    concat_videos(chunks, work / f"chunks-{part}.txt", out, with_silence=part == "all")
    wall = time.monotonic() - started
    print(
        f"{out} ({part}: frames {first}-{last}, {n / FPS:.2f} s; "
        f"rendered in {wall:.1f} s, {n / wall:.1f} frames/s with {len(procs)} workers)"
    )


def join_video(body: Path, ending: Path, out: Path) -> None:
    concat_videos([body, ending], out.with_suffix(".join.txt"), out, with_silence=True)
    print(out)


def render_stills(work: Path, story: Story, times: list[float], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    with serve(mounts_for(work, story)) as origin, sync_playwright() as p:
        browser, page = open_page(p, work, story, origin)
        for t in times:
            started = time.monotonic()
            kind = page.evaluate("i => window.renderFrame(i)", round(t * FPS))
            page.screenshot(path=str(out_dir / f"still-{t:07.2f}.png"))
            print(f"still {t:.2f} s ({kind}): {time.monotonic() - started:.2f} s to draw")
        browser.close()


def stamp(seconds: float) -> str:
    ms = round(seconds * 1000)
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def caption_files(blocks: list, speech: dict, total: float) -> tuple[str, str, list[dict]]:
    """The narration .srt, the voiceover script and the voice cue list for mix.py."""
    srt = []
    for i, (n, cue, _heading, words) in enumerate(blocks, 1):
        srt += [
            str(i),
            f"{stamp(cue)} --> {stamp(cue + speech[str(n)] + SUBTITLE_TAIL)}",
            words,
            "",
        ]
    script = [f"# Voiceover ({int(total // 60)}:{total % 60:04.1f})", ""]
    for n, cue, heading, words in blocks:
        script += [f"**{int(cue // 60)}:{cue % 60:04.1f} {heading}** (block {n})", words, ""]
    cues = [cue for _, cue, _, _ in blocks]
    ends = cues[1:] + [total]
    cue_list = [
        {"n": n, "text": words, "start": round(cue, 3), "end": round(end, 3), "lead": 0.0}
        for (n, cue, _, words), end in zip(blocks, ends, strict=True)
    ]
    return "\n".join(srt), "\n".join(script), cue_list


def write_new(path: Path, content: str) -> None:
    if path.exists():
        sys.exit(f"{path} exists; not overwriting")
    path.write_text(content)
    print(path)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "mode", choices=["frames", "scenes", "stills", "video", "chunk", "join", "captions"]
    )
    ap.add_argument("--work", type=Path)
    ap.add_argument("--storyboard", type=Path)
    ap.add_argument("--ending", type=Path, help="the ending's segment file (window.ENDING)")
    ap.add_argument("--part", choices=["all", "body", "ending"], default="all")
    ap.add_argument("--body", type=Path)
    ap.add_argument("--ending-video", type=Path)
    ap.add_argument("--src", action="append", default=[])
    ap.add_argument("--popup", action="append", default=[])
    ap.add_argument("--out", type=Path)
    ap.add_argument("--at", default="")
    ap.add_argument("--range", default="")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--speech", type=Path)
    ap.add_argument("--srt", type=Path)
    ap.add_argument("--vo", type=Path)
    ap.add_argument("--blocks", type=Path)
    args = ap.parse_args()
    if args.mode != "join" and not args.work:
        ap.error("--work is required")
    story = Story(args.storyboard, args.ending)

    if args.mode == "frames":
        extract(args.work, args.src, args.popup)
    elif args.mode == "scenes":
        print(json.dumps(evaluate(args.work, story, "window.exportScenes()"), indent=1))
    elif args.mode == "stills":
        render_stills(args.work, story, [float(x) for x in args.at.split(",")], args.out)
    elif args.mode == "video":
        render_video(args.work, story, args.out, args.workers, args.part)
    elif args.mode == "chunk":
        a, b = (int(x) for x in args.range.split(":"))
        render_range(args.work, story, a, b, args.out)
    elif args.mode == "join":
        join_video(args.body, args.ending_video, args.out)
    else:
        blocks = evaluate(args.work, story, "window.exportVoiceover()")
        total = evaluate(args.work, story, "window.TOTAL_FRAMES") / FPS
        srt, script, cues = caption_files(blocks, json.loads(args.speech.read_text()), total)
        write_new(args.srt, srt)
        write_new(args.vo, script)
        write_new(args.blocks, json.dumps(cues, indent=1, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
