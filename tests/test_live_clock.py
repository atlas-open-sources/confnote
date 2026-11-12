"""Conference status respects overlapping breaks and exact session boundaries."""

from datetime import datetime

import server


def event(title, start, end, kind="talk"):
    return {
        "title": title,
        "type": kind,
        "start": f"2026-09-29T{start}:00-07:00",
        "end": f"2026-09-29T{end}:00-07:00",
    }


def test_talks_take_precedence_over_overlapping_lunch():
    data = {
        "events": [
            event("Lunch", "11:30", "13:00", "break"),
            event("Morning talk", "12:00", "12:40"),
            event("Afternoon talk", "12:45", "13:25"),
        ]
    }
    status = server.conf_status(data, datetime.fromisoformat("2026-09-29T12:50:00-07:00"))
    assert "LIVE: 'Afternoon talk'" in status
    assert "Lunch" not in status
    assert "Morning talk" not in status


def test_session_end_is_exclusive_and_last_end_is_maximum():
    data = {
        "events": [event("Long workshop", "12:00", "14:00"), event("Short talk", "13:00", "13:30")]
    }
    status = server.conf_status(data, datetime.fromisoformat("2026-09-29T13:30:00-07:00"))
    assert "LIVE: 'Long workshop'" in status
    assert "Short talk" not in status
    assert server.conf_status(data, datetime.fromisoformat("2026-09-29T14:00:00-07:00")).startswith(
        "Post-conference"
    )


def test_parallel_talks_are_all_in_agent_context():
    data = {"events": [event("Talk A", "12:00", "12:40"), event("Talk B", "12:00", "12:40")]}
    status = server.conf_status(data, datetime.fromisoformat("2026-09-29T12:15:00-07:00"))
    assert "Talk A" in status and "Talk B" in status
