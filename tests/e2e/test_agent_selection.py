"""Local provider controls use account models and native OAuth browser handoff."""

from playwright.sync_api import expect


def test_provider_selection_and_native_login(app):
    app.route(
        "**/api/chat/providers",
        lambda route: route.fulfill(
            json={
                "claude": {"available": True},
                "chatgpt": {"available": True, "signed_in": False, "pending": False},
            }
        ),
    )
    app.route(
        "**/api/chat/chatgpt/login",
        lambda route: route.fulfill(
            json={
                "auth_url": "https://auth.openai.com/api/accounts/authorize?state=test",
            }
        ),
    )
    app.evaluate("""() => {
        window.openedOAuth = [];
        window.pywebview = {api: {open_external: url => window.openedOAuth.push(url)}};
        location.hash = '#/2026-05-19-beyond-the-prompt';
    }""")
    app.locator(".drawer-tab[data-id='chat']").click()
    selector = app.get_by_label("Agent provider")
    expect(selector).to_be_visible()
    selector.select_option("chatgpt")
    app.get_by_role("button", name="Continue with ChatGPT").click()
    app.wait_for_function("window.openedOAuth.length === 1")
    assert app.evaluate("window.openedOAuth[0]").startswith("https://auth.openai.com/")
    query = app.evaluate("window.confnote.agentQuery(new URLSearchParams()).toString()")
    assert "provider=chatgpt" in query
    expect(app.locator(".chat-model")).to_be_hidden()
    selector.select_option("claude")
    expect(app.locator(".chat-model")).to_be_visible()


def test_signed_in_account_catalog_and_logout_warning(app):
    signed_in = [True]

    def status(route):
        route.fulfill(
            json={
                "claude": {"available": True},
                "chatgpt": {
                    "available": True,
                    "signed_in": signed_in[0],
                    "pending": False,
                },
            }
        )

    def logout(route):
        signed_in[0] = False
        route.fulfill(json={"ok": True, "warning": "Disconnect confnote in ChatGPT Settings."})

    app.route("**/api/chat/providers", status)
    app.route(
        "**/api/chat/chatgpt/models",
        lambda route: route.fulfill(
            json={
                "models": [{"slug": "account-model", "display_name": "Account model"}],
            }
        ),
    )
    app.route("**/api/chat/chatgpt/logout", logout)
    app.evaluate("location.hash = '#/2026-05-19-beyond-the-prompt'")
    app.locator(".drawer-tab[data-id='chat']").click()
    app.get_by_label("Agent provider").select_option("chatgpt")
    expect(app.get_by_label("ChatGPT model")).to_have_value("account-model")
    query = app.evaluate("window.confnote.agentQuery(new URLSearchParams()).toString()")
    assert "model=account-model" in query
    app.get_by_role("button", name="Sign out", exact=True).click()
    expect(app.locator(".agent-status")).to_have_text("Disconnect confnote in ChatGPT Settings.")
