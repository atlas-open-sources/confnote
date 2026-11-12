"""The same schema fixture is exercised in Python and TypeScript."""

import copy
import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages/events-model/python"))
from events_model import validate_catalogue, validate_event  # noqa: E402


def test_catalogue_schema_and_semantics():
    fixture = json.loads((ROOT / "packages/events-model/fixtures/catalogue.json").read_text())
    validate_catalogue(fixture)
    for changes in (
        {"id": "../escape"},
        {"end": "2026-10-01"},
        {"timezone": "Nowhere/City"},
        {"start": "2026-02-30"},
    ):
        with pytest.raises(ValueError):
            validate_event({**fixture["events"][0], **changes})
    duplicate = copy.deepcopy(fixture)
    duplicate["events"] *= 2
    with pytest.raises(ValueError, match="duplicate"):
        validate_catalogue(duplicate)


def test_vault_migration_preserves_bytes_paths_and_identity(tmp_path):
    from events_model.migration import migrate_agenda, migrate_vault

    source = json.loads((ROOT / "tests/e2e/seed-agenda.json").read_text())
    original = copy.deepcopy(source)
    notes = tmp_path / "notes"
    notes.mkdir()
    (tmp_path / "agenda.json").write_text(json.dumps(source))
    migrated = migrate_agenda(source)
    for event in migrated["events"]:
        (notes / event["note_file"]).write_text("human notes\nPrivate: encrypted\n")
        assets = notes / "assets" / Path(event["note_file"]).stem
        assets.mkdir(parents=True)
        (assets / "recording.bin").write_bytes(b"\x00\x01\x02")
    before = {str(p.relative_to(notes)): p.read_bytes() for p in notes.rglob("*") if p.is_file()}
    assert migrate_vault(tmp_path) == migrated
    assert migrate_vault(tmp_path) == migrated
    assert before == {
        str(p.relative_to(notes)): p.read_bytes() for p in notes.rglob("*") if p.is_file()
    }
    assert source == original
    migrated["events"][0]["start"] = "2026-11-02T12:00:00Z"
    assert migrate_agenda(migrated)["events"][0]["note_file"] == migrated["events"][0]["note_file"]
    source["events"][0]["id"] = "../escape"
    with pytest.raises(ValueError):
        migrate_agenda(source)


def test_migration_python_typescript_identical(tmp_path):
    import subprocess

    from events_model.migration import migrate_agenda

    source_path = ROOT / "tests/e2e/seed-agenda.json"
    expected = migrate_agenda(json.loads(source_path.read_text()))
    runner = ROOT / "packages/events-model/node_modules/.bin/tsx"
    if not runner.exists():
        if os.environ.get("CONFNOTE_REQUIRE_TS_PARITY") == "1":
            pytest.fail("events-model npm ci required for cross-language gate")
        pytest.skip("events-model npm ci required for cross-language gate")
    result = subprocess.run(
        [str(runner), str(ROOT / "packages/events-model/test/migrate-cli.ts"), str(source_path)],
        check=True,
        capture_output=True,
        text=True,
    )
    assert json.loads(result.stdout) == expected


def test_worldsfair_all_sessions_migrate_across_four_days(tmp_path):
    import subprocess

    from events_model.migration import migrate_agenda, migrate_vault
    from events_model.worldsfair import worldsfair_agenda

    raw = json.loads((ROOT / "data/ai-engineer-worldsfair-2026/sessions.json").read_text())
    agenda = worldsfair_agenda(raw)
    assert len(agenda["events"]) == 560
    assert len({e["id"] for e in agenda["events"]}) == 560
    assert len({e["day"] for e in agenda["events"]}) == 4
    assert agenda["conference"]["end_date"] == "2026-07-02"
    assert migrate_agenda(agenda) == agenda
    path = tmp_path / "agenda.json"
    path.write_text(json.dumps(agenda))
    assert migrate_vault(tmp_path) == agenda
    runner = ROOT / "packages/events-model/node_modules/.bin/tsx"
    if not runner.exists() and os.environ.get("CONFNOTE_REQUIRE_TS_PARITY") == "1":
        pytest.fail("events-model npm ci required for cross-language gate")
    if runner.exists():
        result = subprocess.run(
            [str(runner), str(ROOT / "packages/events-model/test/migrate-cli.ts"), str(path)],
            check=True,
            capture_output=True,
            text=True,
        )
        assert json.loads(result.stdout) == agenda


def test_runtime_v2_reimport_retains_notes_after_time_change(tmp_path, monkeypatch):
    import server

    source = json.loads((ROOT / "tests/e2e/seed-agenda.json").read_text())
    source["schema_version"] = "confnote.agenda.v2"
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    server.create_conference(source)
    slug = server.conference_slug(source)
    first = source["events"][0]
    note = tmp_path / slug / "notes" / f"session-{first['id']}.md"
    note.write_text("Human notes must survive")
    first["start"] = first["start"].replace("09:", "08:")
    server.create_conference(source)
    assert note.read_text() == "Human notes must survive"
    assert server.conference_payload(slug)["events"][0]["note"] == note.name
    assert server.note_path(slug, note.name) == note
