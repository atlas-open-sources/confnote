"""Tests for confnote section parsing, action items, and aggregation.

Run:  python3 -m pytest -q tests/
No running server is touched; BASE_DIR is monkeypatched to a tmp dir.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, "app")
import server  # noqa: E402

# ---------- build / parse round-trip ----------


def test_roundtrip_preserves_all_sections():
    # Per-session Brief/Debrief were removed in the v0.1 cleanup. Brief and
    # Debrief now live at the CONFERENCE level (BRIEF.md / DEBRIEF.md).
    fm = {"session": "Demo", "type": "talk"}
    title = "A Talk"
    sections = {
        "Human notes": "live notes",
        "Summary": "ai summary",
        "Research": "dossier",
        "AI notes": "agent stuff",
        "Transcript": "",
        "Actions": "- [ ] follow up with speaker\n- [x] read the paper",
        "Links": "https://example.com",
        "Scratchpad": "tmp",
    }
    text = server.build_note(fm, title, sections)
    fm2, title2, secs2 = server.parse_note(text)

    assert fm2 == fm
    assert title2 == title
    for name in server.CANON_SECTIONS:
        assert secs2.get(name, "") == sections.get(name, ""), name


def test_canon_section_order_and_editable_set():
    # Brief/Debrief intentionally absent — they're conference-level only.
    assert "Brief" not in server.CANON_SECTIONS
    assert "Debrief" not in server.CANON_SECTIONS
    assert server.CANON_SECTIONS[0] == "Human notes"
    assert {"Human notes", "Transcript", "Actions", "Links", "Scratchpad"} <= server.EDITABLE


def test_literal_heading_inside_human_notes_stays_content():
    # "## Something" that is NOT a canonical heading must remain body text,
    # not split the note into a bogus section.
    body = "first line\n## My ad-hoc heading\nsecond line"
    fm = {"a": "b"}
    text = server.build_note(fm, "T", {"Human notes": body, "Actions": "- [ ] x"})
    _, _, secs = server.parse_note(text)
    assert secs["Human notes"] == body
    assert "## My ad-hoc heading" in secs["Human notes"]
    assert "My ad-hoc heading" not in secs  # never became its own section


def test_has_content_counts_any_content_section(tmp_path):
    # A session whose substance lives in AI-driven / non-human sections still
    # counts as "has notes" (regression: the tick used to require Human notes).
    human = tmp_path / "human.md"
    human.write_text(server.build_note({}, "Human", {"Human notes": "my note"}))
    assert server.has_content(human)

    for section in ("Summary", "Research", "AI notes", "Transcript", "Scratchpad"):
        p = tmp_path / f"{section.replace(' ', '-').lower()}.md"
        p.write_text(server.build_note({}, section, {section: "real content"}))
        assert server.has_content(p), section

    # A real Actions item counts...
    acted = tmp_path / "acted.md"
    acted.write_text(server.build_note({}, "Acted", {"Actions": "- [ ] follow up"}))
    assert server.has_content(acted)


def test_has_content_excludes_links_only(tmp_path):
    # Links is seeded from the agenda (and user URLs are mirrored from Human
    # notes), so a note whose ONLY populated section is Links does not count.
    p = tmp_path / "links-only.md"
    p.write_text(server.build_note({}, "Links", {"Links": "- https://example.com"}))
    assert not server.has_content(p)


def test_has_content_ignores_empty_and_placeholder(tmp_path):
    # A wholly empty note has no content.
    empty = tmp_path / "empty.md"
    empty.write_text(server.build_note({}, "Empty", {}))
    assert not server.has_content(empty)

    # A freshly-imported note with only a blank placeholder checkbox is NOT
    # populated — otherwise every imported session lights the tick.
    placeholder = tmp_path / "placeholder.md"
    placeholder.write_text(
        server.build_note(
            {},
            "Placeholder",
            {"Actions": "Tasks and follow-ups — `- [ ] task` lines.\n- [ ] "},
        )
    )
    assert not server.has_content(placeholder)


def test_has_content_ignores_freshly_imported_seed(tmp_path):
    # The importer seeds Summary/Research/AI notes with hint text and Summary's
    # `> description` blockquote. A note still holding only those seeds (plus
    # agenda-seeded Links) must NOT light the tick.
    fresh = tmp_path / "fresh.md"
    fresh.write_text(
        server.build_note(
            {},
            "Fresh Import",
            {
                "Summary": "AI-driven — seeded from the agenda, an agent refines this.\n\n"
                "> A talk about widgets.",
                "Research": "Speaker & company dossier — run tools/research.py before the conference.",
                "AI notes": "Agent-owned. Live notes and follow-up research land here.",
                "Actions": "Tasks and follow-ups — `- [ ] task` lines, tick them off as you go.",
                "Links": "- https://agenda-seeded.example.com",
            },
        )
    )
    assert not server.has_content(fresh)

    # Once an agent writes a real Summary (seed text replaced), it counts.
    summarized = tmp_path / "summarized.md"
    summarized.write_text(
        server.build_note({}, "Summarized", {"Summary": "The speaker argued that X causes Y."})
    )
    assert server.has_content(summarized)


# ---------- private commentary (encrypted, agent-invisible) ----------


def test_private_section_is_canonical_and_editable():
    assert "Private" in server.CANON_SECTIONS
    assert "Private" in server.EDITABLE
    assert server.CANON_SECTIONS[-1] == "Private"  # last, after Scratchpad


def test_private_section_roundtrips():
    blob = "confnote-enc:v1:eyJpdiI6ImFiYyIsImN0IjoiZGVmIn0="
    text = server.build_note({}, "T", {"Human notes": "hi", "Private": blob})
    _, _, secs = server.parse_note(text)
    assert secs["Private"] == blob


def test_strip_private_blanks_the_blob():
    blob = "confnote-enc:v1:SECRETCIPHERTEXT"
    text = server.build_note({}, "T", {"Human notes": "public", "Private": blob})
    stripped = server.strip_private(text)
    assert blob not in stripped
    assert "SECRETCIPHERTEXT" not in stripped
    assert "public" in stripped  # non-private content survives
    _, _, secs = server.parse_note(stripped)
    assert secs.get("Private", "") == ""


def test_strip_private_noop_without_private():
    text = server.build_note({}, "T", {"Human notes": "just public"})
    assert server.strip_private(text) == text


def test_private_section_counts_as_content(tmp_path):
    p = tmp_path / "priv.md"
    p.write_text(server.build_note({}, "P", {"Private": "confnote-enc:v1:abc"}))
    assert server.has_content(p)


def test_private_config_read_write(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    assert server.read_private_config() is None
    cfg = {
        "v": 1,
        "salt": "c2FsdA==",
        "iterations": 200000,
        "kdf": "PBKDF2-SHA256",
        "verifier_iv": "aXY=",
        "verifier_ct": "Y3Q=",
    }
    server.write_private_config(cfg)
    assert server.read_private_config() == cfg
    # Stored under <vault>/.confnote/ — out of the conferences listing.
    assert server.private_config_path().parent.name == ".confnote"


# ---------- action item regex ----------


def test_parse_actions_counts_open_and_done():
    debrief = "\n".join(
        [
            "Some prose first.",
            "- [ ] open dash item",
            "* [ ] open star item",
            "- [x] done lowercase",
            "* [X] done uppercase",
            "  - [ ] indented open item",
            "- not an action line",
            "regular text [ ] not a bullet",
        ]
    )
    items = server.parse_actions(debrief)
    assert len(items) == 5
    open_n = sum(1 for it in items if not it["done"])
    done_n = sum(1 for it in items if it["done"])
    assert open_n == 3
    assert done_n == 2
    assert items[0] == {"text": "open dash item", "done": False}
    assert items[3] == {"text": "done uppercase", "done": True}


def test_parse_actions_empty():
    assert server.parse_actions("") == []
    assert server.parse_actions("just prose, no checkboxes") == []


def test_parse_actions_skips_blank_checkbox():
    # A bare placeholder checkbox (the importer used to seed one) is NOT an
    # action — otherwise every fresh session shows a phantom "1 open".
    assert server.parse_actions("- [ ] ") == []
    assert server.parse_actions("- [ ]") == []
    assert server.parse_actions("* [ ]    \n- [x]\t") == []
    mixed = "- [ ] \n- [ ] real one\n- [x]   "
    items = server.parse_actions(mixed)
    assert items == [{"text": "real one", "done": False}]


# ---------- actions aggregation helper ----------


def _seed_conf(base: Path):
    slug = "2026-05-19-test-conf"
    conf_dir = base / slug
    notes = conf_dir / "notes"
    notes.mkdir(parents=True)
    agenda = {
        "conference": {"name": "Test Conf", "date": "2026-05-19"},
        "events": [
            {
                "id": "talk-one",
                "start": "2026-05-19T09:30:00+01:00",
                "end": "2026-05-19T10:00:00+01:00",
                "title": "Talk One",
            },
            {
                "id": "talk-two",
                "start": "2026-05-19T10:10:00+01:00",
                "end": "2026-05-19T10:40:00+01:00",
                "title": "Talk Two",
            },
            {
                "id": "no-actions",
                "start": "2026-05-19T11:00:00+01:00",
                "end": "2026-05-19T11:30:00+01:00",
                "title": "No Actions",
            },
            {
                "id": "fresh",
                "start": "2026-05-19T12:00:00+01:00",
                "end": "2026-05-19T12:30:00+01:00",
                "title": "Fresh Import",
            },
        ],
    }
    (conf_dir / "agenda.json").write_text(json.dumps(agenda))

    # `/api/actions` reads from the `## Actions` section now (Debrief is a
    # narrative post-mortem). Seed the right section.
    n1 = server.build_note(
        {"session": "Talk One"},
        "Talk One",
        {
            "Actions": "Great talk.\n- [ ] email speaker\n- [x] star repo\n* [ ] try demo",
        },
    )
    (notes / "0930-talk-one.md").write_text(n1)

    n2 = server.build_note(
        {"session": "Talk Two"},
        "Talk Two",
        {
            "Actions": "- [x] all done here",
        },
    )
    (notes / "1010-talk-two.md").write_text(n2)

    n3 = server.build_note(
        {"session": "No Actions"},
        "No Actions",
        {
            "Actions": "No follow-ups, just prose.",
        },
    )
    (notes / "1100-no-actions.md").write_text(n3)

    # A freshly-imported note: hint text + only a blank placeholder checkbox.
    # Must NOT appear in actions_payload nor inflate the counts.
    n4 = server.build_note(
        {"session": "Fresh Import"},
        "Fresh Import",
        {
            "Actions": "Tasks and follow-ups — `- [ ] task` lines.\n- [ ] ",
        },
    )
    (notes / "1200-fresh.md").write_text(n4)
    return slug


def test_actions_payload_aggregates(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    slug = _seed_conf(tmp_path)

    payload = server.actions_payload(slug)
    assert payload is not None
    # talk-one: 2 open + 1 done = 3; talk-two: 0 open + 1 done = 1
    assert payload["open"] == 2
    assert payload["total"] == 4
    # "no-actions" (prose only) and "fresh" (blank placeholder checkbox only)
    # are both excluded — a phantom "- [ ] " must not inflate anything.
    assert len(payload["sessions"]) == 2
    assert {s["note"] for s in payload["sessions"]} == {"0930-talk-one.md", "1010-talk-two.md"}

    s0 = payload["sessions"][0]
    assert s0["note"] == "0930-talk-one.md"
    assert s0["title"] == "Talk One"
    assert s0["time"] == "09:30"
    assert s0["open"] == 2
    assert s0["total"] == 3
    assert len(s0["items"]) == 3

    s1 = payload["sessions"][1]
    assert s1["note"] == "1010-talk-two.md"
    assert s1["open"] == 0
    assert s1["total"] == 1


def test_actions_payload_unknown_conf(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    assert server.actions_payload("2026-01-01-does-not-exist") is None


# ---------- lenient note_file resolution (Bug #2: research orphan) ----------


def test_resolve_note_file_variants(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    slug = _seed_conf(tmp_path)
    canon = "0930-talk-one.md"

    # Exact canonical filename.
    assert server.resolve_note_file(slug, canon) == canon
    # Missing the .md extension.
    assert server.resolve_note_file(slug, "0930-talk-one") == canon
    # Over-qualified <slug>/<file> path.
    assert server.resolve_note_file(slug, f"{slug}/{canon}") == canon
    # Bare session id (no HHMM- prefix).
    assert server.resolve_note_file(slug, "talk-one") == canon
    assert server.resolve_note_file(slug, "talk-one.md") == canon
    # Bare HHMM time.
    assert server.resolve_note_file(slug, "0930") == canon
    # Case-insensitive.
    assert server.resolve_note_file(slug, "TALK-ONE") == canon


def test_resolve_note_file_misses(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    slug = _seed_conf(tmp_path)
    assert server.resolve_note_file(slug, "does-not-exist") is None
    assert server.resolve_note_file(slug, "") is None
    assert server.resolve_note_file("bad slug", "0930-talk-one.md") is None
    # A non-existent conference dir resolves nothing.
    assert server.resolve_note_file("2026-01-01-nope", "0930-talk-one.md") is None


# ---------- link extraction / mirroring (Bug #3: links stranded in notes) ----------


def test_extract_links_schemes_and_bare_domains():
    text = (
        "Loved the talk. Check out stately.ai and fairies.tldraw.com, plus "
        "https://ably.com/docs for the realtime bit. See [the deck](https://ex.com/deck.pdf)."
    )
    links = server.extract_links(text)
    assert "stately.ai" in links
    assert "fairies.tldraw.com" in links
    assert "https://ably.com/docs" in links
    assert "https://ex.com/deck.pdf" in links


def test_extract_links_ignores_non_links():
    # Filenames, version strings, and emails must NOT be picked up as links.
    text = "Edited app.js and Node.js, bumped to v0.2, ping someone@example.com about it."
    links = server.extract_links(text)
    assert links == [] or all("@" not in link for link in links)
    assert "app.js" not in links
    assert "node.js" not in [link.lower() for link in links]
    assert "example.com" not in links  # part of an email address


def test_extract_links_dedupes_case_insensitively():
    text = "https://Example.com and https://example.com again"
    assert len(server.extract_links(text)) == 1


def test_merge_links_into_section_appends_only_new():
    human = "see foo.com and https://bar.io"
    existing = "- https://bar.io"
    merged = server.merge_links_into_section(human, existing)
    assert "https://bar.io" in merged
    assert merged.count("https://bar.io") == 1  # not duplicated
    assert "- foo.com" in merged


def test_merge_links_noop_when_nothing_new():
    assert server.merge_links_into_section("no links here", "- https://x.com") == "- https://x.com"
    assert server.merge_links_into_section("", "") == ""


def test_put_note_mirrors_links(tmp_path, monkeypatch):
    # End-to-end through the section-merge path: editing Human notes mirrors any
    # inline URL into Links without clobbering agent-owned sections.
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    slug = "2026-05-19-test-conf"
    notes = tmp_path / slug / "notes"
    notes.mkdir(parents=True)
    p = notes / "0930-talk.md"
    p.write_text(server.build_note({}, "Talk", {"Research": "dossier", "Links": ""}))

    # Simulate the PUT merge logic against disk.
    _, _, disk = server.parse_note(p.read_text())
    disk["Human notes"] = "great point at stately.ai, also https://ably.com"
    disk["Links"] = server.merge_links_into_section(disk["Human notes"], disk.get("Links", ""))
    server.atomic_write(p, server.build_note({}, "Talk", disk))

    _, _, secs = server.parse_note(p.read_text())
    assert "stately.ai" in secs["Links"]
    assert "https://ably.com" in secs["Links"]
    assert secs["Research"] == "dossier"  # agent section untouched
    assert server.has_content(p)  # Human notes content lights the tick


def test_section_body_cannot_forge_another_canonical_section():
    # An agent Research write (or an imported description) that carries a
    # canonical heading must not replace the user's Human notes on re-parse.
    secs = {"Human notes": "mine", "Research": "dossier\n\n## Human notes\n\nforged"}
    _, _, parsed = server.parse_note(server.build_note({}, "Talk", secs))
    assert parsed["Human notes"] == "mine"
    assert "### Human notes" in parsed["Research"]
    assert "forged" in parsed["Research"]
