"""Signed-out demo event: Beyond The Prompt in the browser-only demo, from the static /demo-event/ files.

The page is marked as the web build (`webMode`); /api/me answers 401 (signed out) or a fixture account.
Every notebook read in the demo is answered by product-shell.js from /demo-event/, never the server.
"""

import json
import re

from playwright.sync_api import expect

ME = {"email": "fixture@example.test", "workspaceId": "ws-1", "entitlements": {"plan": "free"}}
SLUG = "2026-05-19-beyond-the-prompt"
BANNER = "Demo: saved in this browser. Sign in to keep your notes."


def _web(page, signed_in=False):
    page.add_init_script(
        "window.confnote = Object.assign(window.confnote || {}, { webMode: true });"
    )
    status = 200 if signed_in else 401
    body = ME if signed_in else {"error": "Sign in required."}
    page.route("**/api/me", lambda route: route.fulfill(status=status, json=body))


def _start_demo(page, server):
    page.set_viewport_size({"width": 1400, "height": 900})
    page.goto(str(server) + "/#/")
    page.locator("#sidebar").get_by_role("button", name="Try a demo event").click()
    expect(page).to_have_url(re.compile(rf"#/{SLUG}$"))
    expect(page.locator(".demo-event-bar")).to_contain_text(BANNER)


def test_demo_event_opens_beyond_the_prompt_signed_out(page, confnote_server):
    _web(page)
    notebook = []
    page.on(
        "request",
        lambda r: (
            notebook.append(r.url)
            if "/api/" in r.url and not re.search(r"/api/(me|auth/|catalogue)", r.url)
            else None
        ),
    )
    _start_demo(page, confnote_server)
    expect(page.get_by_text("Opening Keynote").first).to_be_visible()
    # It reads as a demo, not as one of your events: the dashed card and its chip.
    expect(page.locator(".rl-head.starter .starter-chip")).to_have_text("Demo event")
    page.wait_for_timeout(500)
    bar = page.locator(".demo-event-bar")
    expect(bar.get_by_role("link", name="Sign in")).to_have_attribute(
        "href", "/api/auth/signin?returnTo=%2F"
    )
    # No notebook request reached the server: the demo reads its static files.
    assert notebook == []
    # A session note opens with the browser-only editor.
    page.goto(str(confnote_server) + f"/#/{SLUG}/0940-opening-keynote.md")
    expect(page.locator(".demo-event-bar")).to_be_visible()
    expect(page.get_by_text("Opening Keynote").first).to_be_visible()
    assert notebook == []
    page.goto(str(confnote_server) + "/#/")
    expect(page.locator("#sidebar .sb-conf.starter .starter-chip")).to_have_text("Demo event")
    # Leaving the demo ends it.
    bar.get_by_role("button", name="Leave demo").click()
    expect(page.locator(".demo-event-bar")).to_have_count(0)
    assert page.evaluate("sessionStorage.getItem('confnote-demo-event')") is None


def test_demo_concierge_asks_to_sign_in_instead_of_failing(page, confnote_server):
    _web(page)
    _start_demo(page, confnote_server)
    reply = page.evaluate(
        """async () => (await (await fetch('/api/chat/global?slug=x', {
            method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'})).text())"""
    )
    assert "sign in to use it" in json.loads(reply.strip())["text"]
    dialog = page.get_by_role("dialog", name="Sign in to use the Concierge")
    expect(dialog).to_be_visible()
    dialog.get_by_role("button", name="Keep exploring").click()
    expect(dialog).to_have_count(0)


def test_signed_in_never_sees_the_demo(page, confnote_server):
    _web(page, signed_in=True)
    # Set once, as a demo left running before signing in would be (an init script runs on every load).
    page.add_init_script(
        "if (!sessionStorage.getItem('seeded')) {"
        " sessionStorage.setItem('seeded', '1'); sessionStorage.setItem('confnote-demo-event', '1'); }"
    )
    page.set_viewport_size({"width": 1400, "height": 900})
    page.goto(str(confnote_server) + "/#/")
    # The account ends the demo: the flag is cleared and the page reloads as the account's.
    page.wait_for_function("() => !document.querySelector('.demo-event-bar')", timeout=10000)
    expect(page.locator("#sidebar")).to_contain_text("Beyond The Prompt")
    expect(page.locator("#sidebar").get_by_role("button", name="Try a demo event")).to_have_count(0)


def test_sign_in_prompt_offers_the_demo(page, confnote_server):
    _web(page)
    page.set_viewport_size({"width": 1400, "height": 900})
    page.goto(str(confnote_server) + "/#/~find")
    page.locator(".featured-card").get_by_role("button", name="Add to My events").click()
    dialog = page.get_by_role("dialog", name="Sign in to save events to My events")
    dialog.get_by_role("button", name="Try a demo event").click()
    expect(page).to_have_url(re.compile(rf"#/{SLUG}$"))
    expect(page.locator(".demo-event-bar")).to_be_visible()


def _open_concierge(page):
    page.wait_for_selector(".drawer-tab[data-id='chat']")
    page.locator(".drawer-tab[data-id='chat']").click()
    greeting = page.locator(".chat-inner deep-chat").get_by_text("Paste a conference website")
    expect(greeting).to_be_visible(timeout=10000)
    return page.locator(".chat-inner deep-chat .cn-demo")


def test_web_greeting_offers_the_demo_signed_out(page, confnote_server):
    _web(page)
    page.set_viewport_size({"width": 1400, "height": 900})
    page.goto(str(confnote_server) + "/#/")
    _open_concierge(page).click()
    expect(page).to_have_url(re.compile(rf"#/{SLUG}$"))
    expect(page.locator(".demo-event-bar")).to_be_visible()


def test_web_greeting_imports_the_demo_agenda_signed_in(page, confnote_server):
    _web(page, signed_in=True)
    page.route("**/api/conferences", lambda route: route.fulfill(json=[]))
    sent = []

    def chat(route):
        sent.append(route.request.post_data or "")
        route.fulfill(body='{"text": "Importing."}\n', content_type="application/x-ndjson")

    page.route("**/api/chat/global*", chat)
    page.set_viewport_size({"width": 1400, "height": 900})
    page.goto(str(confnote_server) + "/#/")
    _open_concierge(page).click()
    page.wait_for_function("() => true")
    expect(page.locator(".chat-inner deep-chat").get_by_text("Importing.")).to_be_visible()
    assert "beyond-the-prompt-agenda.json" in sent[0]


def test_signed_in_sidebar_offers_the_starter_event(page, confnote_server):
    _web(page, signed_in=True)
    page.set_viewport_size({"width": 1400, "height": 900})
    page.goto(str(confnote_server) + "/#/")
    starter = page.locator("#sidebar .sb-starter")
    expect(starter.locator(".starter-chip")).to_have_text("Starter event")
    # The account's own conferences are listed as usual, above it.
    expect(page.locator("#sidebar .sb-conf:not(.starter)").first).to_contain_text(
        "Beyond The Prompt"
    )
    starter.locator(".sb-n").click()
    expect(page).to_have_url(re.compile(rf"#/{SLUG}$"))
    bar = page.locator(".demo-event-bar")
    expect(bar).to_contain_text("Starter event: your notes here stay in this browser.")
    expect(bar.get_by_role("link", name="Sign in")).to_have_count(0)
    # Signed in, the starter event stays open (only a signed-out demo ends on an account).
    page.wait_for_timeout(1000)
    expect(bar).to_be_visible()
    expect(page.locator(".rl-head.starter .starter-chip")).to_have_text("Starter event")
    bar.get_by_role("button", name="Back to my events").click()
    expect(page.locator(".demo-event-bar")).to_have_count(0)
    expect(page.locator("#sidebar .sb-starter")).to_be_visible()


def test_starter_event_can_be_hidden_and_shown_again(page, confnote_server):
    _web(page, signed_in=True)
    page.set_viewport_size({"width": 1400, "height": 900})
    page.goto(str(confnote_server) + "/#/")
    page.locator("#sidebar .sb-starter").get_by_role("button", name="Hide").click()
    expect(page.locator("#sidebar .sb-starter")).to_have_count(0)
    page.reload()
    expect(page.locator("#sidebar .sb-starter")).to_have_count(0)
    page.locator("#sidebar").get_by_role("button", name="Show the starter event").click()
    expect(page.locator("#sidebar .sb-starter")).to_be_visible()
