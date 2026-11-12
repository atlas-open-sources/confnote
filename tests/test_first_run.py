import json
import sys
from pathlib import Path

sys.path.insert(0, "packages/local-app")
import first_run  # noqa: E402
from agenda_manifest import validate_manifest  # noqa: E402


def test_seed_creates_once_without_overwriting(tmp_path):
    captured = []

    def create(agenda):
        captured.append(agenda)
        event = tmp_path / "2026-09-29-openai-devday-2026"
        event.mkdir()
        (event / "BRIEF.md").write_text("My existing goals")
        return "created"

    assert first_run.seed_first_run(tmp_path, create)
    assert not first_run.seed_first_run(tmp_path, create)
    assert len(captured) == 1
    assert next(tmp_path.glob("*/BRIEF.md")).read_text() == "My existing goals"


def test_hidden_state_does_not_block_seed(tmp_path):
    (tmp_path / ".confnote").mkdir()
    captured = []
    assert first_run.seed_first_run(tmp_path, captured.append)
    assert len(captured) == 1


def test_any_user_content_prevents_seed(tmp_path):
    (tmp_path / "personal.md").write_text("private")
    captured = []
    assert not first_run.seed_first_run(tmp_path, captured.append)
    assert not captured
    assert (tmp_path / "personal.md").read_text() == "private"


def test_public_seed_is_valid_and_contains_only_agenda_fields():
    agenda = json.loads(first_run.starter_agenda_path().read_text())
    result = validate_manifest(agenda)
    assert result["ok"], result["errors"]
    assert len(agenda["events"]) == 22
    assert agenda["conference"]["timezone"] == "America/Los_Angeles"
    assert set(agenda) == {"schema_version", "conference", "speakers", "events"}
    allowed = {
        "id",
        "title",
        "description",
        "start",
        "end",
        "room",
        "track",
        "speakers",
        "tags",
        "links",
        "type",
    }
    assert all(set(event) <= allowed for event in agenda["events"])


def test_frozen_seed_path(monkeypatch, tmp_path):
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)
    assert first_run.starter_agenda_path() == Path(tmp_path) / "tools" / "devday-2026.json"
