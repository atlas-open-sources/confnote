"""Picks ("attending") live in the session note's frontmatter on the Mac app.

The hosted twin is packages/web-app/test/picks.test.ts; both answer the same
GET/PUT /api/picks shape.
"""

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

SLUG = "2026-11-03-picks-conf"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _manifest():
    def event(eid, title, start, end, kind="talk"):
        return {
            "id": eid,
            "type": kind,
            "title": title,
            "start": f"2026-11-03T{start}:00+00:00",
            "end": f"2026-11-03T{end}:00+00:00",
        }

    return {
        "schema_version": "confnote.agenda.v1",
        "conference": {"name": "Picks Conf", "date": "2026-11-03", "timezone": "Europe/London"},
        "events": [
            event("opening", "Opening", "09:00", "10:00"),
            event("deep-dive", "Deep Dive", "09:30", "10:30"),
            event("coffee", "Coffee", "10:30", "11:00", "break"),
        ],
        "speakers": {},
    }


@pytest.fixture
def vault(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    server.create_conference(_manifest())
    return tmp_path


@pytest.fixture
def base(vault):
    port = _free_port()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), server.Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        httpd.shutdown()
        thread.join(timeout=3)


def _call(base, method, path, payload=None):
    headers = {"Origin": base}
    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode()
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_frontmatter_flag_touches_only_the_frontmatter():
    text = "---\nsession: Opening\n---\n\n# Opening\n\n## Human notes\n\nattending: no\n"
    on = server.with_frontmatter_flag(text, "attending", True)
    assert (
        on
        == "---\nsession: Opening\nattending: true\n---\n\n# Opening\n\n## Human notes\n\nattending: no\n"
    )
    assert server.with_frontmatter_flag(on, "attending", False) == text
    bare = "# Loose note\n"
    assert server.with_frontmatter_flag(bare, "attending", True).startswith(
        "---\nattending: true\n---\n"
    )
    assert server.with_frontmatter_flag(bare, "attending", False) == bare


def test_a_note_whose_frontmatter_never_closes_is_refused_not_cut(base, vault):
    note = vault / SLUG / "notes" / "0900-opening.md"
    broken = "---\nsession: Opening\n\n# Opening\n\nattending: keep this sentence\n"
    note.write_text(broken)
    code, body = _call(base, "PUT", f"/api/picks?slug={SLUG}", {"picks": {"0900-opening.md": True}})
    assert code == 400 and "closing ---" in body["error"]
    assert note.read_text() == broken


def test_picks_round_trip_through_the_notes(base, vault):
    code, body = _call(base, "GET", f"/api/picks?slug={SLUG}")
    assert (code, body) == (200, {"slug": SLUG, "notes": []})

    code, body = _call(base, "PUT", f"/api/picks?slug={SLUG}", {"picks": {"0900-opening.md": True}})
    assert code == 200
    assert body["notes"] == ["0900-opening.md"]
    assert set(body["changed"]) == {"0900-opening.md"}
    note = (vault / SLUG / "notes" / "0900-opening.md").read_text()
    assert "\nattending: true\n" in note.split("\n---\n", 1)[0] + "\n"

    code, conf = _call(base, "GET", f"/api/conference?slug={SLUG}")
    attending = {ev["note"]: ev["attending"] for ev in conf["events"] if ev.get("note")}
    assert attending == {
        "0900-opening.md": True,
        "0930-deep-dive.md": False,
        "1030-coffee.md": False,
    }

    code, body = _call(
        base,
        "PUT",
        f"/api/picks?slug={SLUG}",
        {"picks": {"0900-opening.md": False, "0930-deep-dive.md": True}},
    )
    assert body["notes"] == ["0930-deep-dive.md"]
    assert "attending" not in (vault / SLUG / "notes" / "0900-opening.md").read_text()


def test_a_note_save_keeps_the_pick(base, vault):
    _call(base, "PUT", f"/api/picks?slug={SLUG}", {"picks": {"0900-opening.md": True}})
    code, _ = _call(
        base,
        "PUT",
        f"/api/note?slug={SLUG}&file=0900-opening.md",
        {"sections": {"Human notes": "Great opening."}},
    )
    assert code == 200
    assert server.read_picks(SLUG) == ["0900-opening.md"]


def test_picks_refuse_unknown_notes_and_conferences(base, vault):
    code, body = _call(base, "PUT", f"/api/picks?slug={SLUG}", {"picks": {"../x.md": True}})
    assert code == 400 and "Not a session note" in body["error"]
    code, _ = _call(base, "PUT", f"/api/picks?slug={SLUG}", {"picks": {"0900-opening.md": "yes"}})
    assert code == 400
    assert server.read_picks(SLUG) == []
    assert _call(base, "GET", "/api/picks?slug=2026-01-01-nope")[0] == 404
    assert _call(base, "PUT", "/api/picks?slug=2026-01-01-nope", {"picks": {}})[0] == 404


def test_picks_need_a_same_origin_write(base):
    req = urllib.request.Request(
        f"{base}/api/picks?slug={SLUG}",
        data=json.dumps({"picks": {"0900-opening.md": True}}).encode(),
        headers={"Content-Type": "application/json", "Origin": "https://evil.example"},
        method="PUT",
    )
    with pytest.raises(urllib.error.HTTPError) as error:
        urllib.request.urlopen(req, timeout=5)
    assert error.value.code == 403
    assert server.read_picks(SLUG) == []
