"""Web-target smoke for the Vercel Functions version.

Requires WEB_BASE_URL via Makefile, passed through as CONFNOTE_E2E_BASE_URL.
The test seeds a unique conference through the public import API, then verifies
the SPA can load, edit a note, refresh, and keep the edit.
"""

from __future__ import annotations

import os
import time

import pytest


def _agenda(name: str, date: str = "2099-01-23") -> dict:
    return {
        "schema_version": "confnote.agenda.v1",
        "conference": {
            "name": name,
            "date": date,
            "timezone": "Europe/London",
            "venue": {"name": "Web Preview", "address": "Online"},
        },
        "speakers": {
            "ada": {
                "name": "Ada Lovelace",
                "role": "Speaker",
                "company": "Analytical Engines",
                "bio": "",
            }
        },
        "events": [
            {
                "id": "opening",
                "type": "talk",
                "title": "Opening",
                "description": "A deterministic web smoke session.",
                "start": f"{date}T09:00:00+00:00",
                "end": f"{date}T09:30:00+00:00",
                "room": "Main",
                "track": "Web",
                "tags": ["smoke"],
                "speakers": ["ada"],
            }
        ],
    }


@pytest.fixture
def base(page) -> str:
    url = os.environ.get("CONFNOTE_E2E_BASE_URL")
    if not url:
        pytest.skip("CONFNOTE_E2E_BASE_URL is required")
    return url.rstrip("/")


def _requires_sign_in(page, base: str) -> bool:
    """A hosted target behind sign-in answers the notebook API 401 with a sign-in URL."""
    response = page.request.get(f"{base}/api/conferences")
    return response.status == 401 and "signInUrl" in response.text()


def test_web_target_signed_out_offers_sign_in(page, base):
    """Signed out, the notebook asks to sign in and offers Find events; nothing throws."""
    if not _requires_sign_in(page, base):
        pytest.skip(f"{base} is open without sign-in; the import test covers it")
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(f"{base}/#/")
    card = page.locator(".mine-start")
    card.get_by_text("Sign in to see your events").wait_for()
    assert card.get_by_role("link", name="Sign in").get_attribute("href") == "/api/auth/signin"
    assert page.locator(".product-account summary").inner_text() == "Sign in"
    card.get_by_role("link", name="Find events").click()
    page.wait_for_selector("#findEventsView")
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    assert not errors, errors


def test_web_target_import_edit_refresh(page, base):
    if _requires_sign_in(page, base):
        pytest.skip(
            f"{base} requires sign-in; this write test needs a signed-in test identity, "
            "which this suite does not hold. The signed-out test covers the target instead."
        )
    stamp = int(time.time())
    name = f"Web Smoke {stamp}"
    slug = f"2099-01-23-web-smoke-{stamp}"
    note = "0900-opening.md"
    text = f"web edit persisted {stamp}"

    response = page.request.post(f"{base}/api/conferences", data={"agenda": _agenda(name)})
    assert response.ok, response.text()

    page.goto(f"{base}/#/{slug}/{note}")
    page.wait_for_selector("#tabbar .tab")
    page.get_by_label("Concierge").click()
    page.wait_for_selector("#drawerHost.open")
    assert page.locator("#drawerTitle").inner_text().lower() == "concierge"
    chat_response = page.request.post(
        f"{base}/api/chat/global?slug={slug}",
        data={"messages": [{"role": "user", "text": "who is speaking?"}]},
    )
    assert chat_response.ok, chat_response.text()
    assert "Ada Lovelace" in chat_response.text()
    page.locator("#drawerClose").click()
    page.locator('#tabbar .tab[data-t="Human notes"]').click()
    page.wait_for_selector("#paneBody1 .EasyMDEContainer, #paneBody1 textarea", state="attached")
    page.evaluate(
        """(value) => {
          const body = document.querySelector("#paneBody1");
          const textarea = body.querySelector("textarea");
          const cmHost = body.querySelector(".CodeMirror");
          if (cmHost?.CodeMirror) {
            cmHost.CodeMirror.setValue(value);
            cmHost.CodeMirror.getInputField().dispatchEvent(new Event("blur"));
          } else {
            textarea.value = value;
            textarea.dispatchEvent(new Event("input", { bubbles: true }));
            textarea.dispatchEvent(new Event("blur"));
          }
        }""",
        text,
    )
    page.wait_for_selector("#status.saved")

    page.reload()
    page.wait_for_selector("#tabbar .tab")
    page.locator('#tabbar .tab[data-t="Human notes"]').click()
    page.wait_for_selector("#paneBody1 .EasyMDEContainer, #paneBody1 textarea", state="attached")
    value = page.evaluate(
        """() => {
          const body = document.querySelector("#paneBody1");
          const textarea = body.querySelector("textarea");
          const cmHost = body.querySelector(".CodeMirror");
          return cmHost?.CodeMirror ? cmHost.CodeMirror.getValue() : textarea.value;
        }"""
    )
    assert value == text

    page.locator("#theme").click()
    assert page.evaluate("() => document.documentElement.dataset.theme") == "light"
