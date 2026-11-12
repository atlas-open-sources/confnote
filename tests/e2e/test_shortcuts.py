"""Keyboard shortcuts + the Settings → Shortcuts reference page.

Drives the real global key dispatcher in app.js. The fixture vault is the
seeded Beyond The Prompt conference, so a note (with section tabs) is available.
"""

from __future__ import annotations


def test_cmd_backslash_toggles_sidebar(app):
    app.goto(app.url.split("#")[0] + "#/")
    app.wait_for_selector("#sidebar")
    assert app.evaluate("() => document.body.classList.contains('sidebar-hidden')") is False
    app.keyboard.press("Meta+Backslash")
    app.wait_for_function("() => document.body.classList.contains('sidebar-hidden')", timeout=2000)
    app.keyboard.press("Meta+Backslash")
    app.wait_for_function("() => !document.body.classList.contains('sidebar-hidden')", timeout=2000)


def test_cmd_k_opens_concierge(app):
    app.goto(app.url.split("#")[0] + "#/2026-05-19-beyond-the-prompt")
    app.wait_for_selector(".drawer-tab[data-id='chat']")
    app.keyboard.press("Meta+k")
    app.wait_for_selector(".chat-ctx-strip", timeout=3000)


def test_cmd_shift_k_opens_sketch_slot(app):
    app.goto(app.url.split("#")[0] + "#/2026-05-19-beyond-the-prompt")
    app.wait_for_function("() => document.querySelectorAll('.drawer-tab').length >= 3")
    slot = app.evaluate("() => document.querySelectorAll('.drawer-tab')[2]?.dataset.id")
    assert slot  # 3rd slot on the strip = Sketch
    app.keyboard.press("Meta+Shift+k")
    app.wait_for_function(f"() => window.confnote.drawer.isOpen('{slot}')", timeout=3000)


def test_question_mark_opens_shortcuts_help(app):
    app.goto(app.url.split("#")[0] + "#/")
    app.wait_for_selector("#sidebar")
    app.keyboard.press("Shift+Slash")  # "?"
    app.wait_for_selector("#setShortcuts", timeout=3000)
    # the reference renders kbd chips for the bindings
    assert app.locator("#setShortcuts kbd").count() > 5
    txt = app.locator("#setShortcuts").inner_text()
    assert "Concierge" in txt
    assert "agenda sidebar" in txt


def test_cmd_comma_opens_settings(app):
    app.goto(app.url.split("#")[0] + "#/")
    app.wait_for_selector("#sidebar")
    app.keyboard.press("Meta+Comma")
    app.wait_for_selector("#setShortcuts", timeout=3000)


def test_number_keys_switch_note_sections(app):
    # open a session note so the section tab bar exists
    app.goto(app.url.split("#")[0] + "#/2026-05-19-beyond-the-prompt/0940-opening-keynote.md")
    app.wait_for_selector("#tabbar .tab.on1")
    # default first tab = Human notes
    assert "Human notes" in app.locator("#tabbar .tab.on1").inner_text()
    app.keyboard.press("3")  # → Research (TABS[2])
    app.wait_for_function(
        "() => document.querySelector('#tabbar .tab.on1')?.textContent.includes('Research')",
        timeout=2000,
    )
    app.keyboard.press("[")  # cycle back to AI notes? no — back one to Summary
    app.wait_for_function(
        "() => document.querySelector('#tabbar .tab.on1')?.textContent.includes('Summary')",
        timeout=2000,
    )


def test_number_keys_ignored_while_typing(app):
    # focus the concierge input, type "3" — must NOT switch a note section
    app.goto(app.url.split("#")[0] + "#/2026-05-19-beyond-the-prompt/0940-opening-keynote.md")
    app.wait_for_selector("#tabbar .tab.on1")
    app.keyboard.press("Meta+k")  # open + focus concierge
    app.wait_for_selector(".chat-ctx-strip", timeout=3000)
    app.wait_for_timeout(300)
    app.keyboard.type("3")
    app.wait_for_timeout(200)
    # still on Human notes — the "3" went into the chat box, not the dispatcher
    assert "Human notes" in app.locator("#tabbar .tab.on1").inner_text()
