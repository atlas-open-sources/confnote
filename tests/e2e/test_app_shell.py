"""App shell: My events (Upcoming | Past) and the web build's Profile menu in the top bar."""

import re
from pathlib import Path

from playwright.sync_api import expect

REPO = Path(__file__).resolve().parents[2]

ME = {"email": "fixture@example.test", "workspaceId": "ws-1", "entitlements": {"plan": "free"}}


def _web(page, me_status=200):
    """The web build's flag plus fixture account answers; no identity or provider network calls."""
    page.add_init_script(
        "window.confnote = Object.assign(window.confnote || {}, { webMode: true });"
    )
    if me_status == 200:
        page.route("**/api/me", lambda route: route.fulfill(json=ME))
    else:
        page.route(
            "**/api/me", lambda route: route.fulfill(status=me_status, json={"error": "Sign in"})
        )
    page.route(
        "**/api/workspaces",
        lambda route: route.fulfill(json=[{"id": "ws-1", "name": "Fixture notebook"}]),
    )
    page.route("**/api/wallet", lambda route: route.fulfill(json={"available": 2000000}))
    page.route("**/api/wallet/autotopup", lambda route: route.fulfill(json={"enabled": False}))


def test_my_events_splits_upcoming_and_past(app):
    """The seed conference (2026-05-19) is past: Upcoming is empty and points at Find events."""
    when = app.locator(".mine-when")
    expect(when.get_by_role("button", name="Upcoming")).to_have_attribute("aria-pressed", "true")
    expect(app.get_by_text("No upcoming events.")).to_be_visible()
    expect(app.locator(".mine-empty").get_by_role("link", name="Find events")).to_be_visible()
    expect(app.locator("#app .trow:not(.tnow)")).to_have_count(0)
    when.get_by_role("button", name="Past").click()
    expect(app.locator("#app .trow:not(.tnow)")).to_have_count(1)
    expect(app.locator("#app .trow:not(.tnow)").first).to_contain_text("Beyond The Prompt")
    # The choice is remembered across visits.
    app.reload()
    expect(app.locator(".mine-when").get_by_role("button", name="Past")).to_have_attribute(
        "aria-pressed", "true"
    )


def test_home_tabs_are_my_events_and_find_events(app):
    tabs = app.locator("#app .hometabs .htab")
    expect(tabs).to_have_text(["My events", "Find events"])
    tabs.nth(1).click()
    expect(app).to_have_url(f"{app.url.split('#')[0]}#/~find")
    expect(app.locator("#app .hometabs .htab.on")).to_have_text("Find events")
    # The old top-bar Upcoming button and the Discover tab are gone.
    expect(app.locator("#upcomingBtn")).to_have_count(0)
    expect(app.get_by_role("button", name="Discover")).to_have_count(0)


def test_profile_sits_before_settings_and_theme(page, confnote_server):
    _web(page)
    page.set_viewport_size({"width": 1440, "height": 900})
    page.goto(str(confnote_server) + "/")
    profile = page.locator("#profileMenu")
    expect(profile).to_be_visible()
    ids = page.evaluate("[...document.querySelectorAll('#rightctl > *')].map((el) => el.id)")
    assert ids[-3:] == ["profileMenu", "settingsBtn", "theme"]
    expect(page.locator("#getMacApp")).to_have_count(0)
    expect(page.get_by_text("Account & AI")).to_have_count(0)
    profile.locator("summary").click()
    panel = profile.locator(".product-controls")
    expect(panel).to_be_visible()
    expect(panel).to_contain_text("fixture@example.test · free")
    expect(panel.locator("#account-balance")).to_have_text("AI credits: $2.00")
    expect(panel.get_by_role("link", name="Get the Mac app ↗")).to_have_count(0)
    expect(panel.get_by_role("button", name="Sign out")).to_be_visible()
    # The panel opens under the top bar, inside the viewport.
    box = panel.bounding_box()
    assert box["y"] >= 50 and box["x"] + box["width"] <= 1440
    page.keyboard.press("Escape")
    expect(panel).to_be_hidden()
    profile.locator("summary").click()
    page.locator("#app").click(position={"x": 20, "y": 300})
    expect(panel).to_be_hidden()


def test_signed_out_profile_says_sign_in(page, confnote_server):
    _web(page, me_status=401)
    page.goto(str(confnote_server) + "/")
    summary = page.locator("#profileMenu summary")
    expect(summary).to_have_text("Sign in")
    summary.click()
    panel = page.locator("#profileMenu .product-controls")
    expect(panel.get_by_role("link", name="Sign in or create an account")).to_have_attribute(
        "href", "/api/auth/signin"
    )
    expect(panel.get_by_role("link", name="Get the Mac app ↗")).to_have_count(0)


def test_mac_app_has_no_profile(app):
    """The local app has no account: the top bar ends Settings, theme."""
    expect(app.locator("#settingsBtn")).to_be_visible()
    expect(app.locator("#profileMenu")).to_have_count(0)


CATALOGUE = {
    "schema_version": "events.catalogue.v2",
    "events": [
        {
            "id": "future-community",
            "name": "Future Community Day",
            "start": "2099-05-19T18:00:00+09:00",
            "end": "2099-05-19T21:00:00+09:00",
            "timezone": "Asia/Seoul",
            "city": "Seoul",
            "country": "KR",
            "topics": ["ai"],
            "url": "https://example.com/community",
        }
    ],
}


def test_web_find_events_grid_links_stay_in_the_app(page, confnote_server):
    """On the web build the Grid's event links open the in-app detail, also after leaving and returning."""
    _web(page)
    static = REPO / "packages/catalogue-web/static/grid.js"
    page.route("**/catalogue/grid.js", lambda route: route.fulfill(path=static))
    page.route("**/api/catalogue", lambda route: route.fulfill(json=CATALOGUE))
    page.route("**/api/tracking", lambda route: route.fulfill(json={}))
    page.set_viewport_size({"width": 1440, "height": 900})
    page.goto(str(confnote_server) + "/#/~find")
    view = page.locator("#findEventsView")
    view.get_by_role("button", name="Grid", exact=True).click()
    for _ in range(2):
        link = page.locator("#events-grid").get_by_role("link", name="Future Community Day")
        expect(link).to_have_attribute("href", "#/~find/future-community")
        link.click()
        expect(view.get_by_role("heading", name="Future Community Day")).to_be_visible()
        # Leave Find events and come back: the remounted view draws a fresh grid in its own host.
        page.locator(".hometabs").get_by_role("link", name="My events").click()
        page.locator(".hometabs").get_by_role("link", name="Find events").click()
        expect(page.locator("#events-grid .ag-row")).to_have_count(1)


def test_signed_out_web_home_is_calm_and_throws_nothing(page, confnote_server):
    """Staging signed out: every account route answers 401; home says Sign in instead of erroring."""
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.add_init_script(
        "window.confnote = Object.assign(window.confnote || {}, { webMode: true });"
    )

    refused = []

    def api(route):
        if "/api/catalogue" in route.request.url:
            route.continue_()
        else:
            refused.append(route.request.url.split("/api/", 1)[1].split("?")[0])
            route.fulfill(status=401, json={"error": "Sign in required."})

    page.route(re.compile(r".*/api/.*"), api)
    page.goto(str(confnote_server) + "/#/")
    start = page.locator(".mine-start")
    expect(start).to_contain_text("Sign in to see your events")
    expect(start.get_by_role("link", name="Sign in")).to_have_attribute("href", "/api/auth/signin")
    expect(start.get_by_role("link", name="Find events")).to_have_attribute("href", "#/~find")
    expect(page.locator(".new-conf-btn")).to_have_count(0)
    expect(page.locator("#sidebar .sb-head")).to_have_text("My events")
    expect(page.locator(".product-account summary")).to_have_text("Sign in")
    page.wait_for_timeout(500)
    assert errors == []
    # One "who is signed in" probe; the notebook and settings routes are not asked just to answer 401.
    assert refused == ["me"]


def test_public_demo_still_lists_its_open_notebook(page, confnote_server):
    """The demo has no account (/api/me answers 401) but an open notebook: it must not read as signed out."""
    page.add_init_script(
        "window.confnote = Object.assign(window.confnote || {}, { webMode: true, publicDemo: true });"
    )
    asked = []

    def api(route):
        path = route.request.url.split("/api/", 1)[1].split("?")[0]
        asked.append(path)
        if path == "me":
            route.fulfill(status=401, json={"error": "Sign in required."})
        else:
            route.continue_()

    page.route(re.compile(r".*/api/.*"), api)
    page.goto(str(confnote_server) + "/#/")
    page.wait_for_function("() => document.querySelector('#sidebar .sb-confs')")
    page.wait_for_timeout(500)
    assert "conferences" in asked


def test_no_events_offers_import_and_find(empty_server, page):
    page.set_viewport_size({"width": 1400, "height": 900})
    page.goto(empty_server + "/#/")
    start = page.locator(".mine-start")
    expect(start).to_contain_text("No events yet")
    expect(start).to_contain_text("Paste a conference website or agenda link")
    expect(start.get_by_role("link", name="Find events")).to_be_visible()
    expect(page.locator("#sidebar")).to_contain_text("No events yet.")
    start.get_by_role("button", name="Import a conference").click()
    expect(page.locator("#drawerHost.open")).to_be_visible()
