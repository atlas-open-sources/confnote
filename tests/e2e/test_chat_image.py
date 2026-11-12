"""Playwright e2e: an attached image reaches the chat request as base64.

This is the durable "body-shape check" for inline images. It drives the REAL
deep-chat upload path — click the attach button, pick a file via the OS file
chooser, type a caption, press Enter — then intercepts the POST to
/api/chat/global and asserts the image rides as a base64 data URL in
`messages[].files[].src`.

Why the real path matters: deep-chat sends a turn WITH files as multipart
FormData (raw blobs), not the JSON it uses for text-only turns. buildChatMessages
in app.js reads those blobs to base64 and rebuilds the JSON the server expects;
this test guards that conversion. The route is FULFILLED with a canned NDJSON
reply, so the agent SDK + `claude` CLI are never spawned.
"""

from __future__ import annotations

import base64
import json

# 1x1 transparent PNG, base64 (matches tests/test_chat_images.py).
PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

# Walk deep-chat's nested shadow roots for the first element matching a class
# regex (attach / send buttons) or the text input.
_FIND_BTN = r"""(re) => {
  const rx = new RegExp(re);
  function find(root) {
    if (!root) return null;
    for (const el of root.querySelectorAll('*')) {
      if (rx.test(el.className || '') && el.click) return el;
      if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; }
    }
    return null;
  }
  const dc = document.querySelector('.chat-inner deep-chat');
  return find(dc && dc.shadowRoot);
}"""

_FOCUS_INPUT = r"""() => {
  function find(root) {
    if (!root) return null;
    const d = root.querySelector("[contenteditable='true'],textarea,input[type='text']");
    if (d) return d;
    for (const el of [...root.querySelectorAll('*')]) {
      const f = find(el.shadowRoot);
      if (f) return f;
    }
    return null;
  }
  const dc = document.querySelector('.chat-inner deep-chat');
  const i = find(dc && dc.shadowRoot);
  if (!i) return false;
  i.focus();
  return true;
}"""


def _open_chat(page):
    page.evaluate("() => { location.hash = '#/2026-05-19-beyond-the-prompt'; }")
    page.wait_for_selector(".drawer-tab[data-id='chat']")
    page.locator(".drawer-tab[data-id='chat']").click()
    page.wait_for_selector(".chat-ctx-strip", timeout=3000)
    page.wait_for_function(
        "() => !!document.querySelector('.chat-inner deep-chat')?.shadowRoot",
        timeout=3000,
    )


def test_attached_image_rides_to_chat_as_base64(app, chat_reset, tmp_path):
    _open_chat(app)

    posts = []

    def handle(route, request):
        posts.append(request.post_data)
        route.fulfill(
            status=200,
            content_type="application/x-ndjson",
            body='{"text":"got it"}\n{"done":true}\n',
        )

    app.route("**/api/chat/global*", handle)

    # tmp_path is auto-cleaned by pytest AFTER the test — never mid-run, so it
    # can't race deep-chat's async read of the chooser-backed (disk-backed) File.
    img = tmp_path / "test.png"
    img.write_bytes(base64.b64decode(PNG_1PX))

    # Click the attach button (inside the composer, left of the text) → pick our PNG.
    with app.expect_file_chooser() as fc:
        app.evaluate(f"({_FIND_BTN})('inside-start')?.click()")
    fc.value.set_files(str(img))
    # Wait until deep-chat shows the pending image attachment — submitting
    # before it registers would send a text-only turn (flaky otherwise).
    app.wait_for_function(f"() => !!({_FIND_BTN})('image-attachment')", timeout=3000)

    # Type a caption with the real keyboard and submit with Enter — this is
    # the path that emits multipart FormData with the image blob.
    assert app.evaluate(_FOCUS_INPUT) is True
    app.keyboard.type("what is this image?")
    app.wait_for_timeout(150)
    app.keyboard.press("Enter")

    for _ in range(50):
        if posts:
            break
        app.wait_for_timeout(100)
    assert posts, "chat never POSTed to /api/chat/global"

    # Find the turn carrying the image across all POSTs (deep-chat may emit
    # more than one request for a single submit).
    with_files = [
        m for post in posts for m in (json.loads(post).get("messages") or []) if m.get("files")
    ]
    assert with_files, f"no message carried files in any POST: {posts}"
    last = with_files[-1]
    assert last.get("text") == "what is this image?"
    src = last["files"][0].get("src", "")
    assert src.startswith("data:image/"), f"file src not a data URL: {src[:40]}"
    assert "base64," in src
    # the base64 payload round-trips back to the pixels we uploaded
    assert PNG_1PX[:24] in src
