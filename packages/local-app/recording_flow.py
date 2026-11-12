"""Block recording → per-session slices: the macOS and markdown plumbing.

One continuous recording covers a block of sessions; after Stop it is cut
into one padded slice per session (`recording_split` finds the boundaries)
and each slice is filed beside its note. This module holds the parts that
do not touch the vault: cutting audio with avconvert, reading a file's
duration, and the `## Transcript` text for one slice. server.py owns the vault writes and the routes.

stdlib-only; subprocess calls take an injectable `run` so tests mock them.
"""

from __future__ import annotations

import re
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path

# Ships with macOS; passthrough copies the AAC frames, no re-encode.
AVCONVERT = "/usr/bin/avconvert"
AFINFO = "/usr/bin/afinfo"
CUT_TIMEOUT_S = 600


def cut_slice(src, dest, start: float, dur: float, run=subprocess.run) -> Path:
    """Cut [start, start+dur) seconds of `src` into `dest` without re-encoding."""
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        AVCONVERT,
        "--source",
        str(src),
        "--preset",
        "PresetPassthrough",
        "--output",
        str(dest),
        "--start",
        f"{max(0.0, start):.3f}",
        "--duration",
        f"{max(0.0, dur):.3f}",
        "--replace",
    ]
    result = run(cmd, capture_output=True, text=True, timeout=CUT_TIMEOUT_S)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()[:200]
        raise RuntimeError(f"avconvert failed ({result.returncode}) {detail}".strip())
    return dest


def audio_duration(path, run=subprocess.run) -> float:
    """Seconds of audio in `path`, from afinfo's `estimated duration` line."""
    result = run([AFINFO, str(path)], capture_output=True, text=True, timeout=60)
    m = re.search(r"estimated duration:\s*([\d.]+)", result.stdout or "")
    if not m:
        raise RuntimeError(f"could not read the duration of {Path(path).name}")
    return float(m.group(1))


def birth_and_mtime(path) -> tuple[datetime, datetime]:
    """When the recorder created the file and when it last wrote it (UTC)."""
    st = Path(path).stat()
    birth = getattr(st, "st_birthtime", st.st_ctime)
    return (
        datetime.fromtimestamp(birth, UTC),
        datetime.fromtimestamp(st.st_mtime, UTC),
    )


def slice_name(wall_start: datetime) -> str:
    """The app recorder's own naming: recording-<UTC %Y%m%d-%H%M%S>.m4a."""
    return f"recording-{wall_start.astimezone(UTC).strftime('%Y%m%d-%H%M%S')}.m4a"


def clock(seconds: float) -> str:
    """1:02:17 / 2:05 for offsets in the full recording."""
    s = max(0, int(round(seconds)))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def mmss(seconds: float) -> str:
    s = max(0, int(seconds))
    return f"[{s // 60:02d}:{s % 60:02d}]"


def _local(wall: datetime | None, tz) -> str:
    if wall is None:
        return "?"
    return wall.astimezone(tz).strftime("%H:%M:%S") if tz else wall.strftime("%H:%M:%S")


def transcript_block(
    sl,
    audio_rel: str,
    segments,
    event: dict | None = None,
    gap_seconds: float = 0.0,
) -> str:
    """The `## Transcript` entry for one `recording_split.Slice`: a header,
    then `[mm:ss]` lines measured from the detected start."""
    cut = sl.cut
    event = event or {}
    tz = datetime.fromisoformat(event["start"]).tzinfo if event.get("start") else None
    lead = sl.pad_before
    lines = ["**From a block recording (machine transcript)**", ""]
    if event.get("speakers"):
        lines.append(f"- Speakers: {', '.join(event['speakers'])}")
    if event.get("start") and event.get("end"):
        lines.append(f"- Agenda: {event['start'][11:16]}–{event['end'][11:16]}")
    gap_note = ""
    if gap_seconds:
        gap_note = (
            f", corrected for {int(gap_seconds) // 60} min {int(gap_seconds) % 60} s lid-shut"
        )
    lines.append(
        f"- Detected{gap_note}: {_local(cut.wall_start, tz)}–{_local(cut.wall_end, tz)}; "
        f"in the full recording: {clock(cut.start)}–{clock(cut.end)}"
    )
    name = Path(audio_rel).name
    lines.append(
        f"- Audio: [{name}]({audio_rel}), full recording "
        f"{clock(sl.start)}–{clock(sl.end)} with {int(round(lead))} s padding; "
        f"transcript time [mm:ss] = slice time − {int(round(lead))} s"
    )
    lines.append(f"- Boundary confidence: {cut.confidence}. Evidence: {cut.evidence}")
    body = [
        f"{mmss(t0 - cut.start)} {text}"
        for t0, _t1, text in segments or []
        if cut.start <= t0 < cut.end
    ]
    if body:
        lines.append(
            "- Times are [mm:ss] from the detected start. Machine transcript, uncorrected."
        )
    else:
        lines.append("- No timed transcript lines for this slice.")
    return "\n".join(lines + [""] + body).strip()


def gap_total(gaps) -> float:
    return sum((g1 - g0).total_seconds() for g0, g1 in gaps or [])


def window(events, before_min: int = 2, after_min: int = 3):
    """Auto-record window over events: first start − 2 min to last end + 3 min."""
    if not events:
        return None
    starts = [datetime.fromisoformat(ev["start"]) for ev in events]
    ends = [datetime.fromisoformat(ev["end"]) for ev in events]
    return min(starts) - timedelta(minutes=before_min), max(ends) + timedelta(minutes=after_min)
