"""Playwright e2e for the ★ Brief / ✎ Debrief conference docs and the
✔ Actions rollup, all surfaced from the sidebar agenda-acts row.

Brief / Debrief now open INLINE in the editor pane (route #/<slug>/~brief|
~debrief) as an editable doc — not a modal. The ✔ Actions rollup is still a
modal. A readonly-pane test guards the markdown list-numbering fix that used
to be checked via the (now removed) debrief modal.
"""

from __future__ import annotations

CONF = "2026-05-19-beyond-the-prompt"


def _open_conf(page):
    page.evaluate(f"() => {{ location.hash = '#/{CONF}'; }}")
    page.wait_for_selector(".agenda-brief", timeout=3000)


# ----------------------------------------------------- agenda-acts buttons


def test_agenda_acts_has_three_buttons(app):
    _open_conf(app)
    assert app.locator(".agenda-brief").count() == 1
    assert app.locator(".agenda-actions").count() == 1
    assert app.locator(".agenda-confdebrief").count() == 1


def test_agenda_acts_button_labels(app):
    _open_conf(app)
    out = app.evaluate(
        """() => ({
          brief: document.querySelector('.agenda-brief').textContent.trim(),
          actions: document.querySelector('.agenda-actions').textContent.trim(),
          debrief: document.querySelector('.agenda-confdebrief').textContent.trim(),
        })"""
    )
    assert "Brief" in out["brief"]
    assert "★" in out["brief"]
    assert "Actions" in out["actions"]
    assert "✔" in out["actions"]
    assert "Debrief" in out["debrief"]


def test_actions_modal_header_opens_source_actions_tab(app, confnote_server):
    note = confnote_server.vault / CONF / "notes" / "1010-goodbye-slop.md"
    note.write_text(
        note.read_text().replace(
            "## Actions\n\nTasks and follow-ups — `- [ ] task` lines, tick them off as you go.",
            "## Actions\n\n- [ ] source jump smoke",
        )
    )

    _open_conf(app)
    app.locator(".agenda-actions").click()
    app.wait_for_selector("#debriefModal .act-open", timeout=3000)
    app.locator("#debriefModal .act-open").filter(has_text="source jump smoke").click()

    app.wait_for_function(
        "() => location.hash.endsWith('/1010-goodbye-slop.md')"
        " && document.querySelector('#tabbar .tab.on1')?.dataset.t === 'Actions'"
        " && !document.getElementById('debriefModal')",
        timeout=3000,
    )


# ------------------------------------------- Brief / Debrief inline editor


def test_brief_opens_inline_rendered_by_default(app, confnote_server):
    """Brief opens inline in the pretty (rendered) view by default — not the
    raw editor — with an Edit toggle and the sidebar button marked active."""
    (confnote_server.vault / CONF / "BRIEF.md").write_text("# Day plan\n\n- listen for X\n")
    _open_conf(app)
    app.locator(".agenda-brief").click()
    app.wait_for_function(
        "() => location.hash.endsWith('/~brief') && !!document.querySelector('#confDocPane .md')",
        timeout=3000,
    )
    assert app.locator("#briefModal").count() == 0  # modal is gone
    assert app.locator("#editor .ehead h1").inner_text() == "Brief"
    assert app.locator(".agenda-brief.active").count() == 1
    # rendered, not an editor: markdown is HTML and there's no textarea yet
    assert app.locator("#confDocPane .md h1").count() >= 1
    assert app.locator("#confDocTa").count() == 0
    body = app.locator("#confDocPane .md").inner_text()
    assert "Day plan" in body and "listen for X" in body
    assert app.locator("#confDocToggle").inner_text() == "✎ Edit"


def test_brief_edit_toggle_swaps_to_editor_and_back(app, confnote_server):
    (confnote_server.vault / CONF / "BRIEF.md").write_text("# Day plan\n")
    _open_conf(app)
    app.locator(".agenda-brief").click()
    app.wait_for_selector("#confDocPane .md", timeout=3000)
    # toggle → edit: EasyMDE textarea appears, seeded with the content
    app.locator("#confDocToggle").click()
    app.wait_for_selector("#confDocTa", state="attached", timeout=3000)
    assert "Day plan" in app.evaluate("() => document.getElementById('confDocTa').value")
    assert app.locator("#confDocToggle").inner_text() == "✓ Done"
    # toggle back → rendered view returns
    app.locator("#confDocToggle").click()
    app.wait_for_function(
        "() => !!document.querySelector('#confDocPane .md') && !document.getElementById('confDocTa')",
        timeout=3000,
    )


def test_debrief_opens_inline_rendered(app, confnote_server):
    (confnote_server.vault / CONF / "DEBRIEF.md").write_text("# Recap\n\n## Wins\n\n- shipped\n")
    _open_conf(app)
    app.locator(".agenda-confdebrief").click()
    app.wait_for_function(
        "() => location.hash.endsWith('/~debrief') && !!document.querySelector('#confDocPane .md')",
        timeout=3000,
    )
    assert app.locator("#editor .ehead h1").inner_text() == "Debrief"
    assert app.locator(".agenda-confdebrief.active").count() == 1
    assert app.locator("#confDocPane .md h2").count() >= 1  # ## Wins rendered


# ------------------------------------- readonly-pane markdown list numbering


def test_readonly_pane_numbered_list_stays_one_ordered_list(app, confnote_server):
    """Numbered items separated by blank lines (how the agent writes them) must
    render as a SINGLE <ol> in a readonly section preview — not one <ol> per
    item each restarting at 1 (the "1. 1. 1." bug). Checked on the Summary pane
    now that the debrief is an editor, not a rendered modal."""
    note = confnote_server.vault / CONF / "notes" / "1010-goodbye-slop.md"
    note.write_text(
        "---\nid: goodbye-slop\n---\n\n# Goodbye slop\n\n"
        "## Human notes\n\n\n"
        "## Summary\n\n1. first takeaway\n\n2. second takeaway\n\n3. third takeaway\n\n"
        "## Research\n\n\n## AI notes\n\n\n## Transcript\n\n\n"
        "## Actions\n\n\n## Links\n\n\n## Scratchpad\n\n"
    )
    app.evaluate(f"() => {{ location.hash = '#/{CONF}/1010-goodbye-slop.md'; }}")
    app.wait_for_selector("#tabbar", timeout=3000)
    app.locator("#tabbar .tab", has_text="Summary").first.click()
    app.wait_for_selector("#editor .md ol", timeout=3000)
    assert app.locator("#editor .md ol").count() == 1
    assert app.locator("#editor .md ol li").count() == 3
