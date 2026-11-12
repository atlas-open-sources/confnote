"""Playwright e2e for the chat drawer module.

Covers UI behaviour only — never POSTs to /api/chat/global (which would
spawn the agent SDK + needs the `claude` CLI). The endpoints that ARE
exercised (history, threads, archive, resume) are cheap reads/writes.
"""

from __future__ import annotations

import json


def _seed_jsonl(confnote_server, lines: list[dict]) -> None:
    """Drop a synthetic JSONL into the vault — gives us deterministic
    history without making real chat requests."""
    d = confnote_server.vault / ".chat"
    d.mkdir(parents=True, exist_ok=True)
    (d / "concierge.jsonl").write_text("".join(json.dumps(r) + "\n" for r in lines))


def _open_chat(page):
    """Open a conference + click the Concierge handle. Returns the page
    once the chat module's body is mounted."""
    page.evaluate("() => { location.hash = '#/2026-05-19-beyond-the-prompt'; }")
    page.wait_for_selector(".drawer-tab[data-id='chat']")
    page.locator(".drawer-tab[data-id='chat']").click()
    page.wait_for_selector(".chat-ctx-strip", timeout=3000)


def _set_chat_input(page, text: str):
    return page.evaluate(
        r"""
        (text) => {
          function find(root) {
            if (!root) return null;
            const direct = root.querySelector?.("textarea, input[type='text'], input:not([type]), [contenteditable='true']");
            if (direct) return direct;
            for (const el of [...(root.querySelectorAll?.("*") || [])]) {
              const found = find(el.shadowRoot);
              if (found) return found;
            }
            return null;
          }
          const dc = document.querySelector('.chat-inner deep-chat');
          const input = find(dc?.shadowRoot) || find(dc);
          if (!input) return false;
          if (input.isContentEditable) input.textContent = text;
          else input.value = text;
          input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
          input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: text.slice(-1) || "Backspace" }));
          return true;
        }
        """,
        text,
    )


# --------------------------------------------------------- head buttons


def test_head_has_icon_only_history_and_new_buttons(app, chat_reset):
    _open_chat(app)
    btns = app.locator(".chat-head-btn").evaluate_all(
        "els => els.map(b => ({ text: b.textContent.trim(), title: b.title }))"
    )
    assert len(btns) == 2
    # icon-only: text is just the icon, label is in the tooltip
    texts = {b["text"] for b in btns}
    titles = {b["title"] for b in btns}
    assert texts == {"↺", "+"}
    assert any("Chat history" in t for t in titles)
    assert any("Archive" in t for t in titles)


# --------------------------------------------------------- context strip


def test_context_strip_renders_for_conference_view(app, chat_reset):
    _open_chat(app)
    txt = app.locator(".chat-ctx-text").inner_text()
    assert "viewing" in txt.lower()
    assert "Beyond The Prompt" in txt


def test_context_strip_updates_on_session_open(app, chat_reset):
    _open_chat(app)
    # navigate into a session (triggers setContext broadcast)
    app.evaluate(
        "() => { location.hash = '#/2026-05-19-beyond-the-prompt/0940-opening-keynote.md'; }"
    )
    # the strip text should change to include the session title — no remount
    app.wait_for_function(
        "() => document.querySelector('.chat-ctx-text')  ?.textContent.includes('Opening Keynote')",
        timeout=3000,
    )
    out = app.evaluate(
        """() => ({
          strip: document.querySelector('.chat-ctx-text').textContent,
          // the inner host (deep-chat container) must be the SAME node —
          // i.e. no re-mount of the chat module on context change.
          innerStillThere: !!document.querySelector('.chat-inner'),
        })"""
    )
    assert "Beyond The Prompt" in out["strip"]
    assert "Opening Keynote" in out["strip"]
    assert out["innerStillThere"]


def test_context_strip_says_no_selection_on_home(app, chat_reset):
    _open_chat(app)
    app.evaluate("() => { location.hash = '#/'; }")
    app.wait_for_function(
        "() => document.querySelector('.chat-ctx-text')"
        "  ?.textContent.toLowerCase().includes('no conference')",
        timeout=3000,
    )


# --------------------------------------------------------- thinking picker


def test_thinking_picker_renders_three_options(app, chat_reset):
    _open_chat(app)
    options = app.locator(".chat-think-sel option").evaluate_all("els => els.map(o => o.value)")
    assert options == ["off", "auto", "deep"]


def test_thinking_picker_default_is_off(app, chat_reset):
    _open_chat(app)
    val = app.locator(".chat-think-sel").evaluate("el => el.value")
    assert val == "off"


def test_thinking_picker_persists_to_localstorage(app, chat_reset):
    _open_chat(app)
    app.locator(".chat-think-sel").select_option("deep")
    saved = app.evaluate("() => localStorage.getItem('confnote-thinking')")
    assert saved == "deep"


def test_thinking_picker_restored_from_localstorage(app, chat_reset):
    # Seed the preference, reload, confirm the picker reflects it
    app.evaluate("() => localStorage.setItem('confnote-thinking', 'auto')")
    _open_chat(app)
    val = app.locator(".chat-think-sel").evaluate("el => el.value")
    assert val == "auto"


# --------------------------------------------------------- model picker


def test_model_picker_renders_three_options(app, chat_reset):
    _open_chat(app)
    options = app.locator(".chat-model-sel option").evaluate_all("els => els.map(o => o.value)")
    assert options == ["haiku", "sonnet", "opus"]


def test_model_picker_default_is_haiku(app, chat_reset):
    _open_chat(app)
    val = app.locator(".chat-model-sel").evaluate("el => el.value")
    assert val == "haiku"


def test_model_picker_persists_to_localstorage(app, chat_reset):
    _open_chat(app)
    app.locator(".chat-model-sel").select_option("opus")
    saved = app.evaluate("() => localStorage.getItem('confnote-model')")
    assert saved == "opus"


def test_model_picker_restored_from_localstorage(app, chat_reset):
    app.evaluate("() => localStorage.setItem('confnote-model', 'sonnet')")
    _open_chat(app)
    val = app.locator(".chat-model-sel").evaluate("el => el.value")
    assert val == "sonnet"


def test_model_picker_hidden_on_the_web_host(app, chat_reset):
    # The web server picks the model itself, so the picker would show a choice it ignores.
    app.evaluate("() => { window.confnote.webMode = true; }")
    _open_chat(app)
    assert app.locator(".chat-model").is_hidden()
    app.evaluate("() => { window.confnote.webMode = false; }")


# --------------------------------------------------------- slash picker


def test_slash_picker_opens_filters_and_hides_on_slash_space(app, chat_reset):
    _open_chat(app)
    app.wait_for_function(
        "() => !!document.querySelector('.chat-inner deep-chat')?.shadowRoot",
        timeout=3000,
    )

    assert _set_chat_input(app, "/") is True
    app.wait_for_selector(".slash-picker:not([hidden])", timeout=3000)
    options = app.locator(".slash-opt").evaluate_all("els => els.map(el => el.innerText)")
    assert any("/brief" in option for option in options)
    assert any("/debrief" in option for option in options)
    assert any("/action" in option for option in options)

    assert _set_chat_input(app, "/d") is True
    filtered = app.locator(".slash-opt").evaluate_all("els => els.map(el => el.innerText)")
    assert len(filtered) == 1
    assert "/debrief" in filtered[0]

    assert _set_chat_input(app, "/ ") is True
    app.wait_for_function(
        "() => document.querySelector('.slash-picker')?.hasAttribute('hidden')",
        timeout=3000,
    )


def test_slash_picker_click_inserts_command(app, chat_reset):
    _open_chat(app)
    app.wait_for_function(
        "() => !!document.querySelector('.chat-inner deep-chat')?.shadowRoot",
        timeout=3000,
    )
    assert _set_chat_input(app, "/br") is True
    app.wait_for_selector(".slash-picker:not([hidden])", timeout=3000)
    app.locator(".slash-opt", has_text="/brief").click()

    value = app.evaluate(
        r"""
        () => {
          function find(root) {
            if (!root) return null;
            const direct = root.querySelector?.("textarea, input[type='text'], input:not([type]), [contenteditable='true']");
            if (direct) return direct;
            for (const el of [...(root.querySelectorAll?.("*") || [])]) {
              const found = find(el.shadowRoot);
              if (found) return found;
            }
            return null;
          }
          const dc = document.querySelector('.chat-inner deep-chat');
          const input = find(dc?.shadowRoot) || find(dc);
          return input?.isContentEditable ? input.textContent : input?.value;
        }
        """
    )
    assert value == "/brief "


def _keydown_in_chat(page, key):
    return page.evaluate(
        r"""
        (key) => {
          function find(root) {
            if (!root) return null;
            const direct = root.querySelector?.("textarea, input[type='text'], input:not([type]), [contenteditable='true']");
            if (direct) return direct;
            for (const el of [...(root.querySelectorAll?.("*") || [])]) {
              const found = find(el.shadowRoot);
              if (found) return found;
            }
            return null;
          }
          const dc = document.querySelector('.chat-inner deep-chat');
          const input = find(dc?.shadowRoot) || find(dc);
          if (!input) return false;
          input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
          return true;
        }
        """,
        key,
    )


def _on_index(page):
    return page.evaluate(
        "() => [...document.querySelectorAll('.slash-opt')].findIndex(b => b.classList.contains('on'))"
    )


def test_slash_picker_arrow_nav_shows_single_selection(app, chat_reset):
    """Arrowing must leave exactly ONE highlighted option (keyboard mode
    suppresses the hover highlight), and a mouse move hands selection back to
    the hovered option — so you never see two selected at once."""
    _open_chat(app)
    app.wait_for_function(
        "() => !!document.querySelector('.chat-inner deep-chat')?.shadowRoot",
        timeout=3000,
    )
    assert _set_chat_input(app, "/") is True
    app.wait_for_selector(".slash-picker:not([hidden])", timeout=3000)
    assert app.locator(".slash-opt").count() >= 2

    # Arrow down → keyboard mode, selection on the 2nd option, exactly one .on.
    assert _keydown_in_chat(app, "ArrowDown") is True
    app.wait_for_function(
        "() => document.querySelector('.slash-picker')?.classList.contains('kbd')",
        timeout=2000,
    )
    assert app.locator(".slash-opt.on").count() == 1
    assert _on_index(app) == 1

    # Moving the mouse exits keyboard mode and the hovered option becomes the
    # single selection.
    app.locator(".slash-opt").first.hover()
    app.wait_for_function(
        "() => !document.querySelector('.slash-picker')?.classList.contains('kbd')",
        timeout=2000,
    )
    assert app.locator(".slash-opt.on").count() == 1
    assert _on_index(app) == 0


# --------------------------------------------------------- history view


def test_history_view_lists_archived_threads(app, chat_reset, confnote_server):
    # seed an archived thread + a fresh active
    archive_dir = confnote_server.vault / ".chat" / "archive"
    archive_dir.mkdir(parents=True, exist_ok=True)
    (archive_dir / "2026-01-01T00-00-00Z.jsonl").write_text(
        json.dumps({"ts": "1", "role": "user", "text": "old archived chat", "scope": "x"}) + "\n"
    )
    _seed_jsonl(
        confnote_server,
        [{"ts": "2", "role": "user", "text": "current active chat", "scope": "x"}],
    )

    _open_chat(app)
    app.locator(".chat-head-btn[title='Chat history']").click()
    app.wait_for_selector(".chat-history", timeout=3000)
    # the list is populated by an async fetch — wait for it to materialise
    app.wait_for_function(
        "() => document.querySelectorAll('.chat-thread-item').length >= 2",
        timeout=3000,
    )

    items = app.locator(".chat-thread-item").evaluate_all(
        "els => els.map(li => ({"
        "  title: li.querySelector('.chat-thread-title').textContent,"
        "  active: li.classList.contains('active'),"
        "  hasResume: !!li.querySelector('.chat-thread-resume'),"
        "}))"
    )
    titles = [i["title"] for i in items]
    assert "current active chat" in titles
    assert "old archived chat" in titles
    # active row has no resume button; archived ones do
    by_title = {i["title"]: i for i in items}
    assert by_title["current active chat"]["active"] is True
    assert by_title["current active chat"]["hasResume"] is False
    assert by_title["old archived chat"]["active"] is False
    assert by_title["old archived chat"]["hasResume"] is True


def test_history_back_button_returns_to_chat(app, chat_reset):
    _open_chat(app)
    app.locator(".chat-head-btn[title='Chat history']").click()
    app.wait_for_selector(".chat-history")
    app.locator(".chat-history-back").click()
    # the chat-inner content area should be visible again
    app.wait_for_function(
        "() => document.querySelector('.chat-inner')  && !document.querySelector('.chat-history')",
        timeout=2000,
    )


# --------------------------------------------------------- archive flow


def test_new_chat_archives_current_and_clears_active(app, chat_reset, confnote_server):
    # seed an active conversation
    _seed_jsonl(
        confnote_server,
        [
            {"ts": "1", "role": "user", "text": "soon-to-be-archived", "scope": "x"},
            {"ts": "2", "role": "assistant", "text": "ok", "scope": "x"},
        ],
    )
    _open_chat(app)
    app.locator(".chat-head-btn[title*='Archive current']").click()
    # wait for the POST to land + the chat to re-mount with the empty active
    app.wait_for_function(
        "() => !document.querySelector('.chat-head-btn[disabled]')",
        timeout=3000,
    )
    # active jsonl should be gone; archive dir should have one file
    assert not (confnote_server.vault / ".chat" / "concierge.jsonl").exists()
    archived = list((confnote_server.vault / ".chat" / "archive").glob("*.jsonl"))
    assert len(archived) == 1


# --------------------------------------------------------- isolation rule


def test_chat_module_does_not_pollute_core_app_js():
    """Same boundary rule as the rest of the drawer modules — core app.js
    must not contain the chat module's classnames or selectors."""
    from pathlib import Path

    core = Path(__file__).resolve().parents[2] / "packages/core-ui/static/app.js"
    src = core.read_text()
    # `chat-thread-list` / `chat-history-back` / `chat-think-sel` are the
    # chat module's private DOM. They must never appear in core.
    assert "chat-thread-list" not in src
    assert "chat-history-back" not in src
    assert "chat-think-sel" not in src
