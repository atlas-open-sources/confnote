"""Drag-to-split + close behaviour.

`page.locator(...).drag_to(...)` uses mouse events, which Chromium does NOT
translate to HTML5 drag events. The app listens for `dragstart` / `dragover`
/ `drop`, so we dispatch them explicitly via `evaluate`. Real user drags use
the OS-level drag synthesis and work fine in a real browser — verified
manually before this suite was written.
"""

from __future__ import annotations

# Dispatch a full HTML5 drag sequence: from tab `name` onto #panes at
# `side` ('left' | 'right'). Returns the post-drop pane count.
_DRAG_JS = r"""
({ name, side }) => {
  const tab = document.querySelector(`[data-t="${name}"]`);
  const panes = document.getElementById('panes');
  const r = panes.getBoundingClientRect();
  const x = side === 'right' ? r.left + r.width * 0.8 : r.left + r.width * 0.2;
  const y = r.top + r.height / 2;
  const dt = new DataTransfer();
  tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  panes.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
  panes.dispatchEvent(new DragEvent('dragover',  { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
  panes.dispatchEvent(new DragEvent('drop',      { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
  tab.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  return {
    paneCount: document.querySelectorAll('.pane-col').length,
    pane2Name: document.querySelector('.pane-col[data-p="2"] .pane-name')?.textContent ?? null,
    on2: [...document.querySelectorAll('#tabbar .tab.on2')].map(t => t.dataset.t),
    on1: [...document.querySelectorAll('#tabbar .tab.on1')].map(t => t.dataset.t),
    residualDropClass: document.getElementById('panes').className.match(/drop-(left|right)/)?.[0] ?? null,
  };
}
"""


# Opening Keynote is a real talk row with all 7 tabs / editor surface.
# Registration (the first agenda row) is logistics with no editor card, so
# clicking the literal first .md row doesn't reach the editor.
_KEYNOTE = "#/2026-05-19-beyond-the-prompt/0940-opening-keynote.md"


def _open_first_session(page):
    page.goto(page.url.split("#")[0] + _KEYNOTE)
    page.wait_for_selector("#panes .pane-col")
    page.wait_for_selector("#tabbar .tab")


def test_drag_to_right_opens_pane_two(app):
    _open_first_session(app)
    result = app.evaluate(_DRAG_JS, {"name": "Research", "side": "right"})
    assert result["paneCount"] == 2
    assert result["pane2Name"] == "Research"
    assert result["on2"] == ["Research"]
    assert result["on1"] == ["Human notes"]  # pane 1 untouched
    assert result["residualDropClass"] is None  # indicator cleared on drop


def test_drag_to_left_changes_pane_one(app):
    """Dropping on the left half just switches pane 1's section."""
    _open_first_session(app)
    result = app.evaluate(_DRAG_JS, {"name": "Summary", "side": "left"})
    assert result["paneCount"] == 1
    assert result["on1"] == ["Summary"]


def test_close_split_via_x_button(app):
    _open_first_session(app)
    app.evaluate(_DRAG_JS, {"name": "Research", "side": "right"})
    assert app.locator('.pane-col[data-p="2"] .pane-x').count() == 1
    app.locator('.pane-col[data-p="2"] .pane-x').click()
    assert app.locator(".pane-col").count() == 1
    assert app.locator("#tabbar .tab.on2").count() == 0


def test_pane_2_renders_section_content(app):
    """Splitting a read-only section into pane 2 should show its markdown,
    not a stuck drop indicator."""
    _open_first_session(app)
    app.evaluate(_DRAG_JS, {"name": "Research", "side": "right"})
    # paneBody2 exists and has either a pane / md / placeholder element
    body = app.locator("#paneBody2")
    assert body.count() == 1
    # at least one child rendered
    assert body.locator("> *").count() >= 1


def test_transcript_tab_is_editable_and_saves(app):
    _open_first_session(app)
    app.locator('#tabbar .tab[data-t="Transcript"]').click()
    app.wait_for_selector("#paneBody1 .EasyMDEContainer, #paneBody1 textarea", state="attached")

    result = app.evaluate(
        r"""
        async () => {
          const body = document.querySelector("#paneBody1");
          const textarea = body.querySelector("textarea");
          const cmHost = body.querySelector(".CodeMirror");
          if (cmHost?.CodeMirror) {
            cmHost.CodeMirror.setValue("Manual transcript smoke");
            cmHost.CodeMirror.getInputField().dispatchEvent(new Event("blur"));
          } else {
            textarea.value = "Manual transcript smoke";
            textarea.dispatchEvent(new Event("input", { bubbles: true }));
            textarea.dispatchEvent(new Event("blur"));
          }
          await new Promise((resolve) => setTimeout(resolve, 1200));
          const data = await fetch("/api/note?slug=2026-05-19-beyond-the-prompt&file=0940-opening-keynote.md").then((r) => r.json());
          return data.sections.Transcript;
        }
        """,
    )
    assert result == "Manual transcript smoke"


def test_human_notes_marker_updates_after_save(app):
    # Use a pristine session: the session-scoped vault is shared, and other
    # tests write a Transcript into the keynote. Since the marker now reflects
    # ANY content section (not just Human notes), an unpolluted note is needed
    # to assert the empty -> no-marker half of the toggle.
    app.evaluate("() => { location.hash = '/2026-05-19-beyond-the-prompt/0930-welcome.md'; }")
    app.wait_for_selector("#panes .pane-col")
    app.wait_for_selector("#tabbar .tab")

    def set_human_notes(text: str):
        return app.evaluate(
            r"""
            async (text) => {
              const body = document.querySelector("#paneBody1");
              const textarea = body.querySelector("textarea");
              const cmHost = body.querySelector(".CodeMirror");
              if (cmHost?.CodeMirror) {
                cmHost.CodeMirror.setValue(text);
                cmHost.CodeMirror.getInputField().dispatchEvent(new Event("blur"));
              } else {
                textarea.value = text;
                textarea.dispatchEvent(new Event("input", { bubbles: true }));
                textarea.dispatchEvent(new Event("blur"));
              }
              await new Promise((resolve) => requestAnimationFrame(resolve));
              const immediate = document.querySelector(".rl-row.active")?.classList.contains("has");
              await new Promise((resolve) => setTimeout(resolve, 1200));
              const saved = document.querySelector(".rl-row.active")?.classList.contains("has");
              return { immediate, saved };
            }
            """,
            text,
        )

    assert set_human_notes("") == {"immediate": False, "saved": False}
    assert set_human_notes("Human marker smoke") == {"immediate": True, "saved": True}


def test_repeat_drag_swaps_pane_2_section(app):
    """Dropping a different tab on the right while a split is already open
    should swap pane 2's content (not stack a third pane)."""
    _open_first_session(app)
    app.evaluate(_DRAG_JS, {"name": "Research", "side": "right"})
    result = app.evaluate(_DRAG_JS, {"name": "AI notes", "side": "right"})
    assert result["paneCount"] == 2
    assert result["pane2Name"] == "AI notes"
