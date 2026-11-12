"""The Transcript tab's record / drop-audio toolbar.

We only assert the toolbar renders + wires up; we never click Record (that
would activate the machine's microphone). Provider availability is
environment-dependent (Local AI Cat may or may not be running), so we don't
assert on the ready/unavailable state — just that controls exist and a
status is reported.
"""

from __future__ import annotations

_KEYNOTE = "2026-05-19-beyond-the-prompt/0940-opening-keynote.md"


def _open_transcript_tab(page):
    page.evaluate(f"() => {{ location.hash = '#/{_KEYNOTE}'; }}")
    page.wait_for_selector("#tabbar .tab")
    page.locator('#tabbar [data-t="Transcript"]').click()
    page.wait_for_selector(".transcribe-bar", timeout=3000)


def test_transcript_tab_shows_toolbar(app):
    _open_transcript_tab(app)
    assert app.locator(".transcribe-bar .tx-rec").count() == 1
    assert app.locator(".transcribe-bar .tx-file").count() == 1
    # an audio file picker is present and constrained to audio
    accept = app.evaluate("() => document.querySelector('.transcribe-bar .tx-input')?.accept")
    assert accept == "audio/*"
    # the native picker stays hidden behind the "Audio file" button (no stray "Choose File")
    assert not app.locator(".transcribe-bar .tx-input").is_visible()


def test_transcript_toolbar_reports_status(app):
    _open_transcript_tab(app)
    # status text resolves to *something* once /api/transcription/status returns
    app.wait_for_function(
        "() => (document.querySelector('.transcribe-bar .tx-status')?.textContent || '').length > 0",
        timeout=4000,
    )


_FAKE_MIC = """() => {
  const stream = { getTracks: () => [{ stop() {} }] };
  navigator.mediaDevices.getUserMedia = async () => stream;
  window.MediaRecorder = class {
    constructor() { this.state = "inactive"; this.mimeType = "audio/mp4"; }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      this.ondataavailable({ data: new Blob(["fake-audio"], { type: "audio/mp4" }) });
      this.onstop();
    }
  };
}"""


def test_recording_survives_leaving_the_tab(app):
    """Leaving the Transcript tab mid-recording must not drop the take."""
    page = app
    uploads = []
    page.route(
        "**/api/transcription/status",
        lambda route: route.fulfill(json={"available": True, "provider": "test"}),
    )

    def capture_upload(route):
        uploads.append(route.request.url)
        route.fulfill(json={"text": "hello"})

    page.route("**/api/transcription/file?*", capture_upload)
    page.evaluate(_FAKE_MIC)
    _open_transcript_tab(page)
    rec = page.locator(".transcribe-bar .tx-rec")
    page.wait_for_function("() => !document.querySelector('.transcribe-bar .tx-rec').disabled")
    rec.click()
    page.wait_for_function("() => document.querySelector('.tx-rec').textContent.includes('Stop')")

    page.locator('#tabbar [data-t="Human notes"]').click()
    page.wait_for_selector(".transcribe-bar", state="detached", timeout=3000)
    page.locator('#tabbar [data-t="Transcript"]').click()
    page.wait_for_function(
        "() => (document.querySelector('.tx-rec')?.textContent || '').includes('Stop')",
        timeout=3000,
    )

    page.locator(".transcribe-bar .tx-rec").click()
    page.wait_for_function(
        "() => document.querySelector('.tx-rec').textContent.includes('Record')", timeout=3000
    )
    for _ in range(20):
        if uploads:
            break
        page.wait_for_timeout(100)
    assert len(uploads) == 1
    assert "0940-opening-keynote.md" in uploads[0]


def test_other_tabs_have_no_transcribe_bar(app):
    page = app
    page.evaluate(f"() => {{ location.hash = '#/{_KEYNOTE}'; }}")
    page.wait_for_selector("#tabbar .tab")
    page.locator('#tabbar [data-t="Human notes"]').click()
    page.wait_for_selector(".mde-pane", timeout=3000)
    assert page.locator(".transcribe-bar").count() == 0
