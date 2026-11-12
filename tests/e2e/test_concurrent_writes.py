"""Saving a note must not overwrite sections another writer changed on disk.

An agent, the importer or Local AI Cat transcription can append to a session
note's `## Transcript` while the note is open. The autosave used to send every
editable section from the client's in-memory copy, so typing in Human notes
wrote the stale (empty) Transcript back over the new one.
"""

from __future__ import annotations

_SLUG = "2026-05-19-beyond-the-prompt"
_DISK_TRANSCRIPT = "Speaker: transcript written on disk by another writer."
_EMPTY_TRANSCRIPT = "## Transcript\n\n"


def _note_path(server, pattern):
    matches = sorted((server.vault / _SLUG / "notes").glob(pattern))
    if not matches:
        matches = sorted((server.vault / _SLUG).glob(pattern))
    assert matches, f"no seeded note matches {pattern}"
    return matches[0]


def _write_transcript_on_disk(path, text):
    """Mimic `append_transcript`: another process rewrites the note file."""
    src = path.read_text()
    assert _EMPTY_TRANSCRIPT in src, "seed note should start with an empty Transcript"
    path.write_text(src.replace(_EMPTY_TRANSCRIPT, f"## Transcript\n\n{text}\n\n", 1))


def _open_note(page, path):
    page.evaluate(f"() => {{ location.hash = '#/{_SLUG}/{path.name}'; }}")
    page.wait_for_selector('#tabbar [data-t="Human notes"]')
    page.wait_for_selector("#paneBody1 .CodeMirror")


def _type_into_pane(page, text):
    page.locator("#paneBody1 .CodeMirror").click()
    page.keyboard.type(text)


def _wait_for_disk(page, path, needle):
    for _ in range(50):
        if needle in path.read_text():
            return
        page.wait_for_timeout(100)
    raise AssertionError(f"{needle!r} never reached {path.name}:\n{path.read_text()}")


def test_human_notes_save_keeps_transcript_written_on_disk(app, confnote_server):
    path = _note_path(confnote_server, "*goodbye*.md")
    _open_note(app, path)
    _write_transcript_on_disk(path, _DISK_TRANSCRIPT)

    _type_into_pane(app, "typed while the transcript landed")
    _wait_for_disk(app, path, "typed while the transcript landed")

    assert _DISK_TRANSCRIPT in path.read_text()
    # our own save must not hide the other writer's change from the poll
    app.wait_for_function(
        f"() => (S.note?.sections?.Transcript || '').includes({_DISK_TRANSCRIPT!r})",
        timeout=8000,
    )


def test_poll_refreshes_transcript_so_editing_it_keeps_disk_text(app, confnote_server):
    path = _note_path(confnote_server, "*codebase-design*.md")
    _open_note(app, path)
    _write_transcript_on_disk(path, _DISK_TRANSCRIPT)

    # the 5 s note poll adopts the newer Transcript (nothing edits it here)
    app.wait_for_function(
        f"() => (S.note?.sections?.Transcript || '').includes({_DISK_TRANSCRIPT!r})",
        timeout=8000,
    )
    app.locator('#tabbar [data-t="Transcript"]').click()
    app.wait_for_selector("#paneBody1 .transcribe-bar")
    assert _DISK_TRANSCRIPT in app.locator("#paneBody1 .CodeMirror").inner_text()

    app.locator("#paneBody1 .CodeMirror").click()
    app.keyboard.press("Control+End")
    app.keyboard.press("Meta+ArrowDown")
    app.keyboard.type(" Follow-up typed in the app.")
    _wait_for_disk(app, path, "Follow-up typed in the app.")

    assert _DISK_TRANSCRIPT in path.read_text()
