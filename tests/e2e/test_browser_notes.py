"""Browser notes end to end: write a note on the public demo, reload, download
the .confnote, import it into the Mac app's (empty) vault, find the .md on disk.

The page runs as the public demo (`window.confnote.publicDemo`) against the
local server. The web API's GET /api/export is stood in by a route that bundles
the seeded vault the same way lib/vault-transfer.ts exportConference does
(that function has its own vitest).
"""

from __future__ import annotations

import json

SLUG = "2026-05-19-beyond-the-prompt"
NOTE = "0940-opening-keynote.md"
TEXT = "browser note survives the trip to disk"
CONF_DOCS = ("agenda.json", "README.md", "speakers.md", "BRIEF.md", "DEBRIEF.md", "INBOX.md")


def _export_bundle(vault) -> dict:
    root = vault / SLUG
    files = {
        f"{SLUG}/{name}": (root / name).read_text() for name in CONF_DOCS if (root / name).is_file()
    }
    for note in sorted((root / "notes").glob("*.md")):
        files[f"{SLUG}/notes/{note.name}"] = note.read_text()
    return {"schema_version": "confnote.vault.v1", "files": files}


def test_browser_note_downloads_and_imports_as_markdown(
    confnote_server, empty_server, page, tmp_path
):
    bundle = _export_bundle(confnote_server.vault)
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.add_init_script("window.confnote = { webMode: true, publicDemo: true };")
    page.route(
        f"**/api/export?slug={SLUG}",
        lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps(bundle)
        ),
    )
    page.set_viewport_size({"width": 1400, "height": 900})
    page.goto(f"{confnote_server.url}/#/{SLUG}/{NOTE}")
    page.wait_for_selector("#paneBody1 .CodeMirror")
    page.evaluate(
        """(text) => {
          const cm = document.querySelector("#paneBody1 .CodeMirror").CodeMirror;
          cm.setValue(text);
        }""",
        TEXT,
    )
    page.wait_for_function("document.getElementById('status').textContent.includes('this browser')")
    banner = page.locator("#browserNotesBanner")
    banner.wait_for()
    assert "1 note in this browser" in banner.inner_text()
    assert "Clearing site data deletes them" in banner.inner_text()

    page.reload()
    page.wait_for_selector("#paneBody1 .CodeMirror")
    value = page.evaluate("document.querySelector('#paneBody1 .CodeMirror').CodeMirror.getValue()")
    assert value == TEXT

    with page.expect_download() as info:
        banner.get_by_role("button", name="Download notes").click()
    download = info.value
    assert download.suggested_filename == f"{SLUG}.confnote"
    saved = tmp_path / download.suggested_filename
    download.save_as(saved)
    assert json.loads(saved.read_text())["schema_version"] == "confnote.vault.v1"

    # The Mac app (empty vault): Import notes → pick the file → the .md lands on disk.
    app = page.context.new_page()
    app.goto(f"{empty_server.url}/#/")
    with app.expect_file_chooser() as chooser:
        app.locator(".import-conf-btn").click()
    chooser.value.set_files(str(saved))
    app.wait_for_function(f"location.hash === '#/{SLUG}'")
    written = (empty_server.vault / SLUG / "notes" / NOTE).read_text()
    assert f"## Human notes\n\n{TEXT}\n" in written
    assert (empty_server.vault / SLUG / "agenda.json").is_file()
    assert not errors
