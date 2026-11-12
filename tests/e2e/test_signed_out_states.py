"""Signed-out empty states are a way in, Grids opens on data, and the hosted modules carry the licence note.

The page is marked as the web build (`webMode`) and /api/me answers 401 (signed out) or a fixture
account; nothing reaches an identity provider.
"""

import re

from playwright.sync_api import expect

ME = {"email": "fixture@example.test", "workspaceId": "ws-1", "entitlements": {"plan": "free"}}
LICENCE = "Bryntum and tldraw run on confnote.si for the PayPal AI Hackathon judging period."


def _web(page, signed_in):
    page.add_init_script(
        "window.confnote = Object.assign(window.confnote || {}, { webMode: true });"
    )
    if signed_in:
        page.route("**/api/me", lambda route: route.fulfill(json=ME))
    else:
        page.route(
            "**/api/me",
            lambda route: route.fulfill(status=401, json={"error": "Sign in required."}),
        )


def _open_drawer(page, module_id):
    page.wait_for_selector(f".drawer-tab[data-id='{module_id}']")
    page.locator(f".drawer-tab[data-id='{module_id}']").click()
    page.wait_for_function(
        "() => document.getElementById('drawerHost')?.classList.contains('open')"
    )


def test_signed_out_sidebar_offers_sign_in(page, confnote_server):
    _web(page, signed_in=False)
    page.set_viewport_size({"width": 1400, "height": 900})
    page.goto(str(confnote_server) + "/#/")
    empty = page.locator("#sidebar .sb-signed-out")
    expect(empty).to_contain_text("Sign in to see your events.")
    expect(empty.get_by_role("link", name="Sign in")).to_have_attribute(
        "href", "/api/auth/signin?returnTo=%2F"
    )


def test_grids_opens_on_events_when_there_are_no_actions(page, confnote_server):
    _web(page, signed_in=True)
    page.route("**/api/actions*", lambda route: route.fulfill(json=[]))
    page.route("**/api/conferences", lambda route: route.fulfill(json=[]))
    page.set_viewport_size({"width": 1400, "height": 900})
    page.goto(str(confnote_server) + "/#/")
    _open_drawer(page, "aggrid")
    tabs = page.locator(".grids-tabs")
    expect(tabs.locator(".grids-tab.on")).to_have_text("Events")
    # Picking Actions shows why it is empty and the way back to Events.
    tabs.get_by_role("tab", name="Actions").click()
    status = page.locator(".grids-status")
    expect(status).to_contain_text("No open actions yet.")
    status.get_by_role("button", name="Show events").click()
    expect(tabs.locator(".grids-tab.on")).to_have_text("Events")


def test_grids_signed_out_offers_sign_in(page, confnote_server):
    _web(page, signed_in=False)
    page.route("**/api/wallet/usage*", lambda route: route.fulfill(status=401, json={}))
    page.set_viewport_size({"width": 1400, "height": 900})
    page.goto(str(confnote_server) + "/#/")
    _open_drawer(page, "aggrid")
    tabs = page.locator(".grids-tabs")
    expect(tabs.locator(".grids-tab.on")).to_have_text("Events")
    tabs.get_by_role("tab", name="Ledger").click()
    status = page.locator(".grids-status")
    expect(status).to_contain_text("Sign in to see your own data here.")
    expect(status.get_by_role("link", name="Sign in")).to_have_attribute(
        "href", re.compile(r"^/api/auth/signin\?returnTo=")
    )


def test_hosted_planner_shows_the_licence_note(page, confnote_server):
    _web(page, signed_in=True)
    page.set_viewport_size({"width": 1400, "height": 900})
    page.goto(str(confnote_server) + "/#/")
    _open_drawer(page, "bryntum")
    note = page.locator(".cn-licence-note")
    expect(note).to_contain_text(LICENCE)
    expect(note.get_by_role("link", name="support@atlascodes.ai")).to_have_attribute(
        "href", "mailto:support@atlascodes.ai"
    )


def test_local_planner_has_no_licence_note(page, confnote_server):
    page.set_viewport_size({"width": 1400, "height": 900})
    page.goto(str(confnote_server) + "/#/")
    _open_drawer(page, "bryntum")
    expect(page.locator(".cn-bry")).to_be_visible()
    expect(page.locator(".cn-licence-note")).to_have_count(0)
