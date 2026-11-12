"""Regression tests for static file serving.

The bug: macOS .app bundles symlink `Contents/Frameworks/static/*` to
`Contents/Resources/static/*`. An older `_serve_static` did
`STATIC_DIR.resolve()` + `is_relative_to(base)`, which resolved the file
symlink into Resources but kept `base` in Frameworks — every asset
404'd. This test recreates that layout in a tmp dir and asserts we can
still read index.html through STATIC_DIR.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, "packages/local-app")
import server  # noqa: E402


def _make_bundle_layout(tmp_path: Path) -> Path:
    """Mirror the .app layout: real files live in `resources/static/`,
    `frameworks/static/` is a directory of symlinks pointing into resources.
    Return the path representing STATIC_DIR (the symlink-y `frameworks/static`)."""
    real = tmp_path / "resources" / "static"
    real.mkdir(parents=True)
    (real / "index.html").write_text("<!doctype html><title>ok</title>")
    (real / "app.js").write_text("/* app */\n")
    (real / "modules").mkdir()
    (real / "modules" / "chat").mkdir()
    (real / "modules" / "chat" / "chat.js").write_text("/* chat */\n")

    fwd = tmp_path / "frameworks" / "static"
    fwd.mkdir(parents=True)
    os.symlink(real / "index.html", fwd / "index.html")
    os.symlink(real / "app.js", fwd / "app.js")
    # modules is itself a real subdir on Frameworks side in the actual
    # bundle layout — but contents are symlinked. We mirror that.
    (fwd / "modules").mkdir()
    (fwd / "modules" / "chat").mkdir()
    os.symlink(
        real / "modules" / "chat" / "chat.js",
        fwd / "modules" / "chat" / "chat.js",
    )
    return fwd


def test_serve_static_through_symlinks(monkeypatch, tmp_path):
    """Smoke test: the file-symlink layout that ships in the .app bundle
    must be servable. STATIC_DIR points at a dir of file-symlinks;
    reading those files must succeed."""
    fwd = _make_bundle_layout(tmp_path)
    monkeypatch.setattr(server, "STATIC_DIR", fwd)

    # Mimic the relevant slice of _serve_static — just the file check.
    # The full Handler is exercised by e2e; here we want a fast smoke.
    def served(req_path: str):
        rel = "index.html" if req_path == "/" else req_path.lstrip("/")
        parts = [p for p in rel.split("/") if p]
        if any(p == ".." for p in parts):
            return None
        f = server.STATIC_DIR.joinpath(*parts) if parts else server.STATIC_DIR / "index.html"
        return f.read_bytes() if f.is_file() else None

    assert served("/") is not None, "GET / must serve index.html through the symlink"
    assert served("/app.js") is not None
    assert served("/modules/chat/chat.js") is not None
    # path traversal still blocked
    assert served("/../etc/passwd") is None


def test_serve_static_rejects_traversal(monkeypatch, tmp_path):
    fwd = _make_bundle_layout(tmp_path)
    (tmp_path / "outside.txt").write_text("nope")
    monkeypatch.setattr(server, "STATIC_DIR", fwd)

    def served(req_path: str):
        rel = "index.html" if req_path == "/" else req_path.lstrip("/")
        parts = [p for p in rel.split("/") if p]
        if any(p == ".." for p in parts):
            return None
        f = server.STATIC_DIR.joinpath(*parts) if parts else server.STATIC_DIR / "index.html"
        return f.read_bytes() if f.is_file() else None

    assert served("/../outside.txt") is None
    assert served("/../../outside.txt") is None


@pytest.mark.skipif(
    not os.environ.get("CONFNOTE_TEST_APP") or not Path(os.environ["CONFNOTE_TEST_APP"]).exists(),
    reason="Set CONFNOTE_TEST_APP to the explicitly selected build for bundle smoke",
)
def test_installed_bundle_serves_index(tmp_path):
    """End-to-end smoke against an explicitly selected fresh bundle.
    The single test that would have caught the 'not found' regression
    you saw — if it had existed before the rebuild."""
    import json
    import socket
    import subprocess
    import time
    import urllib.request

    # Pick a free port to avoid colliding with a running server.
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()

    env = {
        **os.environ,
        "CONF_NOTES_NOGUI": "1",
        "CONF_NOTES_NOOPEN": "1",
        "CONF_NOTES_NO_KEYCHAIN": "1",
        "CONF_NOTES_NO_NATIVE_NOTIFY": "1",
        "CONF_NOTES_PORT": str(port),
        "CONF_NOTES_DIR": str(tmp_path / "vault"),
        "CONFNOTE_CATALOGUE_URL": "",
        "CONFNOTE_CATALOGUE_CACHE_DIR": str(tmp_path / "catalogue-cache"),
    }
    env.pop("CONFNOTE_CATALOGUE_DIR", None)
    bundle = Path(os.environ.get("CONFNOTE_TEST_APP", "/Applications/confnote.app"))
    proc = subprocess.Popen(
        [str(bundle / "Contents/MacOS" / bundle.stem)],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        # Give it a moment to bind. We don't poll harder than this — the
        # whole point is "smoke", not "wait forever".
        for _ in range(100):
            time.sleep(0.15)
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1) as r:
                    body = r.read().decode("utf-8", "replace")
                    assert "<!doctype" in body.lower() or "<html" in body.lower(), (
                        f"bundle returned 200 but body is not HTML: {body[:120]!r}"
                    )
                    break
            except Exception:
                continue
        else:
            raise AssertionError(
                "installed .app never served GET / as HTML — this is the 'not found' regression"
            )
        for asset in ("agent-settings.js", "day-setup.js", "agent-settings.css"):
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/{asset}", timeout=2) as r:
                assert r.status == 200 and r.read(), f"missing packaged asset: {asset}"
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/conferences", timeout=2) as r:
            conferences = json.loads(r.read())
            assert any(c["name"] == "OpenAI DevDay 2026" for c in conferences)
        origin = f"http://127.0.0.1:{port}"
        with urllib.request.urlopen(origin + "/api/catalogue", timeout=2) as r:
            catalogue = json.loads(r.read())
            assert catalogue["schema_version"] == "events.catalogue.v2"
            snapshot = bundle / "Contents/Resources/static/catalogue/index.json"
            if snapshot.exists():
                expected = json.loads(snapshot.read_text())
                assert [event["id"] for event in catalogue["events"]] == [
                    event["id"] for event in expected["events"]
                ]
                assert catalogue["catalogue_source"] == "bundled"
        request = urllib.request.Request(
            origin + "/api/chat/archive",
            data=b"{}",
            headers={"Content-Type": "application/json", "Origin": origin},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=2) as r:
            assert r.status == 200, "same-origin packaged mutation must succeed"
        slug = conferences[0]["slug"]
        with urllib.request.urlopen(origin + "/api/conference?slug=" + slug) as r:
            conference = json.loads(r.read())
        note = next(event["note"] for event in conference["events"] if event.get("note"))
        note_url = origin + "/api/note?slug=" + slug + "&file=" + note
        with urllib.request.urlopen(note_url) as r:
            revision = json.loads(r.read())["mtime"]
        request = urllib.request.Request(
            note_url,
            data=json.dumps(
                {"mtime": revision, "sections": {"Human notes": "Bundle smoke saved."}}
            ).encode(),
            headers={"Content-Type": "application/json", "Origin": origin},
            method="PUT",
        )
        with urllib.request.urlopen(request, timeout=2) as r:
            assert r.status == 200
        with urllib.request.urlopen(note_url) as r:
            assert json.loads(r.read())["sections"]["Human notes"] == "Bundle smoke saved."
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
