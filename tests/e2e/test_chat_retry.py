"""Concierge error handling: auto-retry on transient overloads + a clickable
↻ Retry button when an error finally surfaces.

The agent SDK / `claude` CLI are never spawned — the POST to /api/chat/global
is intercepted and a canned NDJSON reply is returned, varying per call so we
can drive the retry paths deterministically.
"""

from __future__ import annotations


def _open_chat(page):
    page.evaluate("() => { location.hash = '#/2026-05-19-beyond-the-prompt'; }")
    page.wait_for_selector(".drawer-tab[data-id='chat']")
    page.locator(".drawer-tab[data-id='chat']").click()
    page.wait_for_selector(".chat-ctx-strip", timeout=3000)
    page.wait_for_function(
        "() => !!document.querySelector('.chat-inner deep-chat')?.shadowRoot",
        timeout=3000,
    )


def _send(page, text):
    page.evaluate(
        r"""(t) => {
          function find(root){ if(!root) return null;
            const d=root.querySelector("[contenteditable='true'],textarea,input[type='text']");
            if(d) return d;
            for(const el of [...root.querySelectorAll('*')]){ const f=find(el.shadowRoot); if(f) return f; }
            return null; }
          const dc=document.querySelector('.chat-inner deep-chat');
          const i=find(dc.shadowRoot); i && i.focus();
        }""",
        text,
    )
    page.keyboard.type(text)
    page.keyboard.press("Enter")


def _shadow_text(page):
    return page.evaluate(
        "() => document.querySelector('.chat-inner deep-chat')?.shadowRoot?.textContent || ''"
    )


def test_auto_retries_transient_overload_then_succeeds(app, chat_reset):
    _open_chat(app)
    calls = {"n": 0}

    def handle(route, request):
        calls["n"] += 1
        if calls["n"] == 1:
            # first attempt: a 529-style overloaded error in the stream
            body = '{"error":"API Error: 529 overloaded_error"}\n{"done":true}\n'
        else:
            body = '{"text":"here you go"}\n{"done":true}\n'
        route.fulfill(status=200, content_type="application/x-ndjson", body=body)

    app.route("**/api/chat/global*", handle)
    _send(app, "hello")

    # auto-retry kicks in (backoff ~700ms) and the second attempt succeeds
    app.wait_for_function(
        "() => document.querySelector('.chat-inner deep-chat')?.shadowRoot?.textContent?.includes('here you go')",
        timeout=6000,
    )
    assert calls["n"] >= 2
    assert "Retry" not in _shadow_text(app)  # no error surfaced


def test_persistent_error_shows_clickable_retry_that_resends(app, chat_reset):
    _open_chat(app)
    calls = {"n": 0}

    def handle(route, request):
        calls["n"] += 1
        # call 1 (initial send): a NON-transient error → no auto-retry, button.
        # call 2 (the manual retry click): succeeds.
        if calls["n"] >= 2:
            body = '{"text":"recovered"}\n{"done":true}\n'
        else:
            body = '{"error":"Unknown conference."}\n{"done":true}\n'
        route.fulfill(status=200, content_type="application/x-ndjson", body=body)

    app.route("**/api/chat/global*", handle)
    _send(app, "hello")

    # a non-transient error is not auto-retried → the retry button appears
    app.wait_for_function(
        "() => !!document.querySelector('.chat-inner deep-chat')?.shadowRoot?.querySelector('.cn-retry')",
        timeout=4000,
    )
    first_calls = calls["n"]
    assert first_calls == 1  # not auto-retried

    # clicking ↻ Retry re-sends and appends the recovered reply
    app.evaluate(
        "() => document.querySelector('.chat-inner deep-chat').shadowRoot.querySelector('.cn-retry').click()"
    )
    app.wait_for_function(
        "() => document.querySelector('.chat-inner deep-chat')?.shadowRoot?.textContent?.includes('recovered')",
        timeout=4000,
    )
    assert calls["n"] > first_calls
