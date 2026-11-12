"""Sidebar layout: persistent across home + conference views, no width jolt."""

from __future__ import annotations


def _grid_left_track(page) -> str:
    """First column of body's grid-template-columns (the sidebar's track)."""
    cols = page.evaluate("() => getComputedStyle(document.body).gridTemplateColumns")
    return cols.split()[0]


def test_home_renders_sidebar_with_conferences(app):
    """Home shows the Conferences list in the sidebar (always present)."""
    sb = app.locator("#sidebar")
    assert sb.is_visible()
    confs = sb.locator(".sb-conf")
    assert confs.count() == 1
    assert "Beyond The Prompt" in confs.first.inner_text()
    # grip element exists so the user can resize
    assert sb.locator(".sb-grip").count() == 1


def test_main_shows_home_tabs(app):
    """Main area on home is the My events / Find events hometabs."""
    assert app.locator("#app .hometabs .htab").count() == 2


# Pick a session that's definitely a real talk (not logistics like
# Registration which lacks an editor surface) — Opening Keynote is the
# canonical first talk in the Beyond The Prompt agenda.
KEYNOTE_HREF = "#/2026-05-19-beyond-the-prompt/0940-opening-keynote.md"


def test_navigation_does_not_jolt_sidebar_width(app, confnote_server):
    """Moving home → conference → session keeps the sidebar's column width
    pinned. The bug from screenshot #21/#22 was a column appearing/vanishing."""
    home_w = _grid_left_track(app)
    app.locator(".sb-conf").first.click()
    app.wait_for_selector("#sidebar .rail")
    conf_w = _grid_left_track(app)
    app.evaluate(f"() => {{ location.hash = '{KEYNOTE_HREF[1:]}'; }}")
    app.wait_for_selector("#tabbar .tab")
    sess_w = _grid_left_track(app)

    assert home_w == conf_w == sess_w, (home_w, conf_w, sess_w)


def test_session_shows_seven_tabs_with_drag_enabled(app):
    """Editor card has the full 7-tab bar; each tab is draggable."""
    app.goto(app.url.split("#")[0] + KEYNOTE_HREF)
    app.wait_for_selector("#tabbar .tab")
    tabs = app.locator("#tabbar .tab")
    # Human notes, Summary, Research, AI notes, Transcript, Actions,
    # Links & Files, Private (the encrypted, agent-invisible section).
    assert tabs.count() == 8
    # every tab must be a drag source
    handles = tabs.evaluate_all("els => els.map(e => e.getAttribute('draggable'))")
    assert handles == ["true"] * 8
    # default active is Human notes in pane 1, no split open
    on1 = app.locator("#tabbar .tab.on1").inner_text()
    assert on1.startswith("Human notes")
    assert app.locator(".pane-col").count() == 1
