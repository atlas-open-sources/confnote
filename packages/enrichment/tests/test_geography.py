import hashlib
import json
from datetime import UTC, datetime

import pytest
from enrichment.fetch import Snapshot
from enrichment.geography import event_status, resolve_place
from enrichment.importers import confs_tech, luma_ical
from enrichment.pipeline import check_candidate

NOW = datetime(2026, 11, 1, tzinfo=UTC)


def ical_snapshot(summary, location, *, end="20261208T103000Z", status="TENTATIVE"):
    # Physical line folding and location shape match the real public Luma snapshot.
    text = f"BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:fixture@events.lu.ma\r\nSUMMARY:{summary}\r\nLOCATION:{location}\r\nDTSTART:20261208T090000Z\r\nDTEND:{end}\r\nSTATUS:{status}\r\nURL:https://luma.com/fixture\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
    return Snapshot(
        "https://example.org/calendar.ics",
        NOW.isoformat(),
        "sha256:" + hashlib.sha256(text.encode()).hexdigest(),
        text,
    )


def test_real_okayama_shape_keeps_utc_instants_and_resolves_local_zone():
    snapshot = ical_snapshot(
        "Okayama | Claude Workshop",
        "コワーキングスペース Wonderwall, Japan, 〒700-0023 Okayama, Kita Ward, Ekimaechō, 1-chōme−8−１８ ２F",
    )
    event = luma_ical(snapshot, now=NOW)[0]
    assert (event["city"], event["country"], event["timezone"]) == ("Okayama", "JP", "Asia/Tokyo")
    assert event["start"] == "2026-12-08T09:00:00+00:00"
    assert event["status"] == "scheduled"
    for field in ("city", "country", "timezone"):
        assert event["provenance"][field][0]["locator"].startswith("ical:LOCATION")
        assert event["provenance"][field][0]["quote"] in snapshot.text
    assert check_candidate(event, snapshot) == []


def test_hidden_address_title_city_is_supported_not_fabricated_online():
    snapshot = ical_snapshot("Codex Community Meetup: Seoul", "https://luma.com/event/evt-example")
    event = luma_ical(snapshot, now=NOW)[0]
    assert (event["city"], event["country"], event["timezone"]) == ("Seoul", "KR", "Asia/Seoul")
    assert event["attendance_mode"] == "offline"
    assert event["provenance"]["city"][0]["locator"].startswith("ical:SUMMARY")


@pytest.mark.parametrize(
    "location,summary",
    [
        ("Online", "London meetup"),
        ("https://zoom.us/j/123", "Seoul session"),
        ("https://luma.com/event/a", "Online workshop: Tokyo"),
    ],
)
def test_online_has_no_city(location, summary):
    event = luma_ical(ical_snapshot(summary, location), now=NOW)[0]
    assert event["attendance_mode"] == "online"
    assert "city" not in event and "country" not in event
    assert event["timezone"] is None


@pytest.mark.parametrize(
    "location,summary",
    [
        ("", "London meetup"),
        ("London, Canada", "meetup"),
        ("", "SHIGA meetup"),
        ("Seoul and Tokyo", "meetup"),
        ("", "Sydney meetup"),
    ],
)
def test_ambiguous_or_unmapped_stays_unknown(location, summary):
    assert resolve_place(location, summary) == ({}, None)


def test_london_requires_uk_context():
    fields, locator = resolve_place(
        "Tessl AI Limited, 210 Pentonville Rd, London N1 9JY, UK", "Hugging Face London #4"
    )
    assert fields["timezone"] == "Europe/London"
    assert fields["country"] == "GB" and locator == "LOCATION"


def test_status_clock_and_source_cancellation():
    assert event_status("2026-03-05T21:00:00Z", "TENTATIVE", now=NOW) == "completed"
    assert event_status("2026-12-05T21:00:00Z", None, now=NOW) == "scheduled"
    assert event_status("2026-03-05T21:00:00Z", "CANCELLED", now=NOW) == "cancelled"
    assert event_status("2026-03-05T21:00:00Z", "POSTPONED", now=NOW) == "postponed"
    assert event_status("2026-11-01", None, now=NOW, timezone="Asia/Tokyo") == "scheduled"
    assert (
        event_status(
            "2026-11-01", None, now=datetime(2026, 11, 1, 15, tzinfo=UTC), timezone="Asia/Tokyo"
        )
        == "completed"
    )
    with pytest.raises(ValueError, match="timezone-aware"):
        event_status("2026-11-01", None, now=datetime(2026, 11, 1))


def test_confs_iso_country_and_online_location_omission():
    rows = [
        {
            "name": "Python London",
            "startDate": "2026-12-01",
            "endDate": "2026-12-02",
            "url": "https://example.org",
            "city": "London",
            "country": "GB",
        }
    ]
    text = json.dumps(rows)
    snapshot = Snapshot(
        "https://example.org/feed",
        NOW.isoformat(),
        "sha256:" + hashlib.sha256(text.encode()).hexdigest(),
        text,
    )
    event = confs_tech(snapshot, topic="python", now=NOW)[0]
    assert event["timezone"] == "Europe/London"
    rows[0]["online"] = True
    text = json.dumps(rows)
    snapshot = Snapshot(
        snapshot.url,
        snapshot.fetched_at,
        "sha256:" + hashlib.sha256(text.encode()).hexdigest(),
        text,
    )
    event = confs_tech(snapshot, topic="python", now=NOW)[0]
    assert "city" not in event and "country" not in event
    assert event["attendance_mode"] == "online"
    assert check_candidate(event, snapshot) == []


def test_source_cancellation_and_location_reach_calendar_export():
    from enrichment.publish import calendar

    event = luma_ical(ical_snapshot("Seoul meetup", "Seoul", status="CANCELLED"), now=NOW)[0]
    output = calendar([event])
    assert "STATUS:CANCELLED\r\n" in output
    assert "LOCATION:Seoul\\, KR\r\n" in output


def test_confs_actual_us_country_spelling_and_city_region():
    row = {
        "name": "PyConf",
        "startDate": "2026-11-15",
        "endDate": "2026-11-16",
        "url": "https://example.org",
        "city": "San Francisco, CA",
        "country": "U.S.A.",
        "online": False,
    }
    text = json.dumps([row])
    snapshot = Snapshot(
        "https://example.org/feed",
        NOW.isoformat(),
        "sha256:" + hashlib.sha256(text.encode()).hexdigest(),
        text,
    )
    event = confs_tech(snapshot, topic="python", now=NOW)[0]
    assert (event["city"], event["country"], event["timezone"]) == (
        "San Francisco",
        "US",
        "America/Los_Angeles",
    )
    assert event["provenance"]["country"][0]["quote"] == '"U.S.A."'
    assert check_candidate(event, snapshot) == []
