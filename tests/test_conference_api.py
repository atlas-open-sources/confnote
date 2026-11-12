from __future__ import annotations

import json
import socket
import sys
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

sys.path.insert(0, "packages/local-app")
import server  # noqa: E402


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _manifest(name="API Conf"):
    return {
        "schema_version": "confnote.agenda.v1",
        "conference": {"name": name, "date": "2026-11-03", "timezone": "Europe/London"},
        "events": [
            {
                "id": "opening",
                "type": "talk",
                "title": "Opening",
                "start": "2026-11-03T09:00:00+00:00",
                "end": "2026-11-03T10:00:00+00:00",
            }
        ],
        "speakers": {},
        "rooms": [],
        "tracks": [],
        "sources": [],
    }


@pytest.fixture
def api_server(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    port = _free_port()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), server.Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{port}", tmp_path
    finally:
        httpd.shutdown()
        thread.join(timeout=3)


def _post(url: str, payload: dict):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Origin": url.split("/api/", 1)[0]},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as r:
        return r.status, json.loads(r.read().decode())


def _post_error(url: str, payload: dict):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Origin": url.split("/api/", 1)[0]},
        method="POST",
    )
    with pytest.raises(urllib.error.HTTPError) as exc:
        urllib.request.urlopen(req, timeout=5)
    return exc.value.code, json.loads(exc.value.read().decode())


def test_validate_conference_manifest_api(api_server):
    base, _ = api_server
    status, body = _post(f"{base}/api/conference/validate", {"agenda": _manifest()})
    assert status == 200
    assert body["ok"] is True
    assert body["summary"]["slug"] == "2026-11-03-api-conf"
    assert body["manifest"]["schema_version"] == "confnote.agenda.v1"


def test_create_conference_api_writes_vault_and_lists_conference(api_server):
    base, vault = api_server
    status, body = _post(f"{base}/api/conferences", {"agenda": _manifest("Created API Conf")})
    assert status == 201
    assert body["ok"] is True
    assert body["slug"] == "2026-11-03-created-api-conf"
    assert (vault / body["slug"] / "notes" / "0900-opening.md").is_file()

    with urllib.request.urlopen(f"{base}/api/conferences", timeout=5) as r:
        listing = json.loads(r.read().decode())
    assert any(c["slug"] == body["slug"] for c in listing)


def test_create_conference_api_rejects_invalid_manifest(api_server):
    base, _ = api_server
    status, body = _post_error(
        f"{base}/api/conferences",
        {"agenda": {"schema_version": "confnote.agenda.v1", "conference": {"name": "Bad"}}},
    )
    assert status == 422
    assert body["ok"] is False
    assert "conference.date is required" in body["errors"]


def _put(url: str, payload: dict):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Origin": url.split("/api/", 1)[0]},
        method="PUT",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


def _make_conf(base) -> str:
    _, body = _post(f"{base}/api/conferences", {"agenda": _manifest("Doc Conf")})
    return body["slug"]


def test_conf_doc_get_and_put_roundtrip(api_server):
    base, vault = api_server
    slug = _make_conf(base)
    # initially empty with mtime 0
    with urllib.request.urlopen(f"{base}/api/conf-doc?slug={slug}", timeout=5) as r:
        doc = json.loads(r.read().decode())
    assert doc["brief"] == "" and doc["brief_mtime"] == 0

    # save the brief inline → persisted to BRIEF.md, mtime advances
    status, body = _put(
        f"{base}/api/conf-doc?slug={slug}&name=BRIEF.md", {"text": "# Plan\n\n- listen", "mtime": 0}
    )
    assert status == 200 and body["ok"] is True and body["mtime"] > 0
    assert "# Plan" in (vault / slug / "BRIEF.md").read_text()


def test_conf_doc_put_stale_mtime_conflicts(api_server):
    base, _ = api_server
    slug = _make_conf(base)
    _, first = _put(f"{base}/api/conf-doc?slug={slug}&name=DEBRIEF.md", {"text": "v1", "mtime": 0})
    # a second writer with the now-stale mtime=0 is rejected with the latest copy
    status, body = _put(
        f"{base}/api/conf-doc?slug={slug}&name=DEBRIEF.md", {"text": "v2", "mtime": 0}
    )
    assert status == 409
    assert body["error"] == "stale"
    assert "v1" in body["text"]
    # writing with the current mtime succeeds
    status, _ = _put(
        f"{base}/api/conf-doc?slug={slug}&name=DEBRIEF.md",
        {"text": "v2", "mtime": first["mtime"]},
    )
    assert status == 200


def test_conf_doc_put_rejects_bad_name(api_server):
    base, _ = api_server
    slug = _make_conf(base)
    status, _ = _put(f"{base}/api/conf-doc?slug={slug}&name=secrets.md", {"text": "x"})
    assert status == 404


def test_module_state_roundtrip(api_server):
    """A module can persist + reload per-conference JSON state (e.g. the tldraw
    canvas snapshot) so a drawing survives an app restart."""
    base, vault = api_server
    slug = _make_conf(base)
    # empty before anything saved
    with urllib.request.urlopen(f"{base}/api/module/tldraw/state?slug={slug}", timeout=5) as r:
        assert json.loads(r.read().decode()) == {}
    # save → on disk under .confnote/modules/<name>.json
    status, body = _put(f"{base}/api/module/tldraw/state?slug={slug}", {"snapshot": {"shapes": 3}})
    assert status == 200 and body["ok"] is True
    assert (vault / slug / ".confnote" / "modules" / "tldraw.json").is_file()
    # reload returns it
    with urllib.request.urlopen(f"{base}/api/module/tldraw/state?slug={slug}", timeout=5) as r:
        assert json.loads(r.read().decode())["snapshot"] == {"shapes": 3}


def test_module_state_rejects_bad_slug(api_server):
    base, _ = api_server
    status, _ = _put(f"{base}/api/module/tldraw/state?slug=../etc", {"snapshot": {}})
    assert status == 404


def test_module_state_home_scope(api_server):
    """An empty slug (and the reserved "home") map to a single vault-wide board
    at the vault root — the home-screen canvas not tied to any conference."""
    base, vault = api_server
    home_file = vault / ".confnote" / "modules" / "tldraw.json"
    # empty slug → home board
    status, body = _put(f"{base}/api/module/tldraw/state?slug=", {"snapshot": {"shapes": 7}})
    assert status == 200 and body["ok"] is True
    assert home_file.is_file()
    # "home" resolves to the SAME file
    with urllib.request.urlopen(f"{base}/api/module/tldraw/state?slug=home", timeout=5) as r:
        assert json.loads(r.read().decode())["snapshot"] == {"shapes": 7}
