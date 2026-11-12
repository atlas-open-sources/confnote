"""Day goals persist in markdown without an AI request or lost brief edits."""

from playwright.sync_api import expect

CONF = "2026-05-19-beyond-the-prompt"


def test_save_day_goals_appends_existing_brief(app, confnote_server):
    brief = confnote_server.vault / CONF / "BRIEF.md"
    brief.write_text("# Existing plan\n\nKeep this paragraph.\n")
    chat_requests = []
    app.on(
        "request",
        lambda req: (
            chat_requests.append(req.url)
            if "/api/chat" in req.url and req.method == "POST"
            else None
        ),
    )
    app.evaluate(f"location.hash = '#/{CONF}'")
    app.locator("#daySetupBtn").click()
    app.locator('[name="goals"]').fill("Build my first agent")
    app.locator('[name="interests"]').fill("Open source and OAuth")
    app.locator('[name="outcome"]').fill("One working demo")
    app.get_by_role("button", name="Save my day goals").click()
    expect(app.locator(".day-setup")).to_have_count(0)
    text = brief.read_text()
    assert "Keep this paragraph." in text
    assert "Build my first agent" in text
    assert "Open source and OAuth" in text
    assert "One working demo" in text
    assert not chat_requests


def test_skip_does_not_write_and_concurrent_edit_is_preserved(app, confnote_server):
    brief = confnote_server.vault / CONF / "BRIEF.md"
    brief.write_text("Original brief\n")
    app.evaluate(f"location.hash = '#/{CONF}'")
    app.locator("#daySetupBtn").click()
    app.get_by_role("button", name="Maybe later").click()
    assert brief.read_text() == "Original brief\n"
    app.locator("#daySetupBtn").click()
    app.locator('[name="goals"]').fill("A new goal")
    brief.write_text("Edited in another window\n")
    app.get_by_role("button", name="Save my day goals").click()
    expect(app.locator(".day-setup-error")).to_contain_text("changed elsewhere")
    assert brief.read_text() == "Edited in another window\n"


def test_day_goals_lives_in_the_conference_sidebar_not_the_top_bar(app):
    """Day goals act on one conference, so the button sits with Brief / Actions / Debrief."""
    expect(app.locator("#daySetupBtn")).to_have_count(0)  # home: no conference, no button
    app.evaluate(f"location.hash = '#/{CONF}'")
    button = app.locator("#sidebar .agenda-acts").get_by_role("button", name="Day goals")
    expect(button).to_be_visible()
    expect(app.locator("#rightctl #daySetupBtn")).to_have_count(0)
    expect(app.get_by_role("button", name="Plan my day")).to_have_count(0)
    button.click()
    expect(app.locator(".day-setup")).to_contain_text("Beyond The Prompt")
    app.get_by_role("button", name="Maybe later").click()
    expect(app.locator(".day-setup")).to_have_count(0)
