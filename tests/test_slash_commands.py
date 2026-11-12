"""Tests for the chat-level slash command machinery:
  /brief, /debrief  → tagged for chat.global_reply to inject a directive
  /action <text>    → handled directly by server.py (no LLM)

Also covers the INBOX.md fallback when no session is in view, and the
actions_payload aggregator picking it up as a synthetic 'Inbox' entry.
"""

from __future__ import annotations

import json
import sys

import pytest

sys.path.insert(0, "packages/local-app")
import chat  # noqa: E402
import server  # noqa: E402

# ---------------------------------------------------------- detector


def test_detector_matches_brief():
    out = server._slash_command_in([{"role": "user", "text": "/brief"}])
    assert out == {"name": "brief", "args": ""}


def test_detector_matches_brief_with_args():
    out = server._slash_command_in([{"role": "user", "text": "/brief 1400-keynote.md"}])
    assert out == {"name": "brief", "args": "1400-keynote.md"}


def test_detector_matches_debrief_case_insensitive():
    out = server._slash_command_in([{"role": "user", "text": "/Debrief"}])
    assert out == {"name": "debrief", "args": ""}


def test_detector_matches_action():
    out = server._slash_command_in([{"role": "user", "text": "/action follow up with Jane"}])
    assert out == {"name": "action", "args": "follow up with Jane"}


def test_detector_ignores_plain_text():
    assert server._slash_command_in([{"role": "user", "text": "draft the brief please"}]) is None


def test_detector_reads_a_brief_with_speaker_research_as_brief():
    # The web's prepare_event_brief writes every session's Research; the local /brief workflow does too.
    for text in (
        "Prepare a brief and research each speaker",
        "Can you research the speakers and draft the conference brief?",
    ):
        assert server._slash_command_in([{"role": "user", "text": text}]) == {
            "name": "brief",
            "args": "",
        }
    assert server._slash_command_in([{"role": "user", "text": "research the speakers"}]) is None
    assert (
        server._slash_command_in([{"role": "assistant", "text": "a brief and speaker research"}])
        is None
    )


def test_brief_workflow_writes_every_session_research_before_the_brief():
    directive = chat._slash_directive("brief", conf_slug="2026-05-19-btp")
    assert "save_research(file" in directive
    assert directive.index("save_research") < directive.index("write_conference_doc")


def test_detector_ignores_unknown_slash():
    assert server._slash_command_in([{"role": "user", "text": "/explain something"}]) is None


def test_detector_ignores_assistant_role():
    assert server._slash_command_in([{"role": "assistant", "text": "/brief"}]) is None


def test_detector_handles_empty_messages():
    assert server._slash_command_in([]) is None


# ----------------------------------------------------- /action storage


@pytest.fixture
def tmp_vault(monkeypatch, tmp_path):
    """Point the server at a temp vault with a seed conference + note."""
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    slug = "2026-05-19-beyond-the-prompt"
    cdir = tmp_path / slug
    (cdir / "notes").mkdir(parents=True)
    (cdir / "agenda.json").write_text(
        json.dumps(
            {
                "conference": {"name": "Test", "start": "2026-05-19"},
                "events": [
                    {
                        "id": "keynote",
                        "title": "Opening Keynote",
                        "start": "2026-05-19T14:00:00+01:00",
                        "end": "2026-05-19T15:00:00+01:00",
                    }
                ],
                "speakers": {},
            }
        )
    )
    note = cdir / "notes" / "1400-keynote.md"
    note.write_text(
        "---\nid: keynote\n---\n\n# Opening Keynote\n\n"
        "## Human notes\n\n\n## Summary\n\n\n## Research\n\n\n"
        "## AI notes\n\n\n## Transcript\n\n\n## Actions\n\n\n"
        "## Links\n\n\n## Scratchpad\n\n"
    )
    return tmp_path, slug


def test_action_appends_to_session_actions(tmp_vault):
    _, slug = tmp_vault
    p = server.append_session_action(slug, "1400-keynote.md", "follow up with Jane")
    assert p is not None
    _, _, secs = server.parse_note(p.read_text())
    assert "- [ ] follow up with Jane" in secs["Actions"]


def test_action_falls_back_to_inbox(tmp_vault):
    base, slug = tmp_vault
    p = server.append_inbox_action(slug, "ask the host for slides")
    assert p == base / slug / "INBOX.md"
    assert p.exists()
    body = p.read_text()
    assert "## Actions" in body
    assert "- [ ] ask the host for slides" in body


def test_inbox_appends_without_duplicating_header(tmp_vault):
    base, slug = tmp_vault
    server.append_inbox_action(slug, "first")
    server.append_inbox_action(slug, "second")
    text = (base / slug / "INBOX.md").read_text()
    # exactly one '## Actions' heading regardless of how many appends
    assert text.count("## Actions") == 1
    assert "- [ ] first" in text
    assert "- [ ] second" in text


def test_inbox_already_checked_format_preserved(tmp_vault):
    base, slug = tmp_vault
    server.append_inbox_action(slug, "- [x] something already done")
    text = (base / slug / "INBOX.md").read_text()
    assert "- [x] something already done" in text


def test_actions_payload_includes_inbox(tmp_vault):
    _, slug = tmp_vault
    server.append_inbox_action(slug, "unsorted thing")
    payload = server.actions_payload(slug)
    assert payload is not None
    notes = [s["note"] for s in payload["sessions"]]
    assert "INBOX.md" in notes
    inbox = next(s for s in payload["sessions"] if s["note"] == "INBOX.md")
    assert inbox["title"] == "Inbox"
    assert inbox.get("inbox") is True
    assert inbox["open"] >= 1


def test_actions_payload_inbox_top_when_present(tmp_vault):
    _, slug = tmp_vault
    server.append_inbox_action(slug, "x")
    # also add a session action
    server.append_session_action(slug, "1400-keynote.md", "y")
    payload = server.actions_payload(slug)
    assert payload["sessions"][0]["note"] == "INBOX.md"


# ------------------------------------------------ /brief|/debrief directive


def test_brief_directive_first_run_is_full_workflow():
    # no existing doc + a conference selected → full generate workflow
    d = chat._slash_directive("brief", conf_slug="x", args="", doc_text="")
    assert "OVERRIDE" in d
    assert "research_speakers" in d
    assert "write_conference_doc" in d and "BRIEF.md" in d


def test_debrief_directive_first_run_is_full_workflow():
    d = chat._slash_directive("debrief", conf_slug="x", args="", doc_text="")
    assert "OVERRIDE" in d
    assert "write_conference_doc" in d and "DEBRIEF.md" in d


def test_unknown_directive_is_empty():
    assert chat._slash_directive("action", conf_slug="x") == ""
    assert chat._slash_directive("nope", conf_slug="x") == ""


def test_directive_no_conference_asks_to_pick_one():
    d = chat._slash_directive("brief", conf_slug="", args="", doc_text="")
    assert "NO conference" in d
    assert "write_conference_doc" not in d  # must not run the workflow


def test_directive_populated_bare_does_not_regenerate():
    d = chat._slash_directive("brief", conf_slug="x", args="", doc_text="# Existing brief\n\nstuff")
    assert "already exists" in d
    assert "start afresh" in d
    # the guardrail tells the agent NOT to call the writer
    assert "not call write_conference_doc" in d.lower()


def test_directive_populated_with_args_refines_in_place():
    d = chat._slash_directive(
        "debrief", conf_slug="x", args="add a risks section", doc_text="# Debrief\n\nold body"
    )
    assert "refine" in d.lower()
    assert "old body" in d  # current doc is injected so the agent can edit it
    assert 'write_conference_doc(name="DEBRIEF.md")' in d


def test_directive_explicit_afresh_does_full_rebuild_even_if_populated():
    d = chat._slash_directive(
        "brief", conf_slug="x", args="start afresh", doc_text="# Existing\n\nbody"
    )
    assert "OVERRIDE" in d
    assert "research_speakers" in d  # the full workflow, not the refine path


# ------------------------------------- debrief action items → INBOX (B2)

_DEBRIEF = (
    "# Debrief\n\n## Top Takeaways\n\n1. something\n\n"
    "## Action Items\n\n"
    "- [ ] Try out **AG Grid** community version\n"
    "- [ ] Explore [fairydraw](https://fairies.tldraw.com) canvas\n"
    "- [ ] Evaluate Ably for streaming\n\n"
    "## Wins\n\n- shipped\n"
)


def test_sync_debrief_actions_files_into_inbox(tmp_vault):
    _, slug = tmp_vault
    server.write_conf_doc(slug, "DEBRIEF.md", _DEBRIEF)
    added = server.sync_debrief_actions_to_inbox(slug)
    assert added == 3
    payload = server.actions_payload(slug)
    inbox = next(s for s in payload["sessions"] if s["note"] == "INBOX.md")
    texts = " ".join(it["text"] for it in inbox["items"])
    assert "AG Grid" in texts and "fairydraw" in texts and "Ably" in texts
    # the narrative list stays in DEBRIEF.md (both)
    assert "## Action Items" in server.read_conf_doc(slug, "DEBRIEF.md")


def test_sync_debrief_actions_is_idempotent(tmp_vault):
    _, slug = tmp_vault
    server.write_conf_doc(slug, "DEBRIEF.md", _DEBRIEF)
    assert server.sync_debrief_actions_to_inbox(slug) == 3
    # re-running /debrief regenerates the same items — no duplicates
    assert server.sync_debrief_actions_to_inbox(slug) == 0
    inbox = server._inbox_read_actions(server.inbox_path(slug))
    assert inbox.count("AG Grid") == 1


def test_sync_debrief_actions_dedupes_against_existing_inbox(tmp_vault):
    _, slug = tmp_vault
    server.append_inbox_action(slug, "Evaluate Ably for streaming.")
    server.write_conf_doc(slug, "DEBRIEF.md", _DEBRIEF)
    # the Ably item already exists (modulo trailing period) → only 2 new
    assert server.sync_debrief_actions_to_inbox(slug) == 2


def test_sync_debrief_actions_handles_no_section(tmp_vault):
    _, slug = tmp_vault
    server.write_conf_doc(slug, "DEBRIEF.md", "# Debrief\n\n## Wins\n\n- nice\n")
    assert server.sync_debrief_actions_to_inbox(slug) == 0


def test_actions_payload_surfaces_debrief_items_on_read(tmp_vault):
    """Opening the Actions rollup must surface the debrief's `## Action Items`
    even for a DEBRIEF.md written before any sync ran — actions_payload mirrors
    them into the inbox on read, idempotently."""
    _, slug = tmp_vault
    server.write_conf_doc(
        slug,
        "DEBRIEF.md",
        "# Debrief\n\n## Action Items\n\n- [ ] alpha follow-up\n- [ ] beta follow-up\n",
    )
    payload = server.actions_payload(slug)
    inbox = next(s for s in payload["sessions"] if s["note"] == "INBOX.md")
    texts = " ".join(it["text"] for it in inbox["items"])
    assert "alpha follow-up" in texts and "beta follow-up" in texts
    # idempotent — aggregating again doesn't duplicate
    again = server.actions_payload(slug)
    inbox2 = next(s for s in again["sessions"] if s["note"] == "INBOX.md")
    assert len(inbox2["items"]) == 2


def test_native_notification_passes_agenda_text_as_arguments(monkeypatch):
    # A session title from an imported agenda must never become AppleScript
    # source: `\"` once closed the string and reached `do shell script`.
    import subprocess

    calls = []
    monkeypatch.delenv("CONF_NOTES_NO_NATIVE_NOTIFY", raising=False)
    monkeypatch.setattr(subprocess, "run", lambda args, **_: calls.append(args))
    title = 'Talk \\" & (do shell script "touch /tmp/pwned") & "'
    server._emit_native_notification(title, 'body \\"\nline')
    (args,) = calls
    assert args[-2:] == [title, 'body \\"\nline']
    script = " ".join(args[1:-2])
    assert "do shell script" not in script
    assert "item 1 of argv" in script
