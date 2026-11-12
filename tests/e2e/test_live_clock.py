"""The agenda follows time without navigation, including after app wake."""

from playwright.sync_api import expect


def test_agenda_actions_fit_default_and_minimum_sidebar(app):
    app.locator(".sb-conf").first.click()
    app.wait_for_selector(".agenda-acts .agenda-actions")
    for width in (280, 200):
        app.evaluate(
            "width => document.documentElement.style.setProperty('--sidebar-w', `${width}px`)",
            width,
        )
        app.locator(".agenda-actions .td-n").evaluate("element => element.textContent = '12'")
        overflow = app.locator(
            ".agenda-acts .brief-btn:not(.agenda-schedule), .agenda-acts .debrief-btn"
        ).evaluate_all(
            "elements => elements.map(element => element.scrollWidth > element.clientWidth)"
        )
        # Brief, Actions, Debrief, plus Day goals in the app (not in the public demo).
        assert len(overflow) >= 3, "agenda action buttons missing"
        assert not any(overflow), f"buttons overflow at sidebar width {width}: {overflow}"


def test_live_talk_overrides_lunch_and_refreshes_after_focus(app, confnote_server):
    payload = app.request.get(
        confnote_server + "/api/conference?slug=2026-05-19-beyond-the-prompt"
    ).json()
    template = next(event for event in payload["events"] if event.get("note"))
    payload["events"] = [
        {
            **template,
            "id": "lunch",
            "type": "break",
            "title": "Lunch",
            "start": "2026-09-29T11:30:00-07:00",
            "end": "2026-09-29T13:00:00-07:00",
        },
        {
            **template,
            "id": "morning",
            "title": "Morning talk",
            "start": "2026-09-29T12:00:00-07:00",
            "end": "2026-09-29T12:40:00-07:00",
        },
        {
            **template,
            "id": "afternoon",
            "title": "Afternoon talk",
            "start": "2026-09-29T12:45:00-07:00",
            "end": "2026-09-29T13:25:00-07:00",
        },
    ]
    app.route("**/api/conference?*", lambda route: route.fulfill(json=payload))
    app.route("**/api/conf-doc?*", lambda route: route.fulfill(json={"status": ""}))
    app.add_init_script(
        "Date.now = () => window.testNow || Date.parse('2026-09-29T12:15:00-07:00')"
    )
    app.goto(confnote_server + "/#/2026-05-19-beyond-the-prompt")
    app.reload()
    jump = app.locator(".agenda-acts .jump")
    expect(jump).to_contain_text("Morning talk")
    app.evaluate(
        "window.testNow = Date.parse('2026-09-29T12:50:00-07:00'); window.dispatchEvent(new Event('focus'))"
    )
    expect(jump).to_contain_text("Afternoon talk")
    expect(app.locator("#railStatus")).to_contain_text("Afternoon talk")
    expect(app.locator(".rl-row.live")).to_have_count(2)
    app.screenshot(path="/tmp/confnote-live-clock.png")
    app.evaluate(
        "window.testNow = Date.parse('2026-09-29T13:25:00-07:00'); window.dispatchEvent(new Event('focus'))"
    )
    expect(jump).to_be_hidden()
    expect(app.locator(".rl-row.live")).to_have_count(0)
