"""Unit tests for the generic Python↔browser RPC bridge.

The bridge is what lets an in-process MCP tool call into a live React
island (e.g. tldraw) and await a result without any global async loop.
We test the threading bits directly — the real SSE plumbing on top is
exercised by an e2e test."""

from __future__ import annotations

import sys
import threading
import time

import pytest

sys.path.insert(0, "packages/local-app")
import bridge  # noqa: E402


def setup_function():
    bridge._reset_bridges_for_testing()


# --------------------------------------------------- registry / singleton


def test_get_bridge_returns_same_instance_per_name():
    a = bridge.get_bridge("sketch")
    b = bridge.get_bridge("sketch")
    assert a is b


def test_get_bridge_returns_distinct_per_name():
    a = bridge.get_bridge("sketch")
    b = bridge.get_bridge("something-else")
    assert a is not b


# --------------------------------------------------------- send-then-wait


def test_send_raises_without_subscribers():
    b = bridge.get_bridge("x")
    with pytest.raises(RuntimeError, match="no active subscriber"):
        b.send("ping")


def test_send_pushes_to_subscriber_and_blocks_for_result():
    b = bridge.get_bridge("x")
    q = b.subscribe()
    holder = {}

    def push():
        # Caller thread waits for the result.
        try:
            holder["result"] = b.send("apply_js", {"code": "1+1"}, timeout=2)
        except Exception as e:
            holder["error"] = e

    t = threading.Thread(target=push)
    t.start()

    # Subscriber receives the payload with id/cmd/params.
    payload = q.get(timeout=2)
    assert payload["cmd"] == "apply_js"
    assert payload["params"] == {"code": "1+1"}
    assert "id" in payload

    # Resolve from the "browser" side.
    assert b.resolve(payload["id"], result=2) is True
    t.join(timeout=2)
    assert holder.get("result") == 2


def test_send_propagates_browser_side_error():
    b = bridge.get_bridge("x")
    q = b.subscribe()
    holder = {}

    def push():
        try:
            b.send("apply_js", {"code": "throw"}, timeout=2)
        except Exception as e:
            holder["error"] = e

    t = threading.Thread(target=push)
    t.start()
    payload = q.get(timeout=2)
    b.resolve(payload["id"], error="SyntaxError: bang")
    t.join(timeout=2)
    assert isinstance(holder["error"], RuntimeError)
    assert "SyntaxError" in str(holder["error"])


def test_send_times_out():
    b = bridge.get_bridge("x")
    b.subscribe()  # subscriber present but never resolves
    t0 = time.monotonic()
    with pytest.raises(TimeoutError):
        b.send("never", timeout=0.15)
    assert time.monotonic() - t0 < 1.0  # actually timed out, not hung


def test_resolve_with_unknown_id_returns_false():
    b = bridge.get_bridge("x")
    b.subscribe()
    assert b.resolve("does-not-exist", result=1) is False


def test_unsubscribe_removes_listener():
    b = bridge.get_bridge("x")
    q = b.subscribe()
    assert b.has_subscribers()
    b.unsubscribe(q)
    assert not b.has_subscribers()
