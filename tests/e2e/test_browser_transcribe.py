"""Hosted transcription is locked (musa, 2026-11-11).

Conferences may not like recording and transcription, so on the hosted site the
Transcript tab stays visible but locked: no Record, no Audio file, no
transcription call of any kind (not to Local AI Cat, not to OpenAI with the
tab's own key). An info button opens a popover saying transcription runs on
device in the confnote Mac app with Local AI Cat, so audio stays on the Mac; on
the web it isn't available yet; mind each conference's recording rules. A
transcript can be pasted by hand and lands in the note's `## Transcript`
through the note API.

The page is marked as the hosted site (`webMode`) and /api/settings and
/api/transcription/status answer what packages/web-app/api/index.ts answers
(the vitest in web-app/test pins it there). Every test asserts that nothing went
to confnote's own /api/transcription/*, to a loopback Local AI Cat, or to
api.openai.com. The Mac app's recording toolbar is covered by
test_transcribe_tab.py and is unchanged.
"""

from __future__ import annotations

import json
import urllib.request

import pytest

SLUG = "2026-05-19-beyond-the-prompt"
SEEDED = "Earlier take, typed by hand."
PASTED = "Speaker: Determinism beats slop when the agent can check its own work.\nQ: How?"
FIXTURE_KEY = "sk-fixture-browser-transcribe"  # pragma: allowlist secret
LOCAL_AI_CAT_URL = "https://localaicat.com"
INFO_ON_DEVICE = "Transcription runs on device in the confnote Mac app with Local AI Cat"
INFO_WEB = "On the web it isn't available yet."
INFO_RULES = "Please be mindful of each conference's recording rules."

# What packages/web-app/api/index.ts answers.
HOSTED_SETTINGS = {
    "transcription": {
        "browser": True,
        "locked": True,
        "provider": "none",
        "model": "",
        "has_api_key": False,
    },
    "web": True,
}
HOSTED_STATUS = {
    "browser": True,
    "locked": True,
    "provider": "none",
    "available": False,
    "can_record": False,
    "detail": "Transcription is locked on the web; it runs on device in the confnote Mac app.",
}


def _note_file(vault) -> str:
    return next((vault / SLUG / "notes").glob("1010-*.md")).name


def _seed_transcript(server, note: str, text: str) -> None:
    req = urllib.request.Request(
        f"{server.url}/api/note?slug={SLUG}&file={note}",
        data=json.dumps({"sections": {"Transcript": text}}).encode(),
        headers={"Content-Type": "application/json", "Origin": server.url},
        method="PUT",
    )
    with urllib.request.urlopen(req, timeout=5) as r:
        assert r.status == 200


def _transcript_on_disk(server, note: str) -> str:
    text = (server.vault / SLUG / "notes" / note).read_text()
    return text.split("## Transcript", 1)[1].split("\n## ", 1)[0].strip()


def _sign_in_routes(page) -> None:
    """A signed-in hosted account, so product-shell shows Profile → Your AI key."""
    page.route(
        "**/api/me",
        lambda route: route.fulfill(
            json={
                "userId": "u1",
                "email": "fixture@example.test",
                "workspaceId": "w1",
                "entitlements": {"plan": "free"},
            }
        ),
    )
    page.route(
        "**/api/workspaces", lambda route: route.fulfill(json=[{"id": "w1", "name": "Mine"}])
    )
    page.route(
        "**/api/wallet",
        lambda route: route.fulfill(json={"balance": 0, "reserved": 0, "available": 0}),
    )


@pytest.fixture
def hosted(confnote_server, page):
    """The page as the hosted site, on a note whose Transcript already has a take."""
    note = _note_file(confnote_server.vault)
    _seed_transcript(confnote_server, note, SEEDED)
    forbidden = []

    def watch(request) -> None:
        url = request.url
        if "/api/transcription/file" in url or "/api/transcription/record" in url:
            forbidden.append(url)
        if url.startswith(("http://127.0.0.1:11434", "http://localhost:11434")):
            forbidden.append(url)
        if url.startswith("https://api.openai.com"):
            forbidden.append(url)

    page.on("request", watch)
    page.route("**/api/settings", lambda route: route.fulfill(json=HOSTED_SETTINGS))
    page.route("**/api/transcription/status", lambda route: route.fulfill(json=HOSTED_STATUS))
    page.set_viewport_size({"width": 1400, "height": 900})

    def open_note():
        page.add_init_script(
            "window.confnote = Object.assign(window.confnote || {}, { webMode: true });"
        )
        page.goto(f"{confnote_server.url}/#/{SLUG}/{note}")
        page.wait_for_selector("#tabbar .tab")
        page.locator('#tabbar [data-t="Transcript"]').click()
        page.wait_for_selector(".transcribe-bar.tx-locked")
        return page

    yield {"open": open_note, "note": note, "server": confnote_server}
    assert forbidden == [], "the hosted page must not record, upload or transcribe"


def test_the_hosted_transcript_tab_is_locked_with_an_info_popover(hosted, confnote_server):
    page = hosted["open"]()
    tab = page.locator('#tabbar [data-t="Transcript"]')
    assert tab.is_visible()
    assert tab.locator(".lock").count() == 1

    bar = page.locator(".transcribe-bar.tx-locked")
    assert "Transcription is locked on the web" in bar.inner_text()
    # No recording, no audio file, no editor: nothing here records or transcribes.
    assert page.locator(".tx-rec").count() == 0
    assert page.locator(".tx-file, .tx-input").count() == 0
    assert page.locator(".tx-locked-pane .EasyMDEContainer").count() == 0
    # The existing transcript still reads, as a preview.
    assert SEEDED in page.locator(".tx-locked-body").inner_text()

    info = bar.locator("button.tx-info")
    pop = page.locator(".tx-info-pop")
    assert info.get_attribute("aria-expanded") == "false"
    assert not pop.is_visible()
    info.click()
    assert pop.is_visible()
    assert info.get_attribute("aria-expanded") == "true"
    text = pop.inner_text()
    assert INFO_ON_DEVICE in text
    assert "so audio stays on your Mac" in text
    assert INFO_WEB in text
    assert INFO_RULES in text
    link = pop.locator("a")
    assert link.get_attribute("href") == LOCAL_AI_CAT_URL
    assert link.inner_text() == "localaicat.com"
    assert link.get_attribute("target") == "_blank"

    # Escape closes it; the button opens it again; a click elsewhere closes it.
    page.keyboard.press("Escape")
    assert not pop.is_visible()
    info.click()
    assert pop.is_visible()
    page.locator(".tx-lock-label").click()
    assert not pop.is_visible()

    # Nothing was written.
    assert _transcript_on_disk(confnote_server, hosted["note"]) == SEEDED


def test_paste_a_transcript_saves_it_into_the_note(hosted, confnote_server):
    page = hosted["open"]()
    page.get_by_role("button", name="Paste a transcript").click()
    box = page.locator(".tx-paste-input")
    assert box.is_visible()

    # Saving nothing says so and writes nothing.
    page.get_by_role("button", name="Save to transcript").click()
    page.wait_for_function(
        "() => (document.querySelector('.tx-locked .tx-status')?.textContent || '').includes('paste')"
    )
    assert _transcript_on_disk(confnote_server, hosted["note"]) == SEEDED

    box.fill(PASTED)
    page.get_by_role("button", name="Save to transcript").click()
    page.wait_for_function(
        "() => (document.querySelector('.tx-locked .tx-status')?.textContent || '').includes('added')"
    )
    # Appended after the earlier take, as the Mac's append_transcript does.
    assert _transcript_on_disk(confnote_server, hosted["note"]) == f"{SEEDED}\n\n{PASTED}"
    assert not box.is_visible()
    shown = page.locator(".tx-locked-body").inner_text()
    assert SEEDED in shown
    assert "Determinism beats slop" in shown

    # It survives a reload, and the tab is still locked.
    page.reload()
    page.wait_for_selector("#tabbar .tab")
    page.locator('#tabbar [data-t="Transcript"]').click()
    page.wait_for_selector(".transcribe-bar.tx-locked")
    assert "Determinism beats slop" in page.locator(".tx-locked-body").inner_text()


def test_a_tab_key_does_not_unlock_transcription(hosted, page):
    """Profile → Your AI key serves the Concierge only; it never turns transcription on."""
    _sign_in_routes(page)
    hosted["open"]()
    page.locator("#profileMenu summary").click()
    form = page.locator("#byok-form")
    form.locator("select[name=provider]").select_option("openai")
    form.locator("input[name=model]").fill("gpt-fixture")
    form.locator("input[name=key]").fill(FIXTURE_KEY)
    form.get_by_role("button", name="Use my key for this tab").click()
    page.locator("#profileMenu summary").click()

    page.locator('#tabbar [data-t="Human notes"]').click()
    page.locator('#tabbar [data-t="Transcript"]').click()
    page.wait_for_selector(".transcribe-bar.tx-locked")
    assert page.locator(".tx-rec, .tx-file").count() == 0
    hooks = page.evaluate(
        "() => [typeof window.confnote.byokTranscription, typeof window.confnote.byokOpenAIFetch,"
        " typeof window.confnote.browserTranscription.transcribe]"
    )
    assert hooks == ["undefined", "undefined", "undefined"]


def test_hosted_settings_show_the_lock_and_offer_no_transcription_setup(hosted, page):
    settings_writes = []
    page.on(
        "request",
        lambda request: (
            settings_writes.append(request.url)
            if request.method == "POST" and "/api/settings" in request.url
            else None
        ),
    )
    hosted["open"]()
    page.locator("#settingsBtn").click()
    modal = page.locator("#settingsModal")
    modal.wait_for()
    note = modal.locator("#setOnDevice")
    note.wait_for(state="visible")
    assert INFO_ON_DEVICE in note.inner_text()
    assert INFO_RULES in note.inner_text()
    assert note.locator("a").get_attribute("href") == LOCAL_AI_CAT_URL
    assert "locked on the web" in modal.locator(".set-blurb").first.inner_text()
    # No provider choice, base URL, model, key, block recorder or connection test.
    assert not modal.locator("input[value=local]").is_visible()
    assert not modal.locator("input[value=openai]").is_visible()
    assert not modal.locator(".set-row", has_text="Base URL").is_visible()
    assert not modal.locator(".set-row", has_text="Model").is_visible()
    assert not modal.locator(".set-row", has_text="API key").is_visible()
    assert not modal.locator("#setAutoRecord").is_visible()
    assert not modal.get_by_text("Save in Local AI Cat history").is_visible()
    assert not modal.get_by_role("button", name="Test connection").is_visible()

    # Save / Done just closes: nothing to store.
    modal.locator(".set-foot .set-btn-primary").click()
    modal.wait_for(state="detached")
    assert settings_writes == [], "hosted settings write nothing"
