"""Home-screen conference creation.

Conference adds now route through the Concierge: both home CTAs ("New
conference" + the empty-state "Create one") open the chat drawer. The manual
modal is kept in code (re-surfaceable) but unlinked from any visible button, so
these tests open it directly via openNewConferenceModal(). The fixture vault is
temporary; the user's real vault is untouched.
"""


def test_new_conf_button_opens_concierge_not_modal(app):
    app.goto(app.url.split("#")[0] + "#/")
    app.wait_for_selector(".new-conf-btn")
    app.locator(".new-conf-btn").click()
    # Opens the Concierge drawer (its context strip mounts), NOT the manual modal.
    app.wait_for_selector(".chat-ctx-strip", timeout=3000)
    assert app.locator("#newConfModal").count() == 0


def test_new_conference_modal_validates_and_creates(app):
    app.goto(app.url.split("#")[0] + "#/")
    # Manual path is unlinked from the UI but still callable.
    app.evaluate("() => openNewConferenceModal()")
    app.wait_for_selector("#newConfModal")

    app.locator("#ncName").fill("Playwright Conf")
    app.locator("#ncDate").fill("2026-05-18")
    app.locator("#ncVenue").fill("Browser Hall")
    app.locator("#ncSessionTitle").fill("Opening Automation")
    app.locator("#ncStart").fill("09:15")
    app.locator("#ncEnd").fill("10:00")
    app.locator("#ncRefreshJson").click()

    app.locator("#ncValidate").click()
    app.wait_for_selector(".new-conf-result.ok")
    assert "2026-05-18-playwright-conf" in app.locator("#ncResult").inner_text()

    app.locator("#ncCreate").click()
    app.wait_for_url("**/#/2026-05-18-playwright-conf")
    app.wait_for_selector(".rail")
    assert "Playwright Conf" in app.locator("#crumbs").inner_text()
    assert app.locator(".rl-row", has_text="Opening Automation").count() == 1


def test_new_conference_modal_reports_invalid_manifest(app):
    app.goto(app.url.split("#")[0] + "#/")
    app.evaluate("() => openNewConferenceModal()")
    app.wait_for_selector("#newConfModal")
    app.locator("#ncJson").fill(
        '{"schema_version":"confnote.agenda.v1","conference":{"name":"Bad"}}'
    )

    app.locator("#ncValidate").click()
    app.wait_for_selector(".new-conf-result.bad")
    assert "conference.date is required" in app.locator("#ncResult").inner_text()
