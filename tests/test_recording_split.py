"""Block recording split: boundaries from a timed transcript, sleep gaps, slice padding.

The fixture is the AI Engineer Shanghai 2026 main-stage block recording of
2026-11-05, only the timed segments within 3 min of each hand-split boundary.
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, "packages/local-app")
import recording_split as rs  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "record-split" / "shanghai-main-stage.json"
TOLERANCE = 60
# The high-confidence boundaries split by hand (FINDINGS §2), file seconds.
HIGH_STARTS = {
    "1300-community-in-the-ai-era.md": 0,
    "1345-from-model-intelligence-to-agent-harness-enabling-long-horizon-agents.md": 998,
    "1405-dark-factory-to-lobsterville-intent-engineering-for-persistent-multiplayer-agents.md": 2302,
    "1430-on-device-ai-bringing-intelligence-closer-to-everyone.md": 3737,
    "1450-kubernetes-is-not-your-sandbox.md": 4940,
    "1510-ai-native-work-at-manus-one-monorepo-open-tasks.md": 5818,
    "1535-powering-open-source-personal-agents-with-exa-search.md": 7521,
    "1615-building-a-reliable-multi-region-llm-gateway.md": 10048,
    "1640-nobody-planned-ai-infra-how-ai-builders-pushed-a-database-beyond-the-database.md": 11434,
    "1710-optimizing-organization-wide-llm-inference-cost-seat-license-pay-per-token-or-provisioned-and-beyond.md": 12660,
}
FIRST_SESSION_END = 991
CST = datetime.fromisoformat("2026-11-05T00:00:00+08:00").tzinfo
LID_SHUT = datetime(2026, 11, 5, 14, 23, 25, tzinfo=CST)
LID_OPEN = datetime(2026, 11, 5, 14, 27, 47, tzinfo=CST)


@pytest.fixture(scope="module")
def block():
    doc = json.loads(FIXTURE.read_text())
    started = datetime.fromisoformat(doc["started_at"])
    mtime = started + timedelta(hours=5)
    gaps = rs.clamshell_gaps(started, mtime, "\n".join(doc["pmset"]))
    cuts = rs.find_boundaries(doc["segments"], doc["events"], started_at=started, gaps=gaps)
    return doc, started, gaps, cuts


def test_fixture_stays_small():
    assert FIXTURE.stat().st_size < 200 * 1024


def test_high_confidence_boundaries_within_a_minute(block):
    _, _, _, cuts = block
    by_note = {c.note: c for c in cuts}
    misses = {
        note: by_note[note].start
        for note, truth in HIGH_STARTS.items()
        if abs(by_note[note].start - truth) > TOLERANCE
    }
    assert not misses, misses
    for note in HIGH_STARTS:
        assert by_note[note].confidence == "high", (note, by_note[note].evidence)
        assert by_note[note].evidence


def test_one_cut_per_event_in_agenda_order(block):
    doc, _, _, cuts = block
    assert [c.note for c in cuts] == [e["note"] for e in doc["events"]]
    starts = [c.start for c in cuts]
    assert starts == sorted(starts)
    assert len(set(starts)) == len(starts)
    for cut, nxt in zip(cuts, cuts[1:], strict=False):
        assert cut.end == nxt.start
    assert abs(cuts[0].end - FIRST_SESSION_END) <= TOLERANCE


def test_wall_times_skip_the_lid_shut_gap(block):
    _, started, gaps, cuts = block
    alex = cuts[3]
    # 1:02:17 into the file is 14:26:48 by naive addition, 14:31:09 once the 262 s sleep is added.
    assert alex.wall_start == rs.wall_time(alex.start, started, gaps)
    assert alex.wall_start - (started + timedelta(seconds=alex.start)) == timedelta(seconds=262)
    assert cuts[1].wall_start == started + timedelta(seconds=cuts[1].start)


def test_clamshell_gaps_parse_pmset():
    log = "\n".join(
        [
            "2026-11-05 12:00:00 +0800 Sleep               \tEntering Sleep state due to 'Clamshell Sleep':TCPKeepAlive=active",
            "2026-11-05 12:05:00 +0800 Wake                \tWake from Deep Idle [CDNVA] : due to lid",
            "2026-11-05 14:23:25 +0800 Sleep               \tEntering Sleep state due to 'Clamshell Sleep':TCPKeepAlive=active",
            "2026-11-05 14:23:27 +0800 Wake Requests       \t[process=mDNSResponder request=Maintenance]",
            "2026-11-05 14:25:00 +0800 DarkWake            \tDarkWake from Deep Idle [CDNP] : due to RTC/Maintenance",
            "2026-11-05 14:25:30 +0800 Sleep               \tEntering Sleep state due to 'Maintenance Sleep'",
            "2026-11-05 14:27:47 +0800 Wake                \tWake from Deep Idle [CDNVA] : due to lid",
            "2026-11-05 17:40:00 +0800 Sleep               \tEntering Sleep state due to 'Clamshell Sleep'",
            "2026-11-05 18:00:00 +0800 Wake                \tWake from Deep Idle [CDNVA] : due to lid",
        ]
    )
    birth = datetime(2026, 11, 5, 13, 24, 31, tzinfo=CST)
    mtime = datetime(2026, 11, 5, 17, 47, 44, tzinfo=CST)
    gaps = rs.clamshell_gaps(birth, mtime, log)
    assert gaps == [
        rs.Gap(LID_SHUT, LID_OPEN),
        rs.Gap(datetime(2026, 11, 5, 17, 40, tzinfo=CST), mtime),
    ]
    assert gaps[0].seconds == 262


def test_clamshell_gaps_ignore_unfinished_sleep():
    log = "2026-11-05 14:23:25 +0800 Sleep               \tEntering Sleep state due to 'Clamshell Sleep'"
    birth = datetime(2026, 11, 5, 13, 0, tzinfo=CST)
    assert rs.clamshell_gaps(birth, birth + timedelta(hours=4), log) == []


def test_wall_time_and_file_offset_round_trip():
    started = datetime(2026, 11, 5, 13, 24, 31, tzinfo=CST)
    gaps = [rs.Gap(LID_SHUT, LID_OPEN)]
    before_gap = (LID_SHUT - started).total_seconds()
    assert rs.wall_time(before_gap - 1, started, gaps) == LID_SHUT - timedelta(seconds=1)
    assert rs.wall_time(before_gap, started, gaps) == LID_OPEN
    assert rs.wall_time(before_gap + 60, started, gaps) == LID_OPEN + timedelta(seconds=60)
    for offset in (0, 100.5, before_gap - 5, before_gap + 5, 9000):
        assert rs.file_offset(rs.wall_time(offset, started, gaps), started, gaps) == offset
    # A time inside the gap maps to where the file resumes.
    assert rs.file_offset(LID_SHUT + timedelta(seconds=100), started, gaps) == before_gap
    assert rs.wall_time(500, started, []) == started + timedelta(seconds=500)


def test_plan_slices_pads_and_clamps():
    started = datetime(2026, 11, 5, 13, 24, 31, tzinfo=CST)
    cut = _cut("a.md", 10, 400, started)
    mid = _cut("b.md", 400, 900, started)
    last = _cut("c.md", 900, 990, started)
    slices = rs.plan_slices([cut, mid, last], duration=1000)
    assert [(s.start, s.end) for s in slices] == [(0, 430), (370, 930), (870, 1000)]
    assert [s.pad_before for s in slices] == [10, 30, 30]
    assert slices[1].duration == 560
    assert slices[1].wall_start == started + timedelta(seconds=370)
    assert slices[1].cut is mid
    assert slices[0].file_name == "recording-20261105-052431.m4a"
    narrow = rs.plan_slices([cut], duration=1000, pad=5)[0]
    assert (narrow.start, narrow.end) == (5, 405)


def test_plan_slices_names_by_utc_start(block):
    _, _, _, cuts = block
    alex = rs.plan_slices([cuts[3]], duration=15526.8)[0]
    expected = (cuts[3].wall_start - timedelta(seconds=30)).astimezone(UTC)
    assert alex.file_name == f"recording-{expected:%Y%m%d-%H%M%S}.m4a"
    assert alex.file_name.startswith("recording-20261105-0630")


def test_no_segments_falls_back_to_agenda_times():
    started = datetime(2026, 11, 5, 13, 58, tzinfo=CST)
    events = [
        _event("1400-a.md", "14:00", "14:20"),
        _event("1420-b.md", "14:20", "14:40"),
    ]
    cuts = rs.find_boundaries([], events, started_at=started, gaps=[])
    assert [(c.start, c.end) for c in cuts] == [(120, 1320), (1320, 2520)]
    assert {c.confidence for c in cuts} == {"low"}
    assert all("agenda" in c.evidence for c in cuts)


def test_hand_off_beats_agenda_time_in_both_languages():
    started = datetime(2026, 11, 5, 9, 58, tzinfo=CST)
    events = [
        rs.Event("1000-a.md", "Scaling Retrieval", _at("10:00"), _at("10:20"), ("Mia Chen",)),
        {
            "note": "1020-b.md",
            "title": "Kernel Fusion for Inference",
            "start": "2026-11-05T10:20:00+08:00",
            "end": "2026-11-05T10:40:00+08:00",
            "speakers": ["王磊"],
            "orgs": ["Fluxion"],
        },
    ]
    segments = [
        {"start": 100, "end": 104, "text": "Next speaker is Mia Chen, please welcome"},
        (110, 115, "Hi, I'm Mia and today: scaling retrieval"),
        (500, 505, "we cache the retrieval index"),
        (1000, 1003, "谢谢Mia"),
        (1004, 1008, "下一位嘉宾是来自Fluxion的王磊,大家掌声欢迎"),
        (1015, 1020, "大家好 我是王磊"),
        (2000, 2004, "Thank you."),
    ]
    cuts = rs.find_boundaries(segments, events, started_at=started, gaps=[])
    # The second talk starts 6 min before its agenda slot, at the MC's thank-you.
    assert [c.start for c in cuts] == [100, 1000]
    assert [c.confidence for c in cuts] == ["high", "high"]
    assert "下一位嘉宾" in cuts[1].evidence
    # The last cut ends at its last real line; the bare "Thank you." is filler.
    assert cuts[1].end == 1020


def _at(hhmm: str) -> datetime:
    return datetime.fromisoformat(f"2026-11-05T{hhmm}:00+08:00")


def _event(note: str, start: str, end: str) -> rs.Event:
    return rs.Event(note, note, _at(start), _at(end))


def _cut(note: str, start: float, end: float, started: datetime) -> rs.Cut:
    return rs.Cut(
        note=note,
        title=note,
        start=start,
        end=end,
        wall_start=started + timedelta(seconds=start),
        wall_end=started + timedelta(seconds=end),
        confidence="high",
        evidence="",
    )
