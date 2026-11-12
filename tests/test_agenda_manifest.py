from __future__ import annotations

import json
import sys

sys.path.insert(0, "packages/local-app")
import agenda_manifest  # noqa: E402
import server  # noqa: E402


def _manifest():
    return {
        "schema_version": "confnote.agenda.v1",
        "conference": {
            "name": "Manifest Conf",
            "date": "2026-09-12",
            "timezone": "Europe/London",
            "venue": {"name": "Main Hall"},
        },
        "rooms": [{"name": "Main Hall"}],
        "tracks": [{"name": "Agents"}],
        "speakers": {
            "ada": {
                "name": "Ada Lovelace",
                "role": "Founder",
                "company": "Analytical Engines",
            }
        },
        "events": [
            {
                "id": "opening",
                "type": "keynote",
                "title": "Opening",
                "start": "2026-09-12T09:00:00+01:00",
                "end": "2026-09-12T09:45:00+01:00",
                "room": "main-hall",
                "track": "agents",
                "speakers": ["ada"],
                "links": ["https://example.com/opening"],
            }
        ],
        "sources": ["https://example.com/agenda"],
    }


def test_manifest_validates_and_normalizes():
    out = agenda_manifest.validate_manifest(_manifest(), require_schema_version=True)
    assert out["ok"] is True
    assert out["summary"]["slug"] == "2026-09-12-manifest-conf"
    assert out["manifest"]["rooms"][0] == {"id": "main-hall", "name": "Main Hall"}
    assert out["manifest"]["events"][0]["links"] == [{"url": "https://example.com/opening"}]


def test_manifest_rejects_missing_required_fields():
    out = agenda_manifest.validate_manifest({"conference": {"name": "Bad"}, "events": []})
    assert out["ok"] is False
    assert "conference.date is required" in out["errors"]
    assert "events must contain at least one item" in out["errors"]


def test_create_conference_imports_v1_and_preserves_notes(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    msg = server.create_conference(_manifest())
    assert "Manifest Conf" in msg
    slug = "2026-09-12-manifest-conf"
    note = tmp_path / slug / "notes" / "0900-opening.md"
    assert note.is_file()
    text = note.read_text()
    assert "track: agents" in text
    assert "[https://example.com/opening](https://example.com/opening)" in text
    assert (tmp_path / slug / "notes" / "assets" / "0900-opening" / "README.txt").is_file()

    note.write_text(text + "\n\nLOCAL EDIT\n")
    server.create_conference(json.loads((tmp_path / slug / "agenda.json").read_text()))
    assert "LOCAL EDIT" in note.read_text()


def _parallel_manifest():
    manifest = _manifest()
    manifest["rooms"] = [
        {"id": "main-stage", "name": "Main stage"},
        {"id": "breakout", "name": "AI applications breakout"},
    ]
    manifest["events"] = [
        {
            "id": "harness",
            "title": "Agent harness",
            "start": "2026-09-12T13:45:00+01:00",
            "end": "2026-09-12T14:05:00+01:00",
            "room": "main-stage",
        },
        {
            "id": "youmind",
            "title": "Building a Personal Agent",
            "start": "2026-09-12T13:45:00+01:00",
            "end": "2026-09-12T14:05:00+01:00",
            "room": "breakout",
            "track": "applications",
        },
    ]
    return manifest


def test_import_keeps_parallel_rooms_through_to_the_conference_payload(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    server.create_conference(_parallel_manifest())
    slug = "2026-09-12-manifest-conf"
    saved = json.loads((tmp_path / slug / "agenda.json").read_text())
    assert [e["room"] for e in saved["events"]] == ["main-stage", "breakout"]
    # an event's unlisted track is added, so its column still has a label
    assert {"id": "applications", "name": "applications"} in saved["tracks"]

    payload = server.conference_payload(slug)
    assert payload["rooms"] == [
        {"id": "main-stage", "name": "Main stage"},
        {"id": "breakout", "name": "AI applications breakout"},
    ]
    assert [(e["room"], e["track"]) for e in payload["events"]] == [
        ("main-stage", ""),
        ("breakout", "applications"),
    ]


def test_manifest_warns_when_parallel_sessions_have_no_room():
    flattened = _parallel_manifest()
    for event in flattened["events"]:
        event.pop("room")
        event.pop("track", None)
    out = agenda_manifest.validate_manifest(flattened)
    assert out["ok"] is True
    assert any("overlap other events but have no room" in w for w in out["warnings"])

    placed = agenda_manifest.validate_manifest(_parallel_manifest())
    assert not any("overlap" in w for w in placed["warnings"])
