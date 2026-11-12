"""Regression coverage for reviewed ownership and local-day boundaries."""

import copy
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages/events-model/python"))
from events_model import validate_catalogue  # noqa: E402
from events_model.migration import migrate_agenda  # noqa: E402


def agenda():
    value = json.loads((ROOT / "tests/e2e/seed-agenda.json").read_text())
    value["schema_version"] = "confnote.agenda.v2"
    return value


def test_alias_import_rejected_before_existing_notes_change(tmp_path, monkeypatch):
    import server

    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    source = agenda()
    server.create_conference(source)
    slug = server.conference_slug(source)
    original = {p: p.read_bytes() for p in (tmp_path / slug).rglob("*") if p.is_file()}
    source["events"][1]["note_file"] = f"session-{source['events'][0]['id']}.md"
    with pytest.raises(ValueError, match="another session|duplicate"):
        server.create_conference(source)
    assert original == {p: p.read_bytes() for p in original}
    path = tmp_path / "hostile.json"
    path.write_text(json.dumps(source))
    result = subprocess.run(
        [sys.executable, str(ROOT / "tools/import_agenda.py"), str(path), str(tmp_path / "cli")],
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    assert "another session" in result.stderr
    assert not (tmp_path / "cli").exists()


def test_migrations_reject_duplicate_targets(tmp_path):
    source = agenda()
    for event in source["events"][:2]:
        event["note_file"] = "session-shared.md"
    with pytest.raises(ValueError, match="duplicate"):
        migrate_agenda(source)
    path = tmp_path / "alias.json"
    path.write_text(json.dumps(source))
    result = subprocess.run(
        [
            str(ROOT / "packages/events-model/node_modules/.bin/tsx"),
            str(ROOT / "packages/events-model/test/migrate-cli.ts"),
            str(path),
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    assert "duplicate" in result.stderr


def test_unsafe_old_session_does_not_break_list(tmp_path, monkeypatch):
    import server

    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    source = agenda()
    server.create_conference(source)
    slug = server.conference_slug(source)
    path = tmp_path / slug / "agenda.json"
    stored = json.loads(path.read_text())
    stored["events"][0]["id"] = "talk.1"
    stored["events"][0].pop("note_file")
    path.write_text(json.dumps(stored))
    assert len(server.conferences_payload()) == 1
    assert server.conference_payload(slug)


def test_timezone_extension_and_migration_parity(tmp_path):
    fixture = json.loads((ROOT / "packages/events-model/fixtures/catalogue.json").read_text())
    event = fixture["events"][0]
    event.update(
        timezone="America/Los_Angeles",
        format="concert",
        level="advanced",
        region="west",
        extensions={"future": {"enabled": True}},
    )
    session = {"id": "evening", "kind": "session", "title": "Evening"}
    fixture["sessions"] = [session]
    session.update(
        event=event["id"],
        start="2026-11-02T01:00:00Z",
        end="2026-11-02T02:00:00Z",
        day="2026-11-01",
    )
    validate_catalogue(fixture)
    bad = copy.deepcopy(fixture)
    bad["sessions"][0]["day"] = "2026-11-02"
    with pytest.raises(ValueError, match="day"):
        validate_catalogue(bad)
    source = agenda()
    source["conference"].update(timezone="America/Los_Angeles", end_date="2027-01-01")
    source["events"][0].update(start=session["start"], end=session["end"], note_file=None)
    expected = migrate_agenda(source)
    assert expected["events"][0]["day"] == "2026-11-01"
    assert expected["conference"]["end_date"] == "2027-01-01"
    from agenda_manifest import validate_manifest

    assert validate_manifest(source)["manifest"]["events"][0]["day"] == "2026-11-01"
    path = tmp_path / "timezone.json"
    path.write_text(json.dumps(source))
    result = subprocess.run(
        [
            str(ROOT / "packages/events-model/node_modules/.bin/tsx"),
            str(ROOT / "packages/events-model/test/migrate-cli.ts"),
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    assert json.loads(result.stdout) == expected


def test_worldsfair_runtime_import_creates_all_notes(tmp_path, monkeypatch):
    import server
    from events_model.worldsfair import worldsfair_agenda

    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    raw = json.loads((ROOT / "data/ai-engineer-worldsfair-2026/sessions.json").read_text())
    source = worldsfair_agenda(raw)
    server.create_conference(source)
    directory = tmp_path / server.conference_slug(source)
    notes = list((directory / "notes").glob("*.md"))
    assert len(notes) == 560
    event = next(e for e in source["events"] if e["day"] == "2026-07-02")
    text = (directory / "notes" / event["note_file"]).read_text()
    assert "day: 2026-07-02" in text
    assert "time: 2026-07-02" in text


def test_note_frontmatter_uses_event_timezone(tmp_path, monkeypatch):
    import server

    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    source = agenda()
    source["conference"]["timezone"] = "America/Los_Angeles"
    source["events"][0].update(start="2026-11-02T01:00:00Z", end="2026-11-02T02:00:00Z")
    server.create_conference(source)
    note = (
        tmp_path
        / server.conference_slug(source)
        / "notes"
        / f"session-{source['events'][0]['id']}.md"
    )
    assert "day: 2026-11-01" in note.read_text()
    assert "time: 2026-11-01 17:00–18:00 (America/Los_Angeles)" in note.read_text()
