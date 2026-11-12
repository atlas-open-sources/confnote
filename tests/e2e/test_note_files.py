"""A recording beside a note (notes/assets/<talk>/) is reachable from the note.

Two ways in: the Links & Files tab lists the file, and an `assets/…` markdown
link in a section opens it through /assets. Both must serve the audio with an
audio content type; a bare relative href used to 404 against the page.
"""

from __future__ import annotations

CONF = "2026-05-19-beyond-the-prompt"
STEM = "1110-codebase-design"
CLIP = "recording-main-stage.m4a"
REL = f"assets/{STEM}/{CLIP}"


def _seed(confnote_server):
    notes = confnote_server.vault / CONF / "notes"
    adir = notes / "assets" / STEM
    adir.mkdir(parents=True, exist_ok=True)
    (adir / CLIP).write_bytes(b"\x00\x00\x00\x18ftypM4A ")
    note = notes / f"{STEM}.md"
    text = note.read_text()
    if REL in text:
        return
    marker = "## AI notes\n"
    assert marker in text
    note.write_text(text.replace(marker, f"{marker}\n- Audio: [{CLIP}]({REL})\n", 1))


def _open(app, tab):
    app.evaluate(f"() => {{ location.hash = '#/{CONF}/{STEM}.md'; }}")
    app.wait_for_selector("#tabbar .tab")
    app.locator(f'#tabbar .tab[data-t="{tab}"]').click()


def _content_type(app, href):
    return app.evaluate(
        "async (u) => { const r = await fetch(u); return r.ok ? r.headers.get('content-type') : String(r.status); }",
        href,
    )


def test_recording_is_listed_and_playable_from_links_and_files(app, confnote_server):
    _seed(confnote_server)
    _open(app, "Links & Files")
    link = app.locator(f'.lf-files .gcell a[href*="{CLIP}"]')
    link.wait_for(timeout=3000)
    href = link.get_attribute("href")
    assert href.startswith(f"/assets?slug={CONF}&path=")
    assert _content_type(app, href) == "audio/mp4"


def test_files_link_button_writes_a_working_link_into_human_notes(app, confnote_server):
    _seed(confnote_server)
    _open(app, "Links & Files")
    button = app.locator(f'.lf-files .gcell button.gins[data-rel="{REL}"]')
    button.wait_for(timeout=3000)
    button.click()
    app.wait_for_function(
        "() => document.querySelector('#tabbar .tab.on1')?.dataset.t === 'Human notes'",
        timeout=3000,
    )
    path = confnote_server.vault / CONF / "notes" / f"{STEM}.md"
    for _ in range(50):
        human = path.read_text().split("## Human notes", 1)[1].split("\n## ", 1)[0]
        if f"[{CLIP}]({REL})" in human:
            break
        app.wait_for_timeout(100)
    assert f"[{CLIP}]({REL})" in human


def test_assets_link_in_a_section_opens_through_assets(app, confnote_server):
    _seed(confnote_server)
    _open(app, "AI notes")
    link = app.locator(f'#paneBody1 .md a:has-text("{CLIP}")')
    link.wait_for(timeout=3000)
    href = link.get_attribute("href")
    assert href.startswith(f"/assets?slug={CONF}&path=")
    assert _content_type(app, href) == "audio/mp4"
