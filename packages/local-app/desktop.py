#!/usr/bin/env python3
"""Native-window launcher — turns the app into a real desktop window.

    packages/local-app/run.sh desktop   # from source (bootstraps venv + pywebview)

Falls back to the default browser if pywebview / the OS webview can't start.
Set CONF_NOTES_NOGUI=1 to run headless (server only — used by tests).

Packaging note: a Finder-launched `.app` inherits a minimal PATH and won't
find the `claude` binary the Agent SDK needs, so we widen PATH *before*
importing the server (CHAT_OK is computed at server import time). For a
distributed `.app`, set CONF_NOTES_DIR to the user's real notes folder.
"""

import os
import shutil
import socket
import sys
import threading
import time
from pathlib import Path


def _harden_path():
    home = Path.home()
    extra = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        str(home / ".local/bin"),
        str(home / ".claude/local"),
        str(home / ".npm-global/bin"),
        str(home / ".bun/bin"),
        "/opt/homebrew/opt/node/bin",
    ]
    cur = os.environ.get("PATH", "").split(os.pathsep)
    os.environ["PATH"] = os.pathsep.join(dict.fromkeys([*extra, *cur]))


_harden_path()

APP = Path(__file__).resolve().parent
sys.path.insert(0, str(APP))
import server  # noqa: E402  (imported after PATH is widened)

# server resolves BASE_DIR at import (CONF_NOTES_DIR env → UI-selected vault in
# app state → ~/Documents/confnote default). A double-clicked .app sets no env,
# so it lands on the persisted choice or the default — which we ensure exists.
server.BASE_DIR.mkdir(parents=True, exist_ok=True)
server.seed_starter_vault()


def _free_port(start=8787):
    # CONF_NOTES_PORT pins the port (useful for smoke tests + when the
    # user wants a predictable URL). When unset, scan from `start`.
    env_port = os.environ.get("CONF_NOTES_PORT")
    if env_port:
        try:
            return int(env_port)
        except ValueError:
            pass
    for p in range(start, start + 20):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    return start


def _serve(port):

    server.LocalHTTPServer((server.HOST, port), server.Handler).serve_forever()


def _idle():
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass


class _WinApi:
    """Exposed to the page as window.pywebview.api — lets the frameless
    app's own ✕ / ⤢ controls drive the native window."""

    def set_window(self, w):
        self._w = w

    def set_url(self, u):
        self._url = u

    def open_browser(self):
        try:
            import webbrowser

            webbrowser.open(self._url)
        except Exception:
            pass

    def open_external(self, url):
        """Open an arbitrary http(s) URL in the system browser (used by
        in-app help links, e.g. the Local AI Cat '?')."""
        try:
            import webbrowser

            if isinstance(url, str) and url.startswith(("http://", "https://")):
                webbrowser.open(url)
        except Exception:
            pass

    def pick_folder(self):
        """Native folder picker for the Settings → Notes folder switcher.
        Returns the chosen absolute path, or None if cancelled/unavailable."""
        try:
            import webview

            result = self._w.create_file_dialog(webview.FOLDER_DIALOG)
            if result:
                return result[0] if isinstance(result, (list, tuple)) else str(result)
        except Exception:
            pass
        return None

    def win_pos(self):
        # Current window top-left in screen coords (top-left origin) — the JS
        # top-bar drag reads this once at mousedown, then moves relative to it.
        try:
            return [int(self._w.x), int(self._w.y)]
        except Exception:
            return [0, 0]

    def win_move(self, x, y):
        # Reposition the window (JS top-bar drag).
        try:
            self._w.move(int(x), int(y))
        except Exception:
            pass

    def win_minimize(self):
        # NOT destroy() — destroying pywebview's master window crashes the
        # process. Minimise like a normal app; ⌘Q is the real quit.
        try:
            self._w.minimize()
        except Exception:
            pass

    def win_fullscreen(self):
        try:
            self._w.toggle_fullscreen()
        except Exception:
            pass

    def win_zoom(self):
        # Standard macOS green-button "zoom": fills the screen's work area
        # (excludes menu bar + Dock) and toggles back — NOT spaces fullscreen.
        # `self._w.native` is the NSWindow (pywebview sets it); its own `zoom_`
        # is the reliable toggle. pywebview's `.maximize()` only reaches ~3/4
        # of the screen on Cocoa, so we drive the NSWindow directly. Must run
        # on the main thread.
        try:
            from PyObjCTools import AppHelper

            win = getattr(self._w, "native", None)
            if win is None:
                raise RuntimeError("no native window")
            AppHelper.callAfter(win.zoom_, None)
        except Exception:
            try:
                self._w.maximize()
            except Exception:
                pass


def _enable_media_capture():
    """Let the embedded WKWebView grant getUserMedia (mic) requests.

    pywebview doesn't implement the WKUIDelegate media-capture-permission
    method, so the browser's `navigator.mediaDevices.getUserMedia` (used by
    in-app audio recording) would be auto-denied. We add the method to
    pywebview's nested BrowserView.BrowserDelegate so it auto-grants. The
    app still needs NSMicrophoneUsageDescription in Info.plist + the user's
    one-time macOS mic permission; this only clears WKWebView's own gate.

    Best-effort: failures here just leave recording unavailable (file-drop
    still works), they don't break the app.
    """
    try:
        import objc
        import webview.platforms.cocoa as cocoa

        delegate_cls = cocoa.BrowserView.BrowserDelegate
        selector = (
            b"webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:"
        )
        if delegate_cls.instancesRespondToSelector_(selector):
            return  # already present

        def _decide(self, webView, origin, frame, captureType, decisionHandler):
            decisionHandler(1)  # WKPermissionDecisionGrant

        objc.classAddMethods(
            delegate_cls,
            [objc.selector(_decide, selector=selector, signature=b"v@:@@@q@?")],
        )
    except Exception as e:  # noqa: BLE001
        print(f"media-capture enable skipped: {e}", flush=True)


def main():
    from catalogue import start_background_refresh

    start_background_refresh(
        server.STATIC_DIR / "catalogue/index.json", server.app_state_path().parent / "catalogue"
    )
    port = _free_port()
    threading.Thread(target=_serve, args=(port,), daemon=True).start()
    url = f"http://localhost:{port}"
    print(
        f"confnote  →  {url}  "
        f"(chat: {'on' if shutil.which('claude') else 'off'}, "
        f"notes: {server.BASE_DIR})",
        flush=True,
    )

    if os.environ.get("CONF_NOTES_NOGUI"):
        return _idle()
    try:
        import webview

        _enable_media_capture()  # allow in-app audio recording (getUserMedia)

        # frameless: pywebview's own init removes the macOS titlebar +
        # traffic-light buttons entirely (no ugly grey strip). The app's dark
        # #topbar IS the title bar. Not draggable (easy_drag off so it never
        # fights text selection); quit with ⌘Q (app menu) or ⌘W.
        winapi = _WinApi()
        win = webview.create_window(
            "confnote",
            url,
            width=1280,
            height=860,
            min_size=(900, 600),
            background_color="#000000",
            frameless=True,
            easy_drag=False,
            js_api=winapi,
        )
        winapi.set_window(win)
        winapi.set_url(url)
        webview.start()
    except Exception as e:
        print(f"webview unavailable ({e}); opening in browser instead")
        import webbrowser

        webbrowser.open(url)
        _idle()


if __name__ == "__main__":
    main()
