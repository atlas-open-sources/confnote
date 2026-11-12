"""Unit tests for the concierge JSONL + session-id + thread archival in
server.py. All tests rebind BASE_DIR and the chat paths to a tmp dir; the
user's real ~/Documents/confnote/ is never touched."""

from __future__ import annotations

import sys

sys.path.insert(0, "packages/local-app")
import server  # noqa: E402

# --------------------------------------------------------------------- helpers


def _retarget(monkeypatch, tmp_path):
    """Reroute every CHAT_* path that's derived from BASE_DIR. server.py
    computes these at import time, so monkeypatching BASE_DIR alone isn't
    enough — we set each derived path explicitly."""
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    monkeypatch.setattr(server, "CHAT_HISTORY_DIR", tmp_path / ".chat")
    monkeypatch.setattr(server, "CHAT_HISTORY_PATH", tmp_path / ".chat" / "concierge.jsonl")
    monkeypatch.setattr(server, "CHAT_ARCHIVE_DIR", tmp_path / ".chat" / "archive")
    monkeypatch.setattr(server, "CHAT_SESSION_ID_PATH", tmp_path / ".chat" / "concierge.session-id")


# ----------------------------------------------------- read / append / recall


def test_read_chat_history_empty_when_missing(monkeypatch, tmp_path):
    _retarget(monkeypatch, tmp_path)
    assert server.read_chat_history() == []
    assert server.read_chat_history(limit=10) == []


def test_append_chat_history_creates_dir_and_appends(monkeypatch, tmp_path):
    _retarget(monkeypatch, tmp_path)
    server.append_chat_history("user", "hi", "test-slug")
    server.append_chat_history("assistant", "hello", "test-slug")
    h = server.read_chat_history()
    assert len(h) == 2
    assert h[0]["role"] == "user"
    assert h[0]["text"] == "hi"
    assert h[0]["scope"] == "test-slug"
    assert "ts" in h[0]  # ISO timestamp present
    assert h[1]["role"] == "assistant"
    assert h[1]["text"] == "hello"


def test_append_ignores_blank_text_and_unknown_role(monkeypatch, tmp_path):
    _retarget(monkeypatch, tmp_path)
    server.append_chat_history("user", "   ", "x")  # blank → ignored
    server.append_chat_history("user", "", "x")  # empty → ignored
    server.append_chat_history("system", "ok", "x")  # not user/assistant
    server.append_chat_history("", "ok", "x")  # empty role
    assert server.read_chat_history() == []


def test_read_limit_returns_last_n(monkeypatch, tmp_path):
    _retarget(monkeypatch, tmp_path)
    for i in range(5):
        server.append_chat_history("user", f"q{i}", "x")
    last_two = server.read_chat_history(limit=2)
    assert [m["text"] for m in last_two] == ["q3", "q4"]


def test_read_tolerates_corrupt_lines(monkeypatch, tmp_path):
    _retarget(monkeypatch, tmp_path)
    server.append_chat_history("user", "valid", "x")
    # inject a junk line directly to disk between two valid entries
    p = server.CHAT_HISTORY_PATH
    p.write_text(p.read_text() + "{ not json at all }\n")
    server.append_chat_history("user", "valid 2", "x")
    h = server.read_chat_history()
    assert len(h) == 2
    assert h[0]["text"] == "valid"
    assert h[1]["text"] == "valid 2"


def test_recall_chat_history_case_insensitive(monkeypatch, tmp_path):
    _retarget(monkeypatch, tmp_path)
    server.append_chat_history("user", "Tell me about TLDraw", "x")
    server.append_chat_history("assistant", "TLDraw is a sketchpad", "x")
    server.append_chat_history("user", "Anything else?", "x")
    hits = server.recall_chat_history("tldraw")
    assert len(hits) == 2
    assert all("tldraw" in (h["text"].lower()) for h in hits)


def test_recall_empty_query_returns_empty(monkeypatch, tmp_path):
    _retarget(monkeypatch, tmp_path)
    server.append_chat_history("user", "hi", "x")
    assert server.recall_chat_history("") == []
    assert server.recall_chat_history("   ") == []


# ------------------------------------------------------ session-id sidecar


def test_session_id_sidecar_roundtrip(monkeypatch, tmp_path):
    _retarget(monkeypatch, tmp_path)
    assert server.read_active_session_id() is None
    server.write_active_session_id("sid-123")
    assert server.read_active_session_id() == "sid-123"
    server.clear_active_session_id()
    assert server.read_active_session_id() is None
    # clear is idempotent
    server.clear_active_session_id()
    assert server.read_active_session_id() is None


def test_write_active_ignores_empty(monkeypatch, tmp_path):
    _retarget(monkeypatch, tmp_path)
    server.write_active_session_id("")
    assert not server.CHAT_SESSION_ID_PATH.exists()


# -------------------------------------------------- archive / resume / list


def test_thread_meta_extracts_title_turns_scope(monkeypatch, tmp_path):
    _retarget(monkeypatch, tmp_path)
    server.append_chat_history("user", "What conferences do I have?", "slug-a")
    server.append_chat_history("assistant", "you have one", "slug-a")
    server.append_chat_history("user", "thanks", "slug-a")
    meta = server._thread_meta(server.CHAT_HISTORY_PATH)
    assert meta["title"] == "What conferences do I have?"
    assert meta["turns"] == 3
    assert meta["scope"] == "slug-a"


def test_thread_meta_truncates_long_title(monkeypatch, tmp_path):
    _retarget(monkeypatch, tmp_path)
    long_text = "Q" * 100
    server.append_chat_history("user", long_text, "x")
    meta = server._thread_meta(server.CHAT_HISTORY_PATH)
    assert len(meta["title"]) == 64
    assert meta["title"] == "Q" * 64


def test_thread_meta_uses_first_line_only(monkeypatch, tmp_path):
    _retarget(monkeypatch, tmp_path)
    server.append_chat_history("user", "first line\nsecond line\nthird", "x")
    meta = server._thread_meta(server.CHAT_HISTORY_PATH)
    assert meta["title"] == "first line"


def test_archive_moves_active_and_clears_sidecar(monkeypatch, tmp_path):
    _retarget(monkeypatch, tmp_path)
    server.append_chat_history("user", "hi", "slug-a")
    server.append_chat_history("assistant", "hello", "slug-a")
    server.write_active_session_id("sid-1")

    archived = server.archive_current_chat()
    assert archived is not None
    assert archived["title"] == "hi"
    assert archived["turns"] == 2
    # active file is gone; archive has it
    assert not server.CHAT_HISTORY_PATH.exists()
    assert not server.CHAT_SESSION_ID_PATH.exists()
    arch_files = list(server.CHAT_ARCHIVE_DIR.glob("*.jsonl"))
    assert len(arch_files) == 1


def test_archive_noop_when_empty(monkeypatch, tmp_path):
    _retarget(monkeypatch, tmp_path)
    # empty active file
    server.CHAT_HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    server.CHAT_HISTORY_PATH.touch()
    server.write_active_session_id("sid-x")

    archived = server.archive_current_chat()
    assert archived is None
    # sidecar still cleared even on no-op (clean-state guarantee)
    assert not server.CHAT_SESSION_ID_PATH.exists()


def test_archive_with_no_active_file(monkeypatch, tmp_path):
    _retarget(monkeypatch, tmp_path)
    # no file at all
    archived = server.archive_current_chat()
    assert archived is None


def test_archive_handles_duplicate_timestamp(monkeypatch, tmp_path):
    """Two archives within the same second should both succeed, with the
    second getting a `-1` suffix."""
    _retarget(monkeypatch, tmp_path)
    server.append_chat_history("user", "first", "x")
    a1 = server.archive_current_chat()
    server.append_chat_history("user", "second", "x")
    # force collision by reusing the same timestamp
    target = server.CHAT_ARCHIVE_DIR / a1["id"]
    # second archive — should NOT clobber a1 even if it lands in the same second
    a2 = server.archive_current_chat()
    assert a2 is not None
    assert a2["id"] != a1["id"]
    assert (server.CHAT_ARCHIVE_DIR / a1["id"]).is_file()
    assert (server.CHAT_ARCHIVE_DIR / a2["id"]).is_file()
    assert target.is_file()  # original a1 file preserved


def test_list_threads_active_and_archived(monkeypatch, tmp_path):
    _retarget(monkeypatch, tmp_path)
    server.append_chat_history("user", "first thread", "x")
    server.archive_current_chat()
    server.append_chat_history("user", "second thread", "x")

    result = server.list_chat_threads()
    assert result["active"] is not None
    assert result["active"]["title"] == "second thread"
    assert len(result["archived"]) == 1
    assert result["archived"][0]["title"] == "first thread"


def test_list_threads_when_no_active(monkeypatch, tmp_path):
    _retarget(monkeypatch, tmp_path)
    result = server.list_chat_threads()
    assert result == {"active": None, "archived": []}


def test_resume_swaps_active_and_archive(monkeypatch, tmp_path):
    _retarget(monkeypatch, tmp_path)
    server.append_chat_history("user", "first thread", "x")
    a1 = server.archive_current_chat()
    server.append_chat_history("user", "second thread", "x")
    server.write_active_session_id("sid-second")

    restored = server.resume_chat(a1["id"])
    assert restored is not None
    assert restored["title"] == "first thread"

    h = server.read_chat_history()
    assert h[0]["text"] == "first thread"

    # the previously-active "second thread" is now archived
    arch = sorted(server.CHAT_ARCHIVE_DIR.glob("*.jsonl"))
    titles = [server._thread_meta(p)["title"] for p in arch]
    assert "second thread" in titles

    # session-id was cleared on resume — a brand-new SDK session will start
    assert not server.CHAT_SESSION_ID_PATH.exists()


def test_resume_rejects_path_traversal(monkeypatch, tmp_path):
    _retarget(monkeypatch, tmp_path)
    server.CHAT_ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    assert server.resume_chat("../../../etc/passwd") is None
    assert server.resume_chat("../passwd") is None
    assert server.resume_chat("..%2Fpasswd") is None


def test_resume_rejects_unknown_id(monkeypatch, tmp_path):
    _retarget(monkeypatch, tmp_path)
    server.CHAT_ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    assert server.resume_chat("nonexistent.jsonl") is None
    assert server.resume_chat("") is None
    assert server.resume_chat("foo bar.jsonl") is None  # space → fails regex
    assert server.resume_chat("foo.txt") is None  # wrong extension
