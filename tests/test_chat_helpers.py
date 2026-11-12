"""Tests for the chat-support helpers added to server.py.

Covers section-preserving Brief/Debrief writes, conference STATUS
computation (pre / live / between / post), conference-level BRIEF/DEBRIEF
docs, and create_conference. No running server is touched; BASE_DIR is
monkeypatched to a tmp dir.

Run:  python3 -m pytest -q tests/
"""

import json
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, "app")
import server  # noqa: E402

TZ = "+01:00"


def _agenda(slug_name="Test Conf", date="2026-05-19"):
    return {
        "schema_version": "1.0",
        "conference": {
            "name": slug_name,
            "tagline": "A test day",
            "date": date,
            "timezone": "Europe/London",
            "venue": {"name": "Somewhere", "address": "1 Test St"},
            "organiser": "Tester",
        },
        "speakers": {"ada": {"name": "Ada Lovelace", "role": "Speaker", "bio": "Pioneer."}},
        "events": [
            {
                "id": "registration",
                "type": "logistics",
                "title": "Registration",
                "start": f"{date}T08:30:00{TZ}",
                "end": f"{date}T09:00:00{TZ}",
            },
            {
                "id": "keynote",
                "type": "keynote",
                "title": "Opening Keynote",
                "start": f"{date}T09:30:00{TZ}",
                "end": f"{date}T10:10:00{TZ}",
                "speakers": ["ada"],
                "description": "Why we are here.",
            },
            {
                "id": "closing",
                "type": "talk",
                "title": "Closing",
                "start": f"{date}T16:00:00{TZ}",
                "end": f"{date}T17:00:00{TZ}",
            },
        ],
    }


def _seed(base: Path, data=None):
    data = data or _agenda()
    slug = f"{data['conference']['date']}-test-conf"
    conf_dir = base / slug
    notes = conf_dir / "notes"
    notes.mkdir(parents=True)
    (conf_dir / "agenda.json").write_text(json.dumps(data))
    for e in data["events"]:
        if not server.notable(e):
            continue
        fn = f"{e['start'][11:13]}{e['start'][14:16]}-{e['id']}.md"
        # Per-session Brief/Debrief were removed in the v0.1 cleanup —
        # Brief/Debrief are conference-level only (BRIEF.md / DEBRIEF.md).
        note = server.build_note(
            {"session": e["title"]},
            e["title"],
            {
                "Human notes": "MY LIVE NOTES — keep me",
                "Summary": "seed summary",
                "Research": "seed research",
                "AI notes": "agent stuff",
                "Actions": "- [ ] seed action",
            },
        )
        (notes / fn).write_text(note)
    return slug


# ---------- section-preserving section writes ----------


def test_apply_note_section_preserves_other_sections(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    slug = _seed(tmp_path)
    p = tmp_path / slug / "notes" / "0930-keynote.md"

    server.apply_note_section(p, "Research", "new dossier")
    _, _, secs = server.parse_note(p.read_text())
    assert secs["Research"] == "new dossier"
    # everything else, especially the user's live notes, untouched
    assert secs["Human notes"] == "MY LIVE NOTES — keep me"
    assert secs["Summary"] == "seed summary"
    assert secs["AI notes"] == "agent stuff"
    assert secs["Actions"] == "- [ ] seed action"

    server.apply_note_section(p, "Actions", "- [x] seed action\n- [ ] new one")
    _, _, secs2 = server.parse_note(p.read_text())
    assert secs2["Actions"] == "- [x] seed action\n- [ ] new one"
    assert secs2["Research"] == "new dossier"  # prior write survives
    assert secs2["Human notes"] == "MY LIVE NOTES — keep me"


def test_apply_note_section_strips_and_roundtrips(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    slug = _seed(tmp_path)
    p = tmp_path / slug / "notes" / "0930-keynote.md"
    msg = server.apply_note_section(p, "Research", "\n\n  dossier text  \n\n")
    assert "Research section updated" in msg
    _, _, secs = server.parse_note(p.read_text())
    assert secs["Research"] == "dossier text"


# ---------- STATUS computation ----------


def _at(iso):
    return datetime.fromisoformat(iso)


def test_status_pre_conference():
    data = _agenda()
    s = server.conf_status(data, now=_at("2026-05-19T07:00:00+01:00"))
    assert s.startswith("Pre-conference")
    assert "starts in" in s
    assert "08:30" in s


def test_status_live_session():
    data = _agenda()
    s = server.conf_status(data, now=_at("2026-05-19T09:45:00+01:00"))
    assert s.startswith("LIVE:")
    assert "Opening Keynote" in s
    assert "until 10:10" in s
    assert "Next:" in s and "Closing" in s


def test_status_between_sessions():
    data = _agenda()
    s = server.conf_status(data, now=_at("2026-05-19T11:00:00+01:00"))
    assert s.startswith("Between sessions")
    assert "Closing" in s


def test_status_post_conference():
    data = _agenda()
    s = server.conf_status(data, now=_at("2026-05-19T20:00:00+01:00"))
    assert s.startswith("Post-conference")
    assert "ended" in s


def test_status_counts_long_spans_in_days():
    data = _agenda()
    assert "ended 1 day ago" in server.conf_status(data, now=_at("2026-05-21T09:00:00+01:00"))
    assert "ended 174 days ago" in server.conf_status(data, now=_at("2026-11-10T12:00:00+00:00"))
    assert "starts in 3 days" in server.conf_status(data, now=_at("2026-05-16T07:00:00+01:00"))


def test_status_handles_timezone_offsets():
    # The agenda is in +01:00. 08:45 UTC == 09:45 BST, which is inside the
    # 09:30–10:10 BST keynote: status must resolve against the offset, not
    # treat the wall-clock 08:45 as pre-conference.
    data = _agenda()
    s = server.conf_status(data, now=_at("2026-05-19T08:45:00+00:00"))
    assert s.startswith("LIVE:")
    assert "Opening Keynote" in s
    # And a UTC time well before the day is still pre-conference.
    early = server.conf_status(data, now=_at("2026-05-19T05:00:00+00:00"))
    assert early.startswith("Pre-conference")


def test_status_no_events():
    assert server.conf_status({"events": []}) == "No scheduled events."


# ---------- conference-level BRIEF / DEBRIEF docs ----------


def test_conf_doc_write_and_read(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    slug = _seed(tmp_path)
    assert server.read_conf_doc(slug, "BRIEF.md") == ""  # not yet created
    server.write_conf_doc(slug, "BRIEF.md", "# Game plan\n\nArrive early.")
    assert (tmp_path / slug / "BRIEF.md").exists()
    assert "Game plan" in server.read_conf_doc(slug, "BRIEF.md")
    server.write_conf_doc(slug, "DEBRIEF.md", "Recap")
    assert server.read_conf_doc(slug, "DEBRIEF.md").strip() == "Recap"


def test_conf_doc_rejects_bad_names(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    slug = _seed(tmp_path)
    assert server.conf_doc_path(slug, "evil.md") is None
    assert server.conf_doc_path("../etc", "BRIEF.md") is None
    assert server.read_conf_doc("2026-01-01-nope", "BRIEF.md") is None


# ---------- digest ----------


def test_session_digest_includes_titles_and_excerpts(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    slug = _seed(tmp_path)
    dg = server.session_digest(slug)
    assert "Opening Keynote" in dg
    assert "0930-keynote.md" in dg
    assert "MY LIVE NOTES" in dg
    assert "seed summary" in dg
    # Actions roll into the digest so /debrief can gather action items (#4).
    assert "seed action" in dg


def test_resolve_read_target(tmp_path, monkeypatch):
    """Cross-conf read resolution: empty → current, valid → that slug, invalid
    non-empty → (None, error) instead of silently using the current conf (#3)."""
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    slug = _seed(tmp_path)
    # empty target → current conference, no error
    assert server.resolve_read_target(slug, "") == (slug, None)
    # valid explicit slug → that slug
    assert server.resolve_read_target(slug, slug) == (slug, None)
    # invalid non-empty slug → not-found error, NOT a fallback to current
    s, err = server.resolve_read_target(slug, "2099-01-01-nope")
    assert s is None and err and "No such conference" in err


def test_session_index_is_titles_and_files_without_note_content(tmp_path, monkeypatch):
    """The per-turn index lists each notable session's title + note file but
    must NOT inline note content — that's pulled on demand via read_notes /
    read_note. This is the lightweight envelope payload."""
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    slug = _seed(tmp_path)
    idx = server.session_index(slug)
    assert "Opening Keynote" in idx
    assert "0930-keynote.md" in idx
    # excerpts of the user's notes / summary must NOT leak into the index
    assert "MY LIVE NOTES" not in idx
    assert "seed summary" not in idx


# ---------- create_conference ----------


def test_create_conference_creates_valid_folder(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    data = _agenda(slug_name="Brand New Conf", date="2026-09-01")
    msg = server.create_conference(data)
    assert "Brand New Conf" in msg

    slug = "2026-09-01-brand-new-conf"
    conf_dir = tmp_path / slug
    assert (conf_dir / "agenda.json").is_file()
    assert (conf_dir / "README.md").is_file()
    assert (conf_dir / "speakers.md").is_file()
    notes = conf_dir / "notes"
    assert notes.is_dir()
    # notable events (have id + start) each get a note
    assert (notes / "0930-keynote.md").is_file()
    assert (notes / "0830-registration.md").is_file()

    # the imported agenda loads + STATUS computes against it
    loaded = server.load_agenda(slug)
    assert loaded["conference"]["name"] == "Brand New Conf"
    assert isinstance(server.conf_status(loaded), str)


def test_create_conference_rejects_bad_agendas(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    import pytest

    with pytest.raises(ValueError):
        server.create_conference({"conference": {"name": "X"}})  # no date
    with pytest.raises(ValueError):
        server.create_conference({"conference": {"name": "X", "date": "May 2026"}, "events": [{}]})
    with pytest.raises(ValueError):
        server.create_conference({"conference": {"name": "X", "date": "2026-01-01"}, "events": []})
    with pytest.raises(ValueError):
        server.create_conference("not a dict")


# ---------- vault selection (app-global, switchable) ----------


def test_vault_resolution_order(tmp_path, monkeypatch):
    """CONF_NOTES_DIR env wins; else the persisted current_vault; else default."""
    state_file = tmp_path / "state.json"
    monkeypatch.setattr(server, "app_state_path", lambda: state_file)

    # 1. env override wins over everything
    env_dir = tmp_path / "env-vault"
    monkeypatch.setenv("CONF_NOTES_DIR", str(env_dir))
    assert server.resolve_base_dir() == env_dir.resolve()

    # 2. no env → persisted current_vault
    monkeypatch.delenv("CONF_NOTES_DIR", raising=False)
    picked = tmp_path / "picked-vault"
    server.write_app_state({"current_vault": str(picked)})
    assert server.resolve_base_dir() == picked.resolve()

    # 3. no env + no persisted choice → default
    server.write_app_state({})
    assert server.resolve_base_dir() == server.DEFAULT_VAULT.expanduser().resolve()


def test_set_current_vault_dedupes_and_caps_recents(tmp_path, monkeypatch):
    state_file = tmp_path / "state.json"
    monkeypatch.setattr(server, "app_state_path", lambda: state_file)

    for i in range(10):
        server.set_current_vault(f"/vaults/v{i}")
    # most-recent first, capped at 8, current is the last set
    recents = server.vault_recents()
    assert recents[0] == "/vaults/v9"
    assert len(recents) == 8
    assert server.read_app_state()["current_vault"] == "/vaults/v9"

    # re-selecting an existing one moves it to front without duplicating
    server.set_current_vault("/vaults/v5")
    recents = server.vault_recents()
    assert recents[0] == "/vaults/v5"
    assert recents.count("/vaults/v5") == 1


# ---------- agent scratch / source artifacts ----------


def test_agent_artifact_path_global_and_tagged(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    slug = _seed(tmp_path)

    g = server.agent_artifact_path("agenda-source.json")
    assert g is not None
    assert g.name == "agenda-source.json"
    assert g.parent.name == "agent" and ".confnote" in g.parts

    c = server.agent_artifact_path("agenda-source.json", slug)
    assert c is not None
    assert c.parent.name == "sources" and slug in c.parts


def test_agent_artifact_path_rejects_traversal_and_unknown_conf(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    assert server.agent_artifact_path("../escape") is None
    assert server.agent_artifact_path("a/b.json") is None
    assert server.agent_artifact_path("") is None
    assert server.agent_artifact_path(".hidden") is None
    assert server.agent_artifact_path("ok.json", "2099-01-01-nope") is None


def test_artifact_move_global_to_conference(tmp_path, monkeypatch):
    """A workspace file promotes into a conference's sources/ dir (move)."""
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    slug = _seed(tmp_path)
    src = server.agent_artifact_path("agenda-source.json")
    src.parent.mkdir(parents=True, exist_ok=True)
    src.write_text('{"x":1}')
    dst = server.agent_artifact_path("agenda-source.json", slug)
    dst.parent.mkdir(parents=True, exist_ok=True)
    src.replace(dst)
    assert not src.exists()
    assert dst.exists() and dst.read_text() == '{"x":1}'
    assert dst.parent.name == "sources" and slug in dst.parts


def test_create_conference_preserves_existing_notes(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    data = _agenda(slug_name="Reimport Conf", date="2026-10-10")
    server.create_conference(data)
    slug = "2026-10-10-reimport-conf"
    note = tmp_path / slug / "notes" / "0930-keynote.md"
    note.write_text(note.read_text() + "\n\nMY EDITS\n")
    # re-import must not clobber the existing note
    server.create_conference(data)
    assert "MY EDITS" in note.read_text()
