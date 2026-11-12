from __future__ import annotations

import sys

sys.path.insert(0, "tools")
import import_agenda  # noqa: E402


def _two_day_agenda():
    return {
        "conference": {"name": "Two Day Conf", "date": "2026-11-05", "timezone": "Asia/Shanghai"},
        "speakers": {},
        "events": [
            {
                "id": "day-two-talk",
                "type": "talk",
                "title": "Day Two Talk",
                "start": "2026-11-06T10:05:00+08:00",
                "end": "2026-11-06T10:25:00+08:00",
                "room": "main-stage",
                "speakers": [],
            }
        ],
    }


def test_note_time_uses_the_event_date_not_the_conference_start(tmp_path):
    data = _two_day_agenda()

    assert import_agenda.write_note(tmp_path, data["events"][0], data)

    note = (tmp_path / "1005-day-two-talk.md").read_text()
    assert "time: 2026-11-06 10:05–10:25 (Asia/Shanghai)" in note
