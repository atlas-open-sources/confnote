"""Signed out on the hosted site, adding an event asks the visitor to sign in instead of failing.

The page is marked as the web build (`webMode`) and /api/me answers as signed in or out; the notebook
write (/api/conferences) is answered by the test, so nothing is added to the shared fixture vault.
"""

import json
import re

from playwright.sync_api import expect

ME = {"email": "fixture@example.test", "workspaceId": "ws-1", "entitlements": {"plan": "free"}}
MANIFEST = "/discover/ai-engineer-worldsfair-2026.json"
CATALOGUE = {
    "schema_version": "events.catalogue.v2",
    "catalogue_updated_at": "2026-10-31T00:00:00Z",
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


def _web(page, signed_in, posts, post_status=200):
    """The web build's flag, a fixture account (or none) and a recorded notebook write."""
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
    page.route("**/api/catalogue", lambda route: route.fulfill(json=CATALOGUE))
    page.route("**/api/tracking", lambda route: route.fulfill(json={}))

    def conferences(route):
        if route.request.method != "POST":
            route.continue_()
            return
        posts.append(json.loads(route.request.post_data or "{}"))
        if post_status == 401:
            route.fulfill(status=401, json={"error": "Sign in required."})
        else:
            route.fulfill(json={"ok": True, "slug": "ai-engineer-worldsfair-2026"})

    page.route("**/api/conferences", conferences)


def _featured_add(page):
    return page.locator(".featured-card").get_by_role("button", name="Add to My events")


def test_signed_out_featured_add_opens_the_sign_in_prompt(page, confnote_server):
    posts = []
    _web(page, signed_in=False, posts=posts)
    page.goto(str(confnote_server) + "/#/~find")
    _featured_add(page).click()
    prompt = page.get_by_role("dialog", name="Sign in to save events to My events")
    expect(prompt).to_be_visible()
    expect(prompt.get_by_role("link", name="Sign in")).to_have_attribute(
        "href", "/api/auth/signin?returnTo=%2F%23%2F~find"
    )
    # No write was tried, no error line, and the button is its normal self.
    assert posts == []
    expect(page.locator("#status")).not_to_contain_text("Could not add")
    expect(_featured_add(page)).to_be_enabled()
    expect(page.get_by_role("button", name="Try again")).to_have_count(0)
    # Cancel closes it and keeps nothing pending.
    prompt.get_by_role("button", name="Cancel").click()
    expect(prompt).to_have_count(0)
    assert page.evaluate("localStorage.getItem('confnote-pending-add')") is None
    # Escape closes it too.
    _featured_add(page).click()
    expect(prompt).to_be_visible()
    page.keyboard.press("Escape")
    expect(prompt).to_have_count(0)


def test_sign_in_from_the_prompt_adds_the_event_on_return(page, confnote_server):
    posts = []
    _web(page, signed_in=False, posts=posts)
    page.route(
        re.compile(r".*/api/auth/signin.*"),
        lambda route: route.fulfill(status=200, body="signin", content_type="text/plain"),
    )
    page.goto(str(confnote_server) + "/#/~find")
    _featured_add(page).click()
    page.locator("#signInPrompt").get_by_role("link", name="Sign in").click()
    page.wait_for_url(re.compile(r".*/api/auth/signin.*"))
    pending = json.loads(page.evaluate("localStorage.getItem('confnote-pending-add')"))
    assert pending["manifest"] == MANIFEST

    # Back from the identity provider, signed in: the event is added without another click.
    page.unroute("**/api/me")
    page.route("**/api/me", lambda route: route.fulfill(json=ME))
    page.goto(str(confnote_server) + "/#/~find")
    expect(page).to_have_url(re.compile(r"#/ai-engineer-worldsfair-2026$"))
    assert len(posts) == 1
    assert posts[0]["agenda"]
    assert page.evaluate("localStorage.getItem('confnote-pending-add')") is None


def test_a_401_while_adding_opens_the_prompt_not_try_again(page, confnote_server):
    posts = []
    _web(page, signed_in=True, posts=posts, post_status=401)
    page.goto(str(confnote_server) + "/#/~find")
    _featured_add(page).click()
    expect(page.get_by_role("dialog", name="Sign in to save events to My events")).to_be_visible()
    assert len(posts) == 1
    expect(_featured_add(page)).to_be_enabled()
    expect(page.locator("#status")).not_to_contain_text("Could not add")


def test_signed_out_shortlist_saves_on_device_and_offers_sign_in(page, confnote_server):
    posts = []
    _web(page, signed_in=False, posts=posts)
    page.goto(str(confnote_server) + "/#/~find")
    view = page.locator("#findEventsView")
    view.locator('[data-track="future-community"]').select_option("interested")
    message = view.locator("#message")
    expect(message).to_contain_text(
        "Saved on this device. Sign in to keep your shortlist with your account."
    )
    expect(message.get_by_role("link", name="Sign in")).to_have_attribute(
        "href", re.compile(r"^/api/auth/signin\?returnTo=")
    )
    expect(view.locator("#saved-count")).to_have_text("1")


def test_ended_featured_event_does_not_say_happening_now(page, confnote_server):
    page.goto(str(confnote_server) + "/#/~find")
    card = page.locator(".featured-card").first
    expect(card).to_be_visible()
    status = card.locator(".fc-status").inner_text()
    if status != "Happening now":
        expect(card).not_to_contain_text("Happening now")
