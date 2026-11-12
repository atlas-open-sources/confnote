"""Private commentary: client-side AES-GCM encryption, agent-invisible.

Drives the full passphrase setup -> write -> lock -> unlock flow in a real
browser (WebCrypto), and asserts the server only ever stores ciphertext.
"""

from __future__ import annotations

# A pristine session no other e2e test writes to.
_NOTE = "1135-ai-in-ag-studio.md"
_HASH = f"/2026-05-19-beyond-the-prompt/{_NOTE}"
_PASS = "correct horse battery"  # pragma: allowlist secret
_SECRET = "my confidential take on this talk"  # pragma: allowlist secret


def _open_private(app):
    app.evaluate(f"() => {{ location.hash = '{_HASH}'; }}")
    app.wait_for_selector("#tabbar .tab")
    app.locator('#tabbar .tab[data-t="Private"]').click()
    app.wait_for_selector(".priv-pane")


def test_private_commentary_encrypts_client_side(app):
    _open_private(app)

    # First use: set a passphrase.
    app.wait_for_selector(".priv-box .priv-input")
    inputs = app.locator(".priv-pane .priv-input")
    inputs.nth(0).fill(_PASS)
    inputs.nth(1).fill(_PASS)
    app.locator(".priv-pane .priv-btn").click()

    # Now in the editor. Type a secret and let the debounced save fire.
    app.wait_for_selector(".priv-ta")
    app.locator(".priv-ta").fill(_SECRET)
    app.wait_for_timeout(1100)

    # The server only ever holds ciphertext — never the plaintext.
    sec = app.evaluate(
        "async () => (await fetch('/api/note?slug=2026-05-19-beyond-the-prompt&file="
        + _NOTE
        + "').then((r) => r.json())).sections.Private"
    )
    assert sec.startswith("confnote-enc:v1:")
    assert _SECRET not in sec

    # Lock -> the pane returns to the locked/unlock state.
    app.locator(".priv-lock-btn").click()
    app.wait_for_selector(".priv-box .priv-input")

    # Wrong passphrase is rejected.
    app.locator(".priv-pane .priv-input").fill("not the passphrase")
    app.locator(".priv-pane .priv-btn").click()
    app.wait_for_function(
        "() => document.querySelector('.priv-err')?.textContent.includes('Wrong')"
    )

    # Correct passphrase decrypts the stored note back to plaintext.
    app.locator(".priv-pane .priv-input").fill(_PASS)
    app.locator(".priv-pane .priv-btn").click()
    app.wait_for_selector(".priv-ta")
    assert app.locator(".priv-ta").input_value() == _SECRET
