"""Absolute schedule adjustments leave markdown, identity and assets intact.

Endpoint tests dispatch handlers in memory: no socket bind or real vault writes.
"""

import io
import json
import threading
from datetime import datetime
from email.message import Message

import pytest
import server

SLUG = "2026-10-03-berkeley"
NOTE = "0900-opening.md"


@pytest.fixture
def vault(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    directory = tmp_path / SLUG
    (directory / "notes").mkdir(parents=True)
    (directory / "assets").mkdir()
    agenda = {
        "conference": {"name": "Berkeley", "date": "2026-10-03", "timezone": "America/Los_Angeles"},
        "events": [
            {
                "id": "opening",
                "type": "talk",
                "title": "Opening",
                "start": "2026-10-03T09:00:00-07:00",
                "end": "2026-10-03T10:00:00-07:00",
            }
        ],
        "speakers": {},
    }
    (directory / "agenda.json").write_text(json.dumps(agenda))
    (directory / "notes" / NOTE).write_text(
        "---\ntime: 2026-10-03 09:00–10:00 (America/Los_Angeles)\n---\n\n# Opening\n\n## Human notes\n\nMy notes\n\n## AI notes\n\nAgent notes\n"
    )
    (directory / "assets" / "audio.wav").write_bytes(b"recorded audio")
    return directory, agenda


def dispatch(path, body=None, *, origin="http://127.0.0.1:8787", marker="1", get=False, put=False):
    handler = object.__new__(server.Handler)
    handler.path = path
    handler.headers = Message()
    handler.headers["Host"] = "127.0.0.1:8787"
    if origin is not None:
        handler.headers["Origin"] = origin
    if marker is not None:
        handler.headers["X-Confnote-Request"] = marker
    raw = json.dumps(body).encode() if body is not None else b""
    handler.headers["Content-Length"] = str(len(raw))
    handler.rfile = io.BytesIO(raw)
    result = []
    handler._send = lambda code, payload: result.append((code, payload))
    if put:
        handler.do_PUT()
    elif get:
        handler.do_GET()
    else:
        handler.do_POST()
    return result[0]


def test_repeated_offsets_preserve_notes_assets_and_raw_times(vault):
    directory, agenda = vault
    note = directory / "notes" / NOTE
    original = note.read_bytes()
    original_mtime = note.stat().st_mtime_ns
    for index, offset in enumerate((30, 0, 30, 0, 30), start=1):
        previous = 0 if offset == 30 else 30
        payload = server.set_conference_schedule(SLUG, offset, previous)
        assert payload["schedule_revision"] == index
        assert payload["schedule_offset_minutes"] == offset
        assert payload["events"][0]["note"] == NOTE
        assert payload["events"][0]["start"][11:16] == ("09:30" if offset else "09:00")
        assert note.read_bytes() == original
        assert note.stat().st_mtime_ns == original_mtime
        assert (directory / "assets/audio.wav").read_bytes() == b"recorded audio"
        assert server.load_agenda(SLUG)["events"] == agenda["events"]
    assert list((directory / "notes").iterdir()) == [note]


def test_note_edit_survives_reset_and_subsequent_offset(vault):
    directory, _ = vault
    server.set_conference_schedule(SLUG, 30, 0)
    note = directory / "notes" / NOTE
    note.write_text(note.read_text().replace("My notes", "My newly edited notes"))
    edited = note.read_bytes()
    server.set_conference_schedule(SLUG, 0, 30)
    server.set_conference_schedule(SLUG, 30, 0)
    assert note.read_bytes() == edited


def test_editor_save_after_shift_preserves_raw_frontmatter_and_agent_sections(vault):
    directory, _ = vault
    server.set_conference_schedule(SLUG, 30, 0)
    code, _ = dispatch(
        f"/api/note?slug={SLUG}&file={NOTE}",
        {"sections": {"Human notes": "Typed while shifted", "AI notes": "Do not overwrite"}},
        put=True,
    )
    assert code == 200
    fm, _, sections = server.parse_note((directory / "notes" / NOTE).read_text())
    assert fm["time"] == "2026-10-03 09:00–10:00 (America/Los_Angeles)"
    assert sections["Human notes"].strip() == "Typed while shifted"
    assert sections["AI notes"].strip() == "Agent notes"
    edited = (directory / "notes" / NOTE).read_bytes()
    server.set_conference_schedule(SLUG, 0, 30)
    server.set_conference_schedule(SLUG, 30, 0)
    assert (directory / "notes" / NOTE).read_bytes() == edited


@pytest.mark.parametrize("value", [True, False, 30.0, "30", None, -1441, 1441])
def test_invalid_offset_cannot_mutate_agenda(vault, value):
    directory, _ = vault
    before = (directory / "agenda.json").read_bytes()
    with pytest.raises(ValueError):
        server.set_conference_schedule(SLUG, value, 0)
    assert (directory / "agenda.json").read_bytes() == before


def test_stale_offset_and_revision_rejected(vault):
    server.set_conference_schedule(SLUG, 30, 0, 0)
    with pytest.raises(server.ScheduleConflict):
        server.set_conference_schedule(SLUG, 60, 0)
    server.set_conference_schedule(SLUG, 0, 30, 1)
    with pytest.raises(server.ScheduleConflict):
        server.set_conference_schedule(SLUG, 60, 0, 0)


def test_same_absolute_offset_is_idempotent(vault):
    directory, _ = vault
    server.set_conference_schedule(SLUG, 30, 0)
    before = (directory / "agenda.json").stat().st_mtime_ns
    payload = server.set_conference_schedule(SLUG, 30, 30)
    assert payload["schedule_revision"] == 1
    assert (directory / "agenda.json").stat().st_mtime_ns == before


def test_status_and_agent_context_use_effective_times(vault):
    server.set_conference_schedule(SLUG, 30, 0)
    data = server.load_agenda(SLUG)
    assert server.conf_status(data, datetime.fromisoformat("2026-10-03T10:15:00-07:00")).startswith(
        "LIVE:"
    )
    assert "until 10:30" in server.conf_status(
        data, datetime.fromisoformat("2026-10-03T10:15:00-07:00")
    )
    context = server.agenda_meta_text(data)
    assert "2026-10-03T09:30:00-07:00" in context
    assert "SCHEDULE_OFFSET_MINUTES: 30" in context
    assert "SCHEDULE_REVISION: 1" in context
    assert "09:30 Opening [0900-opening.md]" in server.session_index(SLUG)


def test_midnight_projection_preserves_note_reference(vault):
    payload = server.set_conference_schedule(SLUG, -600, 0)
    assert payload["events"][0]["start"] == "2026-10-02T23:00:00-07:00"
    assert payload["events"][0]["note"] == NOTE


def test_endpoint_roundtrip_and_note_display_only(vault):
    directory, _ = vault
    original = (directory / "notes" / NOTE).read_bytes()
    code, payload = dispatch(
        "/api/conference/schedule",
        {"slug": SLUG, "offset_minutes": 30, "expected_offset": 0, "expected_revision": 0},
    )
    assert code == 200
    assert payload["events"][0]["note"] == NOTE
    code, note = dispatch(f"/api/note?slug={SLUG}&file={NOTE}", get=True)
    assert code == 200
    assert note["frontmatter"]["time"] == "2026-10-03 09:30–10:30 (America/Los_Angeles)"
    assert (directory / "notes" / NOTE).read_bytes() == original
    code, readback = dispatch(f"/api/conference?slug={SLUG}", get=True)
    assert code == 200 and readback == payload


@pytest.mark.parametrize(
    "origin,marker", [(None, "1"), ("https://evil.test", "1"), ("http://127.0.0.1:8787", None)]
)
def test_endpoint_rejects_cross_origin(vault, origin, marker):
    code, _ = dispatch(
        "/api/conference/schedule",
        {"slug": SLUG, "offset_minutes": 30, "expected_offset": 0},
        origin=origin,
        marker=marker,
    )
    assert code == 403
    assert server.load_agenda(SLUG).get("schedule_offset_minutes", 0) == 0


def test_endpoint_errors(vault):
    assert (
        dispatch(
            "/api/conference/schedule", {"slug": SLUG, "offset_minutes": True, "expected_offset": 0}
        )[0]
        == 400
    )
    assert (
        dispatch(
            "/api/conference/schedule", {"slug": SLUG, "offset_minutes": 30, "expected_offset": 10}
        )[0]
        == 409
    )
    assert (
        dispatch(
            "/api/conference/schedule",
            {"slug": "2026-10-03-missing", "offset_minutes": 30, "expected_offset": 0},
        )[0]
        == 404
    )


def test_concurrent_adjustments_have_one_winner(vault):
    outcomes = []
    barrier = threading.Barrier(2)

    def change(offset):
        barrier.wait()
        try:
            server.set_conference_schedule(SLUG, offset, 0)
            outcomes.append("success")
        except server.ScheduleConflict:
            outcomes.append("conflict")

    threads = [threading.Thread(target=change, args=(offset,)) for offset in (30, 60)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5)
    assert sorted(outcomes) == ["conflict", "success"]


def test_note_stale_save_returns_conflict_without_losing_newer_content(vault):
    code, note = dispatch(f"/api/note?slug={SLUG}&file={NOTE}", get=True)
    assert code == 200
    code, saved = dispatch(
        f"/api/note?slug={SLUG}&file={NOTE}",
        {"mtime": note["mtime"], "sections": {"Human notes": "newer edit"}},
        put=True,
    )
    assert code == 200
    code, stale = dispatch(
        f"/api/note?slug={SLUG}&file={NOTE}",
        {"mtime": note["mtime"], "sections": {"Human notes": "stale edit"}},
        put=True,
    )
    assert code == 409
    assert stale["conflict"] is True
    assert stale["note"]["sections"]["Human notes"] == "newer edit"


def test_note_concurrent_saves_have_one_winner(vault):
    _, note = dispatch(f"/api/note?slug={SLUG}&file={NOTE}", get=True)
    barrier = threading.Barrier(2)
    outcomes = []

    def save(text):
        barrier.wait()
        outcomes.append(
            dispatch(
                f"/api/note?slug={SLUG}&file={NOTE}",
                {"mtime": note["mtime"], "sections": {"Human notes": text}},
                put=True,
            )[0]
        )

    threads = [threading.Thread(target=save, args=(text,)) for text in ("first", "second")]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5)
    assert sorted(outcomes) == [200, 409]
