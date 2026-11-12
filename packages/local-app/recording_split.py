"""Cut one continuous block recording into per-session slices, by transcript.

A block recording runs over several agenda sessions. Talks start early and run
over, so the agenda times only serve as a weak prior: the boundaries come from
the timed transcript (the MC's hand-offs in zh + en, speaker / org / title
words) aligned monotonically in agenda order.

Pure logic, no audio and no vault writes. Times are "file seconds" (offsets into
the audio file). The file skips any time the Mac slept (lid shut), so wall time
is `started_at + offset` plus every sleep gap before that point: see
`clamshell_gaps` and `wall_time`.
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import NamedTuple

# Search window around the agenda start (file seconds). Talks ran 2-16 min early
# at AI Engineer Shanghai, so earlier gets more room than later.
WINDOW_EARLY = 20 * 60
WINDOW_LATE = 10 * 60
# Prior penalty: one point per this many seconds away from the agenda start.
PRIOR_EARLY_SCALE = 600
PRIOR_LATE_SCALE = 300
# Two consecutive session starts are at least this far apart.
MIN_TALK = 180
# A hand-off is the cue segment plus what is said in this many seconds after it.
CLUSTER_AFTER = 30
# Speaker / org / title words are looked for in this window after a candidate.
KEYWORD_AFTER = 150
KEYWORD_BEFORE = 10
MAX_KEYWORD_HITS = 3
KEYWORD_WEIGHT = 1.5
# Walk a start back over thank-yous said just before the hand-off.
WALK_BACK_STEP = 15
WALK_BACK_TOTAL = 20
# A pause this long after the last line of a talk marks a likely change of
# speaker even without an MC hand-off; longer pauses count more, up to MAX_PAUSE_BONUS.
PAUSE_MIN = 30
PAUSE_SCALE = 60
MAX_PAUSE_BONUS = 1.5
# The last session ends at its last real line, at most this long after its agenda end.
LAST_OVERRUN = 20 * 60
EVIDENCE_CHARS = 80

INTRO_RE = re.compile(
    r"下一位|下一个|下一個|下一场|下一場|接下来|接下來|有请|有請|"
    r"\bnext (speaker|up|is|we|talk|session|presenter|guest|on stage)\b|\bup next\b",
    re.IGNORECASE,
)
WELCOME_RE = re.compile(r"欢迎|歡迎|\bwelcome\b", re.IGNORECASE)
# Phrases that are a hand-off on their own.
STRONG_RE = re.compile(
    r"掌声欢迎|掌聲歡迎|有请|有請|下一位|下一場|下一场|"
    r"next speaker|please welcome|let'?s welcome|give it up for|round of applause",
    re.IGNORECASE,
)
CLOSING_RE = re.compile(r"谢谢|謝謝|感谢|感謝|掌声|掌聲|\bthank(s| you)\b", re.IGNORECASE)
# Whisper's credit lines, loops and silence fillers.
JUNK_RE = re.compile(
    r"subtit|субтитр|amara\.org|字幕|请不吝|点赞|订阅|明镜|"
    r"^\s*(thank you|you|thanks)[.!。\s]*$",
    re.IGNORECASE,
)
REPEAT_RE = re.compile(r"(\S{1,8}?)(?:[\s,]*\1){4,}")
EMPTY_RE = re.compile(r"[\s.,!?。，！？…、\-]")
LATIN_WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9\-]{2,}")
CJK_RE = re.compile("[一-鿿]")
# Title words too common at an AI conference to say who is on stage.
GENERIC_WORDS = {
    "the", "and", "for", "with", "your", "from", "what", "when", "into", "that", "this", "are",
    "our", "how", "not", "all", "one", "can", "its", "out", "about", "beyond", "over", "era",
    "new", "next", "more", "less", "their", "them", "they", "you", "agent", "agents", "agentic",
    "model", "models", "engineering", "engineer", "intelligence", "building", "build", "scale",
    "data", "open", "source", "native", "infra", "infrastructure", "system", "systems", "future",
    "world", "llm", "llms", "talk", "keynote", "panel", "session", "break", "welcome", "closing",
    "opening", "day"
}  # fmt: skip
PMSET_LINE_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}) (Sleep|Wake)\s+\t?"
    r"(Entering Sleep|Wake from)"
)


class Gap(NamedTuple):
    """Wall-clock span missing from the file (the Mac slept)."""

    start: datetime
    end: datetime

    @property
    def seconds(self) -> float:
        return max(0.0, (self.end - self.start).total_seconds())


@dataclass(frozen=True)
class Event:
    """One agenda session in the block, with the words that identify it."""

    note: str
    title: str
    start: datetime
    end: datetime
    speakers: tuple[str, ...] = ()
    orgs: tuple[str, ...] = ()


@dataclass(frozen=True)
class Cut:
    note: str
    title: str
    start: float
    end: float
    wall_start: datetime
    wall_end: datetime
    confidence: str
    evidence: str


@dataclass(frozen=True)
class Slice:
    note: str
    start: float
    end: float
    pad_before: float
    wall_start: datetime
    cut: Cut

    @property
    def duration(self) -> float:
        return self.end - self.start

    @property
    def file_name(self) -> str:
        """The app recorder's naming: recording-<UTC start>.m4a."""
        return f"recording-{self.wall_start.astimezone(UTC):%Y%m%d-%H%M%S}.m4a"


@dataclass(frozen=True)
class _Seg:
    t0: float
    t1: float
    text: str


@dataclass(frozen=True)
class _Candidate:
    t: float
    score: float
    # A hand-off confirmed by an explicit phrase or a speaker / org / title word.
    confirmed: bool
    keyword_hits: int
    evidence: str


# --- wall time ---------------------------------------------------------------


def wall_time(offset: float, started_at: datetime, gaps: list[Gap]) -> datetime:
    """Wall-clock time of a file offset: the start plus every gap before it."""
    wall = started_at + timedelta(seconds=offset)
    for gap in sorted(gaps, key=lambda g: g.start):
        if gap.start <= wall:
            wall += timedelta(seconds=gap.seconds)
    return wall


def file_offset(wall: datetime, started_at: datetime, gaps: list[Gap]) -> float:
    """File offset of a wall-clock time; a time inside a gap maps to where the file resumes."""
    offset = (wall - started_at).total_seconds()
    for gap in gaps:
        if gap.end <= wall:
            offset -= gap.seconds
        elif gap.start < wall:
            offset -= (wall - gap.start).total_seconds()
    return offset


def clamshell_gaps(birth: datetime, mtime: datetime, log_text: str | None = None) -> list[Gap]:
    """Sleep spans between a file's birth and last write, from `pmset -g log`.

    Any sleep stops the recorder, not only a shut lid; the gap runs from the
    "Entering Sleep" line to the next full "Wake" (dark wakes do not resume it).
    Needs no privileges. `log_text` is injectable for tests.
    """
    if log_text is None:
        log_text = _pmset_log()
    gaps: list[Gap] = []
    asleep_since: datetime | None = None
    for line in log_text.splitlines():
        match = PMSET_LINE_RE.match(line)
        if not match:
            continue
        stamp = datetime.strptime(match.group(1), "%Y-%m-%d %H:%M:%S %z")
        if match.group(2) == "Sleep":
            if asleep_since is None:
                asleep_since = stamp
            continue
        if asleep_since is None:
            continue
        start, end = max(asleep_since, birth), min(stamp, mtime)
        if end > start:
            gaps.append(Gap(start, end))
        asleep_since = None
    return gaps


def _pmset_log() -> str:
    try:
        result = subprocess.run(
            ["/usr/bin/pmset", "-g", "log"], capture_output=True, text=True, timeout=60
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return result.stdout


# --- boundaries --------------------------------------------------------------


def find_boundaries(
    segments: list,
    events: list,
    *,
    started_at: datetime,
    gaps: list[Gap],
) -> list[Cut]:
    """One Cut per event, in agenda order, from the timed transcript.

    With no usable segments every cut falls back to the agenda time with
    confidence "low".
    """
    evs = sorted((_event(e) for e in events), key=lambda e: e.start)
    if not evs:
        return []
    segs = [s for s in (_seg(s) for s in segments) if not _is_junk(s.text)]
    segs.sort(key=lambda s: s.t0)
    priors = [file_offset(e.start, started_at, gaps) for e in evs]
    starts: list[tuple[float, str, str]] = []
    if not segs:
        prev = 0.0
        for prior in priors:
            prev = max(prior, prev, 0.0)
            starts.append((prev, "low", "no timed transcript; agenda time"))
    else:
        starts = _align(segs, evs, priors)
    ends = _ends(segs, evs, starts, started_at, gaps)
    return [
        Cut(
            note=e.note,
            title=e.title,
            start=round(start, 2),
            end=round(end, 2),
            wall_start=wall_time(start, started_at, gaps),
            wall_end=wall_time(end, started_at, gaps),
            confidence=confidence,
            evidence=evidence,
        )
        for e, (start, confidence, evidence), end in zip(evs, starts, ends, strict=True)
    ]


def _align(segs: list[_Seg], evs: list[Event], priors: list[float]) -> list[tuple[float, str, str]]:
    """Pick one start per event: best total score, strictly increasing, MIN_TALK apart."""
    options: list[list[_Candidate | None]] = []
    for i, (event, prior) in enumerate(zip(evs, priors, strict=True)):
        if i == 0 and prior <= 0:
            note = f"recording starts mid-session (agenda start {_clock(prior)} before it)"
            options.append([_Candidate(0.0, 5.0, True, 0, note)])
            continue
        options.append([*_candidates(segs, event, prior), None])

    # best[i][k] = (total score, start, back pointer) for option k of event i.
    best: list[list[tuple[float, float, int] | None]] = []
    for i, opts in enumerate(options):
        row: list[tuple[float, float, int] | None] = []
        for cand in opts:
            row.append(_best_step(best[i - 1] if i else None, cand, priors[i]))
        best.append(row)

    k = max(
        (k for k, cell in enumerate(best[-1]) if cell is not None),
        key=lambda k: best[-1][k][0],
    )
    picked: list[tuple[float, str, str]] = []
    for i in range(len(evs) - 1, -1, -1):
        _, t, back = best[i][k]
        cand = options[i][k]
        picked.append((t, *_grade(cand, t)))
        k = back
    picked.reverse()
    return picked


def _best_step(
    prev_row: list[tuple[float, float, int] | None] | None,
    cand: _Candidate | None,
    prior: float,
) -> tuple[float, float, int] | None:
    """Best way to reach `cand` (None = agenda fallback) from the previous event's options."""
    fallback_score = 0.0
    if prev_row is None:
        t = cand.t if cand else max(prior, 0.0)
        return (cand.score if cand else fallback_score, t, -1)
    best: tuple[float, float, int] | None = None
    for j, cell in enumerate(prev_row):
        if cell is None:
            continue
        total, prev_t, _ = cell
        if cand is None:
            t = max(prior, prev_t + MIN_TALK)
            score = total + fallback_score
        else:
            if cand.t < prev_t + MIN_TALK:
                continue
            t = cand.t
            score = total + cand.score
        if best is None or score > best[0]:
            best = (score, t, j)
    return best


def _grade(cand: _Candidate | None, t: float) -> tuple[str, str]:
    if cand is None:
        return "low", f"no hand-off heard; agenda time {_clock(t)}"
    if cand.confirmed:
        return "high", cand.evidence
    return "med", cand.evidence


def _candidates(segs: list[_Seg], event: Event, prior: float) -> list[_Candidate]:
    keywords = _keywords(event)
    lo, hi = prior - WINDOW_EARLY, prior + WINDOW_LATE
    out = []
    for idx, seg in enumerate(segs):
        if seg.t0 < lo or seg.t0 > hi:
            continue
        pause = _pause_candidate(segs, idx, keywords, prior)
        if pause is not None:
            out.append(pause)
        intro = bool(INTRO_RE.search(seg.text))
        welcome = bool(WELCOME_RE.search(seg.text))
        if not (intro or welcome or _hits(seg.text, keywords)):
            continue
        cluster = [s for s in segs[idx:] if s.t0 <= seg.t0 + CLUSTER_AFTER]
        joined = " ".join(s.text for s in cluster)
        has_intro = bool(INTRO_RE.search(joined))
        has_welcome = bool(WELCOME_RE.search(joined))
        explicit = bool(STRONG_RE.search(joined))
        handoff = explicit or (has_intro and has_welcome)
        start_idx = _walk_back(segs, idx)
        has_closing = any(CLOSING_RE.search(s.text) for s in segs[start_idx : idx + 1])
        window = [s for s in segs if seg.t0 - KEYWORD_BEFORE <= s.t0 <= seg.t0 + KEYWORD_AFTER]
        hits, named = _keyword_hits(window, keywords)
        cue = 2.0 * has_intro + 2.0 * has_welcome + 1.0 * has_closing + 1.0 * handoff
        if cue + hits < 2:
            continue
        lines = [segs[start_idx], seg]
        if named is not None:
            lines.append(named)
        t = segs[start_idx].t0
        out.append(
            _Candidate(
                t=t,
                score=cue + KEYWORD_WEIGHT * hits - _prior_penalty(t, prior),
                confirmed=handoff and (explicit or hits > 0),
                keyword_hits=hits,
                evidence=_evidence(lines),
            )
        )
    return out


def _keyword_hits(window: list[_Seg], keywords: set[str]) -> tuple[int, _Seg | None]:
    """Distinct keywords heard in the window (capped) and the first line naming one."""
    found: set[str] = set()
    named = None
    for s in window:
        hit = _hits(s.text, keywords)
        if hit and named is None:
            named = s
        found.update(hit)
    return min(len(found), MAX_KEYWORD_HITS), named


def _pause_candidate(
    segs: list[_Seg], idx: int, keywords: set[str], prior: float
) -> _Candidate | None:
    """A long pause after a line (a talk's last "thank you", or a break) as a weak start."""
    if idx + 1 >= len(segs):
        return None
    seg, after = segs[idx], segs[idx + 1]
    pause = after.t0 - seg.t1
    if pause < PAUSE_MIN:
        return None
    closing = bool(CLOSING_RE.search(seg.text))
    t = seg.t1
    window = [s for s in segs if t <= s.t0 <= t + KEYWORD_AFTER]
    hits, named = _keyword_hits(window, keywords)
    bonus = min(pause / PAUSE_SCALE, MAX_PAUSE_BONUS)
    score = bonus + 1.0 * closing + KEYWORD_WEIGHT * hits - _prior_penalty(t, prior)
    evidence = f"{_evidence([seg])} then {int(pause)} s pause"
    if named is not None:
        evidence += f"; {_evidence([named])}"
    return _Candidate(t=t, score=score, confirmed=False, keyword_hits=hits, evidence=evidence)


def _prior_penalty(t: float, prior: float) -> float:
    delta = t - prior
    if delta < 0:
        return -delta / PRIOR_EARLY_SCALE
    return delta / PRIOR_LATE_SCALE


def _walk_back(segs: list[_Seg], idx: int) -> int:
    """Start a hand-off at the thank-yous / cues said just before it."""
    first = idx
    while first > 0:
        prev = segs[first - 1]
        if segs[first].t0 - prev.t0 > WALK_BACK_STEP:
            break
        if segs[idx].t0 - prev.t0 > WALK_BACK_TOTAL:
            break
        if not (CLOSING_RE.search(prev.text) or INTRO_RE.search(prev.text)):
            break
        first -= 1
    return first


def _evidence(lines: list[_Seg]) -> str:
    """One line: each distinct segment as "[h:mm:ss] text"."""
    unique = list(dict.fromkeys(lines))
    return " ".join(f"[{_clock(s.t0)}] {s.text[:EVIDENCE_CHARS]}" for s in unique)


def _ends(
    segs: list[_Seg],
    evs: list[Event],
    starts: list[tuple[float, str, str]],
    started_at: datetime,
    gaps: list[Gap],
) -> list[float]:
    ends = []
    for i in range(len(evs)):
        start = starts[i][0]
        if i + 1 < len(evs):
            ends.append(starts[i + 1][0])
            continue
        limit = file_offset(evs[i].end, started_at, gaps) + LAST_OVERRUN
        spoken = [s.t1 for s in segs if start <= s.t0 <= limit]
        if spoken:
            ends.append(max(spoken))
        else:
            ends.append(max(start, file_offset(evs[i].end, started_at, gaps)))
    return ends


# --- slices ------------------------------------------------------------------


def plan_slices(cuts: list[Cut], duration: float, pad: float = 30) -> list[Slice]:
    """Pad each cut on both sides and clamp it to the file."""
    slices = []
    for cut in cuts:
        start = min(max(0.0, cut.start - pad), duration)
        end = max(min(duration, cut.end + pad), start)
        before = cut.start - start
        slices.append(
            Slice(
                note=cut.note,
                start=round(start, 2),
                end=round(end, 2),
                pad_before=round(before, 2),
                wall_start=cut.wall_start - timedelta(seconds=before),
                cut=cut,
            )
        )
    return slices


# --- helpers -----------------------------------------------------------------


def _event(raw) -> Event:
    if isinstance(raw, Event):
        return raw
    return Event(
        note=raw["note"],
        title=raw.get("title", ""),
        start=_dt(raw["start"]),
        end=_dt(raw["end"]),
        speakers=tuple(raw.get("speakers") or ()),
        orgs=tuple(raw.get("orgs") or ()),
    )


def _dt(value) -> datetime:
    return value if isinstance(value, datetime) else datetime.fromisoformat(value)


def _seg(raw) -> _Seg:
    if isinstance(raw, dict):
        return _Seg(float(raw["start"]), float(raw["end"]), str(raw.get("text", "")).strip())
    t0, t1, text = raw
    return _Seg(float(t0), float(t1), str(text).strip())


def _is_junk(text: str) -> bool:
    if not EMPTY_RE.sub("", text):
        return True
    return bool(JUNK_RE.search(text) or REPEAT_RE.search(text))


def _keywords(event: Event) -> set[str]:
    words: set[str] = set()
    for name in (*event.speakers, *event.orgs):
        name = re.sub(r"[()（）]", " ", name)
        if CJK_RE.search(name):
            words.update(p for p in re.split(r"\s+", name) if CJK_RE.search(p) and len(p) >= 2)
        for part in LATIN_WORD_RE.findall(name):
            if part.lower() not in GENERIC_WORDS:
                words.add(part.lower())
    for word in LATIN_WORD_RE.findall(event.title):
        if len(word) >= 3 and word.lower() not in GENERIC_WORDS:
            words.add(word.lower())
    return words


def _hits(text: str, keywords: set[str]) -> set[str]:
    low = text.lower()
    found = set()
    for word in keywords:
        if CJK_RE.search(word):
            if word in text:
                found.add(word)
        elif re.search(rf"(?<![a-z0-9]){re.escape(word)}(?![a-z0-9])", low):
            found.add(word)
    return found


def _clock(seconds: float) -> str:
    sign = "-" if seconds < 0 else ""
    s = int(round(abs(seconds)))
    return f"{sign}{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}"
