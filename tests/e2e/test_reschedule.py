"""Drive absolute offsets through the UI and verify external changes refresh it."""

from playwright.sync_api import expect

SLUG = "2026-05-19-beyond-the-prompt"


def test_shift_restore_and_external_change_preserve_open_editor(app, confnote_server):
    original = app.request.get(confnote_server + f"/api/conference?slug={SLUG}").json()
    event = next(entry for entry in original["events"] if entry.get("note"))
    app.goto(confnote_server + f"/#/{SLUG}/{event['note']}")
    schedule = app.locator(".agenda-schedule")
    expect(schedule).to_be_visible()
    header = app.locator(".ehead .m")
    original_header = header.inner_text()
    # Identity preservation protects the current editor, focus, and pending edits.
    app.evaluate("window.scheduleTestEditor = document.getElementById('panes')")
    for offset in (30, 0, 30, 0):
        schedule.click()
        app.get_by_label("Minutes later than the published agenda").fill(str(offset))
        app.get_by_role("button", name="Apply schedule").click()
        expect(app.locator("#scheduleModal")).to_have_count(0)
        expect(schedule).to_contain_text("+30m" if offset else "published times")
        if offset:
            expect(header).not_to_have_text(original_header)
        else:
            expect(header).to_have_text(original_header)
        assert app.evaluate("window.scheduleTestEditor === document.getElementById('panes')")
        current = app.request.get(confnote_server + f"/api/conference?slug={SLUG}").json()
        assert [entry.get("note") for entry in current["events"]] == [
            entry.get("note") for entry in original["events"]
        ]
    # Same endpoint as the concierge, but independent of the currently open UI.
    current = app.request.get(confnote_server + f"/api/conference?slug={SLUG}").json()
    response = app.request.post(
        confnote_server + "/api/conference/schedule",
        headers={"Origin": str(confnote_server), "X-Confnote-Request": "1"},
        data={
            "slug": SLUG,
            "offset_minutes": 30,
            "expected_offset": 0,
            "expected_revision": current["schedule_revision"],
        },
    )
    assert response.status == 200
    expect(schedule).to_contain_text("+30m", timeout=10000)
    expect(header).not_to_have_text(original_header)
    assert app.evaluate("window.scheduleTestEditor === document.getElementById('panes')")
    app.screenshot(path="/tmp/confnote-schedule-forward.png")
    response = app.request.post(
        confnote_server + "/api/conference/schedule",
        headers={"Origin": str(confnote_server), "X-Confnote-Request": "1"},
        data={"slug": SLUG, "offset_minutes": 0, "expected_offset": 30},
    )
    assert response.status == 200
    expect(schedule).to_contain_text("published times", timeout=10000)
    expect(header).to_have_text(original_header)
