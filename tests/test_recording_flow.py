"""Block recording → per-session slices: cutting, filing, routes, auto-record.

`recording_split` (the boundary finder) is replaced by a stub here: these
tests cover the filing around it, not its detection. Nothing reaches the Cat,
avconvert, the Keychain or the user's vault.
"""

from __future__ import annotations

import json
import socket
import subprocess
import sys
import threading
import types
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from http.server import ThreadingHTTPServer
from typing import NamedTuple

import pytest

sys.path.insert(0, "packages/local-app")
import recording_flow  # noqa: E402
import server  # noqa: E402
import transcription  # noqa: E402

SLUG = "2026-11-05-block-conf"
T0 = datetime(2026, 11, 5, 5, 0, tzinfo=UTC)  # 13:00 +08
NOTES = ("1300-first.md", "1330-second.md")


@dataclass(frozen=True)
class _Cut:
    note: str
    title: str
    start: float
    end: float
    wall_start: datetime
    wall_end: datetime
    confidence: str
    evidence: str


@dataclass(frozen=True)
class _Slice:
    note: str
    start: float
    end: float
    pad_before: float
    wall_start: datetime
    cut: _Cut


class _Gap(NamedTuple):
    start: datetime
    end: datetime


def _stub_split():
    """recording_split's API (Cut, Slice, Gap, find_boundaries, plan_slices,
    clamshell_gaps, wall_time), with agenda-time detection: a cut starts 60 s
    after the agenda start when segments exist (high), at it without (low)."""
    mod = types.ModuleType("recording_split")
    mod.calls = []
    mod.Gap = _Gap

    def wall_time(offset, started_at, gaps):
        return started_at + timedelta(seconds=offset)

    def plan_slices(cuts, duration, pad=30):
        out = []
        for c in cuts:
            start = max(0.0, c.start - pad)
            before = c.start - start
            end = min(duration, c.end + pad)
            out.append(
                _Slice(c.note, start, end, before, c.wall_start - timedelta(seconds=before), c)
            )
        return out

    def find_boundaries(segments, events, *, started_at, gaps):
        mod.calls.append((events, gaps))
        shift, conf = (60, "high") if segments else (0, "low")
        cuts = []
        for ev in events:
            s = datetime.fromisoformat(ev["start"])
            e = datetime.fromisoformat(ev["end"])
            start = (s - started_at).total_seconds() + shift
            end = (e - started_at).total_seconds()
            ws = started_at + timedelta(seconds=start)
            cuts.append(
                _Cut(ev["note"], ev["title"], start, end, ws, e, conf, "[0:05] 下一位 welcome")
            )
        return cuts

    mod.wall_time = wall_time
    mod.plan_slices = plan_slices
    mod.find_boundaries = find_boundaries
    mod.clamshell_gaps = lambda birth, mtime, log_text=None: []
    return mod


def _note(title):
    return f"---\nsession: {title}\n---\n\n# {title}\n\n## Human notes\n\n\n## Transcript\n\n\n## Actions\n\n"


@pytest.fixture
def vault(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    stub = _stub_split()
    monkeypatch.setitem(sys.modules, "recording_split", stub)
    monkeypatch.setattr(server, "read_settings", lambda resolve_key=True: server._DEFAULT_SETTINGS)
    notes = tmp_path / SLUG / "notes"
    notes.mkdir(parents=True)
    events = [
        ("first", "First Talk", "13:00", "13:30", "main", ["ada"]),
        ("second", "Second Talk", "13:30", "14:00", "main", []),
        ("side", "Side Room", "13:00", "13:45", "side", []),
    ]
    agenda = {
        "conference": {"name": "Block", "timezone": "Asia/Shanghai"},
        "speakers": {"ada": {"name": "Ada Li", "company": "AutoArk"}},
        "events": [
            {
                "id": eid,
                "type": "talk",
                "title": title,
                "start": f"2026-11-05T{s}:00+08:00",
                "end": f"2026-11-05T{e}:00+08:00",
                "room": room,
                "speakers": spk,
            }
            for eid, title, s, e, room, spk in events
        ],
    }
    (tmp_path / SLUG / "agenda.json").write_text(json.dumps(agenda))
    for eid, title, s, *_ in events:
        (notes / f"{s.replace(':', '')}-{eid}.md").write_text(_note(title))
    audio = tmp_path / "block.m4a"
    audio.write_bytes(b"AUDIO")
    monkeypatch.setattr(recording_flow, "audio_duration", lambda path: 3600.0)
    monkeypatch.setattr(
        recording_flow, "birth_and_mtime", lambda path: (T0, T0 + timedelta(hours=1))
    )
    cut_calls = []

    def fake_cut(src, dest, start, dur):
        cut_calls.append((str(src), dest.name, start, dur))
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"SLICE")
        return dest

    monkeypatch.setattr(recording_flow, "cut_slice", fake_cut)
    monkeypatch.setattr(server, "file_slices", _with_cutter(server.file_slices, fake_cut))
    return types.SimpleNamespace(root=tmp_path, audio=audio, cuts=cut_calls, stub=stub)


def _with_cutter(fn, cutter):
    def wrapped(*args, **kwargs):
        kwargs.setdefault("cutter", cutter)
        return fn(*args, **kwargs)

    return wrapped


SEGMENTS = [
    (70.0, 75.0, "下一位 Ada from AutoArk"),
    (100.0, 104.0, "hello everyone"),
    (1900.0, 1905.0, "second talk"),
]


# ---------------------------------------------------------- pure helpers


def test_cut_slice_runs_avconvert_passthrough(tmp_path):
    seen = {}

    def run(cmd, **kw):
        seen["cmd"] = cmd
        return subprocess.CompletedProcess(cmd, 0, "", "")

    dest = recording_flow.cut_slice("/a/block.m4a", tmp_path / "x" / "s.m4a", 12.5, 60, run=run)
    assert dest.parent.is_dir()
    cmd = seen["cmd"]
    assert cmd[0] == "/usr/bin/avconvert"
    assert cmd[cmd.index("--preset") + 1] == "PresetPassthrough"
    assert cmd[cmd.index("--start") + 1] == "12.500"
    assert cmd[cmd.index("--duration") + 1] == "60.000"
    assert cmd[cmd.index("--source") + 1] == "/a/block.m4a"


def test_cut_slice_raises_on_failure(tmp_path):
    def run(cmd, **kw):
        return subprocess.CompletedProcess(cmd, 1, "", "bad source")

    with pytest.raises(RuntimeError, match="bad source"):
        recording_flow.cut_slice("/a.m4a", tmp_path / "s.m4a", 0, 1, run=run)


def test_audio_duration_reads_afinfo():
    out = "File type ID: m4af\nestimated duration: 15527.123 sec\n"

    def run(cmd, **kw):
        return subprocess.CompletedProcess(cmd, 0, out, "")

    assert recording_flow.audio_duration("/a.m4a", run=run) == pytest.approx(15527.123)


def test_slice_name_is_utc():
    wall = datetime.fromisoformat("2026-11-05T14:30:44+08:00")
    assert recording_flow.slice_name(wall) == "recording-20261105-063044.m4a"


def test_segments_from_payload():
    # The Cat's verbose_json shape (timed-transcripts, 2026-11-06).
    payload = {
        "text": "hi there",
        "duration": 9.0,
        "language": None,
        "segments": [
            {"id": 0, "start": 1, "end": 2, "text": " hi "},
            {"id": 1, "start": "x"},
            {"id": 2, "start": 3, "end": 4, "text": ""},
            {"id": 3, "start": 5, "end": 7, "text": "there"},
        ],
        "words": [],
    }
    assert transcription.segments_from_payload(payload) == [(1.0, 2.0, "hi"), (5.0, 7.0, "there")]
    assert transcription.segments_from_payload({"text": "no segments"}) == []


def test_coarse_segments_fall_back_to_words_or_nothing():
    # The Cat's last resort: one segment over the whole take is text, not timing.
    whole = {"segments": [{"id": 0, "start": 0, "end": 3600, "text": "everything"}], "words": []}
    assert transcription.segments_from_payload(whole) == []
    phrases = [
        {"word": "下一位嘉宾", "start": 10, "end": 12},
        {"word": "next speaker", "start": 900, "end": 902},
    ]
    assert transcription.segments_from_payload({**whole, "words": phrases}) == [
        (10.0, 12.0, "下一位嘉宾"),
        (900.0, 902.0, "next speaker"),
    ]


def test_window_pads_first_and_last():
    events = [
        {"start": "2026-11-05T13:00:00+08:00", "end": "2026-11-05T13:30:00+08:00"},
        {"start": "2026-11-05T13:30:00+08:00", "end": "2026-11-05T14:00:00+08:00"},
    ]
    w0, w1 = recording_flow.window(events)
    assert w0.isoformat() == "2026-11-05T12:58:00+08:00"
    assert w1.isoformat() == "2026-11-05T14:03:00+08:00"
    assert recording_flow.window([]) is None


# ---------------------------------------------------------- filing


def test_block_events_picks_busiest_room(vault):
    evs = server.block_events(SLUG, T0, T0 + timedelta(hours=1))
    assert [e["note"] for e in evs] == list(NOTES)
    assert evs[0]["speakers"] == ["Ada Li"] and evs[0]["orgs"] == ["AutoArk"]
    side = server.block_events(SLUG, T0, T0 + timedelta(hours=1), room="side")
    assert [e["note"] for e in side] == ["1300-side.md"]
    starred = server.block_events(SLUG, T0, T0 + timedelta(hours=1), notes=["1300-side.md"])
    assert [e["note"] for e in starred] == ["1300-side.md"]


def test_split_files_each_slice_beside_its_note(vault):
    out = server.split_block(SLUG, str(vault.audio), segments=SEGMENTS)
    assert out["fallback"] is False
    assert [r["status"] for r in out["results"]] == ["filed", "filed"]
    first = vault.root / SLUG / "notes" / NOTES[0]
    fm, _, secs = server.parse_note(first.read_text())
    # cut starts at 60 s (stub), 30 s padding → slice from 30 s = 05:00:30 UTC
    assert fm["recording"] == "notes/assets/1300-first/recording-20261105-050030.m4a"
    assert fm["recording_full"] == str(vault.audio)
    assert fm["transcript"] == "local-ai-cat"
    assert (vault.root / SLUG / fm["recording"]).read_bytes() == b"SLICE"
    tr = secs["Transcript"]
    assert "Boundary confidence: high" in tr
    assert "[recording-20261105-050030.m4a](assets/1300-first/recording-20261105-050030.m4a)" in tr
    assert "[00:10] 下一位 Ada from AutoArk" in tr
    assert "second talk" not in tr
    assert vault.cuts[0] == (str(vault.audio), "recording-20261105-050030.m4a", 30.0, 1800.0)


def test_split_is_idempotent_and_keeps_existing_transcript(vault):
    first = vault.root / SLUG / "notes" / NOTES[0]
    server.append_transcript(SLUG, NOTES[0], "typed by hand")
    server.split_block(SLUG, str(vault.audio), segments=SEGMENTS)
    again = server.split_block(SLUG, str(vault.audio), segments=SEGMENTS)
    assert [r["status"] for r in again["results"]] == ["skipped", "skipped"]
    tr = server.parse_note(first.read_text())[2]["Transcript"]
    assert tr.startswith("typed by hand")
    assert tr.count("From a block recording") == 1
    assert len(vault.cuts) == 2


def test_split_without_segments_falls_back_to_agenda(vault, monkeypatch):
    monkeypatch.setattr(transcription, "transcribe_segments", lambda *a, **k: [])
    out = server.split_block(SLUG, str(vault.audio))
    assert out["fallback"] is True
    assert "agenda times" in out["detail"]
    assert vault.stub.calls[0][0] and not vault.stub.calls[0][1]
    tr = server.parse_note((vault.root / SLUG / "notes" / NOTES[1]).read_text())[2]["Transcript"]
    assert "Boundary confidence: low" in tr


def test_split_caches_the_cat_segments(vault, monkeypatch):
    calls = []

    def fake_segments(cfg, data, filename, mime):
        calls.append(filename)
        return SEGMENTS

    monkeypatch.setattr(transcription, "transcribe_segments", fake_segments)
    server.split_block(SLUG, str(vault.audio))
    assert calls == ["block.m4a"]
    cache = vault.root / SLUG / ".confnote" / "recordings" / "block.segments.json"
    assert len(json.loads(cache.read_text())["segments"]) == 3
    assert server._timed_segments(SLUG, vault.audio) == SEGMENTS
    assert calls == ["block.m4a"]


def test_explicit_start_moves_the_lid_gaps_with_it(vault, monkeypatch):
    gap = _Gap(T0 + timedelta(minutes=10), T0 + timedelta(minutes=14))
    monkeypatch.setattr(vault.stub, "clamshell_gaps", lambda birth, mtime, log_text=None: [gap])
    later = T0 + timedelta(minutes=5)
    server.split_block(SLUG, str(vault.audio), segments=SEGMENTS, started_at=later)
    _events, gaps = vault.stub.calls[0]
    assert gaps == [(gap[0] + timedelta(minutes=5), gap[1] + timedelta(minutes=5))]


def test_split_missing_audio_is_not_found(vault):
    with pytest.raises(FileNotFoundError):
        server.split_block(SLUG, str(vault.root / "nope.m4a"))


# ---------------------------------------------------------- block + auto


def test_block_start_stop_splits_the_cat_audio(vault, monkeypatch):
    monkeypatch.setattr(
        transcription, "start_recording", lambda cfg: {"id": "rec-1", "state": "recording"}
    )
    stops = []

    def fake_stop(cfg, rec_id, poll_timeout=300.0):
        stops.append((rec_id, poll_timeout))
        return {
            "state": "completed",
            "audioPath": str(vault.audio),
            "segments": [{"start": t0, "end": t1, "text": text} for t0, t1, text in SEGMENTS],
        }

    monkeypatch.setattr(transcription, "stop_recording", fake_stop)
    assert server.start_block(SLUG)["recording"] is True
    assert server.block_status(SLUG)["recording"] is True
    out = server.stop_block(SLUG)
    assert stops == [("rec-1", server.BLOCK_POLL_TIMEOUT_S)]
    assert out["audio_path"] == str(vault.audio)
    assert [r["status"] for r in out["results"]] == ["filed", "filed"]
    assert server.block_status(SLUG) == {"recording": False}
    with pytest.raises(LookupError):
        server.stop_block(SLUG)


def test_auto_tick_starts_and_stops_on_the_starred_window(vault, monkeypatch):
    started, stopped = [], []
    monkeypatch.setattr(server, "auto_enabled", lambda: True)
    # The timer reads the picks from the notes, not from what the page pushed.
    monkeypatch.setattr(server, "_AUTO", {SLUG: []})
    server.set_picks(SLUG, dict.fromkeys(NOTES, True))

    def fake_start(slug, notes=None, auto=False):
        started.append(slug)
        server._BLOCKS[slug] = {"id": "r", "started_at": T0, "notes": notes, "auto": auto}

    def fake_stop(slug):
        stopped.append(slug)
        server._BLOCKS.pop(slug, None)

    monkeypatch.setattr(server, "start_block", fake_start)
    monkeypatch.setattr(server, "stop_block", fake_stop)
    server.auto_tick(T0 - timedelta(minutes=5))
    assert started == []
    server.auto_tick(T0 - timedelta(minutes=1))  # 12:59 +08, inside 12:58 start
    assert started == [SLUG]
    server.auto_tick(T0 + timedelta(minutes=62))  # 14:02, before 14:03 end
    assert stopped == []
    server.auto_tick(T0 + timedelta(minutes=63))
    assert stopped == [SLUG]


def test_auto_tick_off_without_setting_or_stars(vault, monkeypatch):
    monkeypatch.setattr(server, "start_block", lambda *a, **k: pytest.fail("started"))
    monkeypatch.setattr(server, "_AUTO", {SLUG: list(NOTES)})
    monkeypatch.setattr(server, "auto_enabled", lambda: False)
    server.auto_tick(T0)
    monkeypatch.setattr(server, "auto_enabled", lambda: True)
    # Pushed stars without picks in the notes start nothing.
    monkeypatch.setattr(server, "_AUTO", {SLUG: list(NOTES)})
    server.auto_tick(T0)


def test_settings_carry_the_auto_switch():
    assert server._DEFAULT_SETTINGS["transcription"]["auto_record_block"] is False


# ---------------------------------------------------------- routes


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def api(vault):
    port = _free_port()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), server.Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        httpd.shutdown()
        thread.join(timeout=3)


def _post(base, path, payload, same_origin=True):
    headers = {"Content-Type": "application/json"}
    if same_origin:
        headers |= {"Origin": base, "X-Confnote-Request": "1"}
    req = urllib.request.Request(base + path, json.dumps(payload).encode(), headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_split_route_needs_same_origin(api, vault):
    code, body = _post(
        api, "/api/recording/split", {"slug": SLUG, "audio_path": str(vault.audio)}, False
    )
    assert code == 403
    assert vault.cuts == []


def test_split_route_files_the_slices(api, vault, tmp_path):
    seg_file = tmp_path / "segments.json"
    seg_file.write_text(
        json.dumps({"segments": [{"start": a, "end": b, "text": t} for a, b, t in SEGMENTS]})
    )
    code, body = _post(
        api,
        "/api/recording/split",
        {"slug": SLUG, "audio_path": str(vault.audio), "segments_path": str(seg_file)},
    )
    assert code == 200, body
    assert [r["note"] for r in body["results"]] == list(NOTES)
    assert all(r["status"] == "filed" for r in body["results"])


def test_recording_routes_reject_unknown_conference_and_audio(api, vault):
    assert _post(api, "/api/recording/split", {"slug": "2026-01-01-nope"})[0] == 404
    code, body = _post(api, "/api/recording/split", {"slug": SLUG, "audio_path": "/nope.m4a"})
    assert code == 404
    assert _post(api, "/api/recording/block/stop", {"slug": SLUG})[0] == 409


def test_auto_route_registers_stars(api, vault, monkeypatch):
    monkeypatch.setattr(server, "_AUTO", {})
    monkeypatch.setattr(server, "_AUTO_THREAD", [object()])  # no real timer thread
    code, body = _post(api, "/api/recording/auto", {"slug": SLUG, "notes": [NOTES[0], 3]})
    assert code == 200 and body["recording"] is False
    assert list(server._AUTO.items()) == [(SLUG, [NOTES[0]])]
