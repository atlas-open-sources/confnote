"""Picks live in the notebook: a star is `attending: true` in the session
note's frontmatter, so it survives clearing the browser, shows on another
device, and stars kept in localStorage before are filed into the notes once."""

from __future__ import annotations

import re

from playwright.sync_api import expect

SLUG = "2026-05-19-beyond-the-prompt"
KEYNOTE = "0940-opening-keynote.md"
SLOP = "1010-goodbye-slop.md"


def _saved_picks(vault) -> list:
    return sorted(
        note.name
        for note in (vault / SLUG / "notes").glob("*.md")
        if "\nattending: true\n" in note.read_text().partition("\n---\n")[0] + "\n"
    )


def _open_conference(page, base: str) -> None:
    page.goto(f"{base}/#/{SLUG}")
    page.wait_for_selector("#railTrack .rl-row")


def _rail_row(page, title: str):
    return page.locator("#railTrack .rl-row", has_text=title).first


def test_a_star_is_saved_in_the_note_and_survives_a_fresh_browser(app, confnote_server, browser):
    _open_conference(app, confnote_server.url)
    row = _rail_row(app, "Opening Keynote")
    row.hover()
    row.locator(".rl-star").click()
    expect(row).to_have_class(re.compile(r"\bstarred\b"))
    app.wait_for_function(
        f"async () => (await (await fetch('/api/picks?slug={SLUG}')).json()).notes.includes('{KEYNOTE}')"
    )
    assert _saved_picks(confnote_server.vault) == [KEYNOTE]
    assert app.evaluate(f"() => localStorage.getItem('confnote-stars-{SLUG}')") is None

    # Another browser, nothing in its storage: the pick is still there, in My Agenda too.
    other = browser.new_context()
    try:
        page = other.new_page()
        page.set_viewport_size({"width": 1400, "height": 900})
        _open_conference(page, confnote_server.url)
        expect(_rail_row(page, "Opening Keynote")).to_have_class(re.compile(r"\bstarred\b"))
        page.goto(f"{confnote_server.url}/#/{SLUG}")
        page.locator('.conf-tab[data-view="agenda"]').click()
        expect(page.locator(".agenda-view .session-card")).to_have_count(1)
        expect(page.locator(".agenda-view .session-card")).to_contain_text("Opening Keynote")
    finally:
        other.close()


def test_stars_from_before_are_filed_into_the_notes_once(confnote_server, page):
    page.set_viewport_size({"width": 1400, "height": 900})
    page.add_init_script(f"""if (!sessionStorage.getItem('confnote-test-initialized')) {{
        localStorage.clear();
        localStorage.setItem('confnote-stars-{SLUG}', JSON.stringify(['{KEYNOTE}', '{SLOP}', '0000-gone.md']));
        sessionStorage.setItem('confnote-test-initialized', '1');
    }}""")
    _open_conference(page, confnote_server.url)
    page.wait_for_function(f"() => localStorage.getItem('confnote-stars-{SLUG}') === null")
    assert _saved_picks(confnote_server.vault) == [KEYNOTE, SLOP]
    expect(page.locator("#railTrack .rl-row.starred")).to_have_count(2)


def test_a_pick_made_elsewhere_shows_when_the_window_comes_back(app, confnote_server):
    _open_conference(app, confnote_server.url)
    expect(app.locator("#railTrack .rl-row.starred")).to_have_count(0)
    # Another device (or the Concierge) picks the keynote in the notebook.
    note = confnote_server.vault / SLUG / "notes" / KEYNOTE
    head, sep, body = note.read_text().partition("\n---\n")
    note.write_text(f"{head}\nattending: true{sep}{body}")
    app.evaluate("() => window.dispatchEvent(new Event('focus'))")
    expect(_rail_row(app, "Opening Keynote")).to_have_class(re.compile(r"\bstarred\b"))
