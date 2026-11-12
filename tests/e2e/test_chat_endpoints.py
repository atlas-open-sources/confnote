"""HTTP-level tests for /api/chat/* endpoints.

Reuses the `confnote_server` fixture (server on a free port, fresh tmp
vault). These tests don't spawn a browser — they hit the endpoints
directly with urllib, so they're fast and don't depend on the agent SDK
or the `claude` CLI (no /api/chat/global calls).
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request


def _get(url: str):
    with urllib.request.urlopen(url, timeout=5) as r:
        return r.status, json.loads(r.read())


def _post(url: str, body: dict | None = None):
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Origin": urllib.parse.urlunsplit((*urllib.parse.urlsplit(url)[:2], "", "", "")),
        },
    )
    with urllib.request.urlopen(req, timeout=5) as r:
        return r.status, json.loads(r.read())


def _seed(vault, lines: list[dict]):
    """Write a synthetic JSONL into the vault's .chat dir."""
    d = vault / ".chat"
    d.mkdir(parents=True, exist_ok=True)
    p = d / "concierge.jsonl"
    p.write_text("".join(json.dumps(r) + "\n" for r in lines))
    return p


def _clear_chat(vault):
    import shutil

    shutil.rmtree(vault / ".chat", ignore_errors=True)


# ---------------------------------------------------------------- /history


def test_history_empty_when_fresh(confnote_server, chat_reset):
    status, data = _get(confnote_server + "/api/chat/history")
    assert status == 200
    assert data == {"history": []}


def test_history_returns_seeded_turns(confnote_server, chat_reset):
    _seed(
        confnote_server.vault,
        [
            {"ts": "2026-01-01T00:00:00Z", "role": "user", "text": "first", "scope": "x"},
            {"ts": "2026-01-01T00:00:10Z", "role": "assistant", "text": "ack", "scope": "x"},
        ],
    )
    status, data = _get(confnote_server + "/api/chat/history")
    assert status == 200
    assert len(data["history"]) == 2
    assert data["history"][0]["text"] == "first"
    assert data["history"][1]["text"] == "ack"


def test_history_limit_param(confnote_server, chat_reset):
    _seed(
        confnote_server.vault,
        [{"ts": "1", "role": "user", "text": f"q{i}", "scope": "x"} for i in range(5)],
    )
    status, data = _get(confnote_server + "/api/chat/history?limit=2")
    assert status == 200
    assert [m["text"] for m in data["history"]] == ["q3", "q4"]


# ---------------------------------------------------------------- /threads


def test_threads_empty_when_fresh(confnote_server, chat_reset):
    status, data = _get(confnote_server + "/api/chat/threads")
    assert status == 200
    assert data == {"active": None, "archived": []}


def test_threads_lists_active(confnote_server, chat_reset):
    _seed(
        confnote_server.vault,
        [{"ts": "1", "role": "user", "text": "Hello agent", "scope": "x"}],
    )
    status, data = _get(confnote_server + "/api/chat/threads")
    assert status == 200
    assert data["active"]["title"] == "Hello agent"
    assert data["active"]["turns"] == 1


# ---------------------------------------------------------------- /archive


def test_archive_returns_archived_meta(confnote_server, chat_reset):
    _seed(
        confnote_server.vault,
        [
            {"ts": "1", "role": "user", "text": "Pre-archive thread", "scope": "x"},
            {"ts": "2", "role": "assistant", "text": "ok", "scope": "x"},
        ],
    )
    status, data = _post(confnote_server + "/api/chat/archive")
    assert status == 200
    assert data["archived"] is not None
    assert data["archived"]["title"] == "Pre-archive thread"
    assert data["archived"]["turns"] == 2
    assert data["active"] is None
    # active file is gone; archive has the moved file
    chat_dir = confnote_server.vault / ".chat"
    assert not (chat_dir / "concierge.jsonl").exists()
    archived_files = list((chat_dir / "archive").glob("*.jsonl"))
    assert len(archived_files) == 1


def test_archive_noop_when_empty(confnote_server, chat_reset):
    status, data = _post(confnote_server + "/api/chat/archive")
    assert status == 200
    assert data["archived"] is None


# ---------------------------------------------------------------- /resume


def test_resume_unknown_id_404(confnote_server, chat_reset):
    try:
        _post(confnote_server + "/api/chat/resume?id=nonexistent.jsonl")
        raise AssertionError("expected 404")
    except urllib.error.HTTPError as e:
        assert e.code == 404


def test_resume_path_traversal_rejected(confnote_server, chat_reset):
    try:
        _post(confnote_server + "/api/chat/resume?id=../../../etc/passwd")
        raise AssertionError("expected 404")
    except urllib.error.HTTPError as e:
        assert e.code == 404


def test_resume_swaps_active(confnote_server, chat_reset):
    # archive a thread, start a new one, resume the archived one
    _seed(
        confnote_server.vault,
        [{"ts": "1", "role": "user", "text": "old thread", "scope": "x"}],
    )
    _, archive_data = _post(confnote_server + "/api/chat/archive")
    archive_id = archive_data["archived"]["id"]

    _seed(
        confnote_server.vault,
        [{"ts": "2", "role": "user", "text": "new thread", "scope": "x"}],
    )

    status, data = _post(confnote_server + f"/api/chat/resume?id={archive_id}")
    assert status == 200
    assert data["active"]["title"] == "old thread"

    # the previously-active "new thread" is now archived; old thread is active
    _, history = _get(confnote_server + "/api/chat/history")
    assert history["history"][0]["text"] == "old thread"
    _, threads = _get(confnote_server + "/api/chat/threads")
    titles = [t["title"] for t in threads["archived"]]
    assert "new thread" in titles
