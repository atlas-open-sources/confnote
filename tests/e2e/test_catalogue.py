"""Public catalogue against the real TS handler, with synthetic published data only."""

import contextlib
import os
import socket
import subprocess
import time
import urllib.request
from pathlib import Path

import pytest
from conftest import answer_settings_as_web

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def catalogue_server():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env = {
        **os.environ,
        "PORT": str(port),
        "CONFNOTE_CATALOGUE_DIR": str(ROOT / "packages/catalogue-web/fixtures"),
        "CONFNOTE_PUBLIC_DEMO": "1",
        "CONFNOTE_WEB_AGENT_MODE": "off",
        "CONFNOTE_EMAIL_MODE": "disabled",
    }
    proc = subprocess.Popen(
        [str(ROOT / "packages/web-app/node_modules/.bin/tsx"), "scripts/dev-local.ts"],
        cwd=ROOT / "packages/web-app",
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    url = f"http://127.0.0.1:{port}"
    try:
        for _ in range(100):
            try:
                with urllib.request.urlopen(url + "/api/catalogue", timeout=0.2) as response:
                    if response.status == 200:
                        break
            except OSError:
                time.sleep(0.1)
        else:
            proc.terminate()
            raise RuntimeError(proc.communicate(timeout=5)[0].decode())
        yield url
    finally:
        proc.terminate()
        with contextlib.suppress(subprocess.TimeoutExpired):
            proc.wait(timeout=5)


@pytest.mark.parametrize("width", [375, 1440])
def test_catalogue_browse_track_trip_and_sources(page, catalogue_server, width):
    page.set_viewport_size({"width": width, "height": 900})
    page.emulate_media(reduced_motion="reduce")
    page.goto(catalogue_server + "/catalogue/")
    page.locator(".event-card").first.wait_for()
    assert page.locator(".event-card").count() == 4
    assert page.locator("#sample-notice").is_visible()
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    page.locator('[name="country"]').select_option("GB")
    page.wait_for_function("document.querySelectorAll('.event-card').length === 2")
    page.locator('[data-track="evt-demo-1"]').select_option("going")
    page.reload()
    page.locator('[data-track="evt-demo-1"]').wait_for()
    assert page.locator('[data-track="evt-demo-1"]').input_value() == "going"
    page.get_by_role("button", name="Your shortlist").click()
    page.wait_for_function("document.querySelectorAll('.event-card').length === 1")
    assert "evt-demo-1" in page.locator("#calendar").get_attribute("href")
    page.get_by_role("link", name="Builders by the river").click()
    page.get_by_role("heading", name="Builders by the river").wait_for()
    assert page.get_by_role("link", name="cfp").get_attribute("href") == "https://example.org/apply"
    assert page.get_by_role("link", name="Organizer’s page").count() == 1
    page.get_by_role("button", name="Back to events").click()
    page.get_by_role("button", name="Plan a trip").click()
    page.locator('#trip-form [name="city"]').fill("Seoul")
    page.locator('#trip-form [name="from"]').fill("2099-06-11")
    page.locator('#trip-form [name="to"]').fill("2099-06-12")
    page.get_by_role("button", name="Add stop").click()
    page.get_by_role("link", name="An evening of useful code").wait_for()
    assert page.locator(".event-card").count() == 1
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    output = os.environ.get("CONFNOTE_SCREENSHOT_DIR")
    if output:
        Path(output).mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(Path(output) / f"catalogue-trip-{width}.png"), full_page=True)


def test_catalogue_grid_view_shows_the_same_filtered_events(page, catalogue_server):
    """Grid is AG Grid over the list's own events: filters, count, shortlist and feed stay in step."""
    page.set_viewport_size({"width": 1440, "height": 900})
    page.goto(catalogue_server + "/catalogue/")
    page.locator(".event-card").first.wait_for()
    assert page.locator(".event-card").count() == 4
    page.get_by_role("button", name="Grid", exact=True).click()
    # AG Grid splits a row into pinned and centre parts: count distinct row ids.
    rows = "new Set([...document.querySelectorAll('#events-grid .ag-row[row-id]')].map((r) => r.getAttribute('row-id'))).size"
    page.wait_for_function(f"{rows} === 4")
    assert page.locator("#events").is_hidden()
    assert page.locator("#result-count").inner_text().lower() == "4 upcoming events"
    page.locator('[name="country"]').select_option("GB")
    page.wait_for_function(f"{rows} === 2")
    assert page.locator("#result-count").inner_text().lower() == "2 upcoming events"
    assert "country=GB" in page.locator("#calendar").get_attribute("href")
    # Shortlist from the grid's own column; the list sees it after switching back.
    cell = page.locator("#events-grid .ag-row[row-id='evt-demo-1'] [col-id='track']").first
    cell.click()
    cell.locator(".ag-picker-field-wrapper").click()
    page.locator(".ag-select-list .ag-list-item", has_text="going").click()
    page.wait_for_function("document.querySelector('#saved-count').textContent === '1'")
    page.reload()
    page.locator("#events-grid .ag-row").first.wait_for()  # the layout choice persists
    page.get_by_role("button", name="List", exact=True).click()
    assert page.locator('[data-track="evt-demo-1"]').input_value() == "going"


def test_mobile_shell_agenda_toggle(page, confnote_server):
    page.set_viewport_size({"width": 375, "height": 812})
    page.goto(str(confnote_server) + "/")
    toggle = page.get_by_role("button", name="Show agenda")
    toggle.wait_for()
    assert not page.locator("#sidebar").is_visible()
    toggle.click()
    assert page.locator("#sidebar").is_visible()
    assert toggle.get_attribute("aria-expanded") == "true"
    page.keyboard.press("Escape")
    assert not page.locator("#sidebar").is_visible()
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")


@pytest.mark.parametrize("endpoint", ["/api/chat/global", "/api/chat/session"])
def test_web_account_keeps_byok_in_memory_and_adds_verified_workspace_header(
    page, confnote_server, endpoint
):
    """Fake authenticated product endpoints; no identity or provider network calls."""
    answer_settings_as_web(page)
    page.route(
        "**/api/me",
        lambda route: route.fulfill(
            json={
                "email": "fixture@example.test",
                "workspaceId": "owned-fixture",
                "entitlements": {"plan": "free"},
            }
        ),
    )
    page.route(
        "**/api/workspaces",
        lambda route: route.fulfill(json=[{"id": "owned-fixture", "name": "Fixture notebook"}]),
    )
    page.route(
        "**/api/wallet",
        lambda route: route.fulfill(json={"buyMoreUrl": "https://example.test/credits"}),
    )
    requests = []

    def chat(route):
        requests.append({"body": route.request.post_data_json, "headers": route.request.headers})
        route.fulfill(body='{"done":true}\n', content_type="application/x-ndjson")

    page.route("**" + endpoint, chat)
    page.goto(str(confnote_server) + "/?workspace=owned-fixture")
    page.locator(".product-account summary").click()
    page.locator('#byok-form [name="model"]').fill("fixture-model")
    page.locator('#byok-form [name="key"]').fill("synthetic-fixture-key")
    page.get_by_role("button", name="Use my key for this tab").click()
    page.wait_for_function(
        "document.querySelector('#account-status').textContent.includes('this tab only')"
    )
    page.evaluate(
        "(endpoint) => fetch(endpoint, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({messages:[]})})",
        endpoint,
    )
    assert requests[-1]["body"]["byok"]["provider"] == "openai"
    assert requests[-1]["body"]["byok"]["model"] == "fixture-model"
    byok = requests[-1]["body"]["byok"]
    assert byok["apiKey"] == "synthetic-fixture-key"  # pragma: allowlist secret
    assert requests[-1]["headers"]["x-workspace-id"] == "owned-fixture"
    assert "synthetic-fixture-key" not in page.evaluate(
        "JSON.stringify(localStorage) + JSON.stringify(sessionStorage)"
    )
    page.get_by_role("button", name="Clear key", exact=True).click()
    page.evaluate(
        "(endpoint) => fetch(endpoint, {method:'POST', body:JSON.stringify({messages:[]})})",
        endpoint,
    )
    assert "byok" not in requests[-1]["body"]
    page.reload()
    page.evaluate(
        "(endpoint) => fetch(endpoint, {method:'POST', body:JSON.stringify({messages:[]})})",
        endpoint,
    )
    assert "byok" not in requests[-1]["body"]
