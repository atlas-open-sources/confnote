"""Playwright e2e for the ⚙ Settings modal.

Covers: cog opens the modal, fields hydrate from /api/settings, provider
radios swap the Base URL field, Save round-trips, the API key never comes
back to the browser, and "Open in browser" is hidden outside the .app.
"""

from __future__ import annotations


def _open_settings(page):
    page.evaluate("() => { location.hash = '#/'; }")
    page.wait_for_selector("#settingsBtn", timeout=4000)
    page.locator("#settingsBtn").click()
    page.wait_for_selector("#settingsModal", timeout=2000)


def test_cog_replaces_open_in_browser(app):
    _open_settings(app)
    # The old ↗ topbar button is gone; the cog is its replacement.
    assert app.locator("#settingsBtn").count() == 1
    assert app.locator("#openBtn").count() == 0


def test_settings_modal_opens_with_transcription_section(app):
    _open_settings(app)
    title = app.evaluate("() => document.querySelector('#settingsModal .modal-title').textContent")
    assert title == "Settings"
    body = app.locator("#settingsModal .modal-body").inner_text().lower()
    assert "transcription" in body
    assert "local" in body and "remote" in body


def test_settings_local_provider_makes_key_field_explicit(app):
    app.evaluate(
        """async () => {
          await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transcription: { provider: 'local', clear_api_key: true } }),
          });
        }"""
    )
    _open_settings(app)
    key_field = app.locator("#settingsModal input[type='password']")
    assert key_field.is_enabled() is False
    assert key_field.get_attribute("placeholder") == "No API key needed for Local AI Cat"
    body = app.locator("#settingsModal .modal-body").inner_text()
    assert "Local AI Cat runs on this Mac; no OpenAI key is used." in body
    assert app.locator("#settingsModal .set-btn-primary").inner_text() == "Done"


def test_provider_radio_swaps_base_url(app):
    _open_settings(app)
    # default provider = local → base url is the Cat loopback
    base = app.locator("#settingsModal .set-input").first
    app.wait_for_function(
        "() => document.querySelector('#settingsModal .set-input').value.includes('127.0.0.1')",
        timeout=2000,
    )
    # pick remote → base url field swaps to the OpenAI host
    app.locator("#settingsModal input[value='openai']").check()
    app.wait_for_function(
        "() => document.querySelector('#settingsModal .set-input').value.includes('openai.com')",
        timeout=2000,
    )
    assert "openai.com" in base.input_value()
    key_field = app.locator("#settingsModal input[type='password']")
    assert key_field.is_enabled() is True
    assert key_field.get_attribute("placeholder") in (
        "Paste OpenAI API key",
        "API key saved — leave blank to keep it",
    )
    assert app.locator("#settingsModal .set-btn-primary").inner_text() == "Save"


def test_open_in_browser_hidden_outside_desktop(app):
    # In a plain browser (no window.pywebview) the in-modal "Open in browser"
    # button must stay hidden.
    _open_settings(app)
    hidden = app.evaluate(
        """() => {
          const b = [...document.querySelectorAll('#settingsModal .set-btn')]
            .find(el => el.textContent.includes('Open in browser'));
          return !b || b.hidden;
        }"""
    )
    assert hidden


def test_save_persists_and_hides_key(app, confnote_server):
    _open_settings(app)
    # switch to remote, type a key, save
    app.locator("#settingsModal input[value='openai']").check()
    key_field = app.locator("#settingsModal input[type='password']")
    key_field.fill("sk-e2e-secret")
    app.locator("#settingsModal .set-btn-primary").click()

    # the Save button confirms success on itself ("✓ Saved")
    app.wait_for_function(
        "() => document.querySelector('#settingsModal .set-btn-primary')?.textContent.includes('Saved')",
        timeout=3000,
    )
    # after save the typed key is cleared from the DOM…
    app.wait_for_function(
        "() => document.querySelector(\"#settingsModal input[type='password']\").value === ''",
        timeout=3000,
    )
    # …and the server confirms a key is set without ever returning it
    payload = app.evaluate("async () => (await (await fetch('/api/settings')).json())")
    tr = payload["transcription"]
    assert tr["provider"] == "openai"
    assert tr["has_api_key"] is True
    assert "api_key" not in tr

    # and it's actually on disk in the server-side store
    raw = (confnote_server.vault / ".confnote" / "settings.json").read_text()
    assert "sk-e2e-secret" in raw


def test_settings_modal_closes_on_escape(app):
    _open_settings(app)
    app.keyboard.press("Escape")
    app.wait_for_function("() => !document.getElementById('settingsModal')", timeout=2000)
