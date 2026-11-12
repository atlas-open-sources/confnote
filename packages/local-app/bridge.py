"""Generic Python ↔ browser RPC bridge over SSE + plain POST.

Use case: an in-process MCP tool needs to call into a live JS / React
island in the user's browser, wait for the result, and return it to the
agent. The bridge stays module-agnostic — the SSE endpoint paths are
namespaced by module name, and `get_bridge(name)` returns the singleton
for that module.

Wire-up (one Bridge per module):

    Python side (an MCP tool inside chat.py):
        from bridge import get_bridge
        b = get_bridge("sketch")
        result = b.send("apply_js", {"code": "..."})

    Browser side (the module's frontend JS):
        const es = new EventSource("/api/module/sketch/events");
        es.onmessage = async ({data}) => {
            const {id, cmd, params} = JSON.parse(data);
            const result = await dispatch(cmd, params);
            await fetch(`/api/module/sketch/result?id=${id}`, {
                method: "POST",
                body: JSON.stringify({result})
            });
        };

The Python side blocks (via threading.Event) until the browser POSTs the
result back. Calling code wraps it in `asyncio.to_thread` from async
contexts (the MCP SDK tool handlers are async).
"""

from __future__ import annotations

import queue
import threading
import uuid
from typing import Any


class Bridge:
    """Thread-safe pub/sub for one logical RPC channel.

    - Python side: `send(cmd, params)` → pushes to all SSE subscribers,
      blocks until one POSTs a result back via `resolve()`.
    - Browser side: `subscribe()` returns a queue the SSE handler drains
      and writes as `data:` lines; `resolve(id, result|error)` resolves a
      pending command and unblocks the Python caller.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subscribers: list[queue.Queue] = []
        self._pending: dict[str, dict] = {}

    # ---- browser side ------------------------------------------------
    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue()
        with self._lock:
            self._subscribers.append(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            try:
                self._subscribers.remove(q)
            except ValueError:
                pass

    def has_subscribers(self) -> bool:
        with self._lock:
            return bool(self._subscribers)

    def resolve(self, cmd_id: str, result: Any = None, error: str | None = None) -> bool:
        """Resolve a pending command. Returns True if the id matched a
        waiter; False otherwise (caller can 404)."""
        with self._lock:
            slot = self._pending.get(cmd_id)
            if not slot:
                return False
            slot["result"] = result
            slot["error"] = error
            slot["event"].set()
        return True

    # ---- python side -------------------------------------------------
    def send(self, cmd: str, params: dict | None = None, timeout: float = 30.0) -> Any:
        """Push `cmd` to every subscribed SSE channel; block until one
        resolves it. Raises:
          - RuntimeError("no subscribers …") — drawer not open
          - TimeoutError                       — no result in `timeout`s
          - RuntimeError(error)                — browser side reported err
        """
        with self._lock:
            if not self._subscribers:
                raise RuntimeError("no active subscriber — open the module's drawer first")
            cmd_id = uuid.uuid4().hex
            event = threading.Event()
            self._pending[cmd_id] = {"event": event, "result": None, "error": None}
            subs = list(self._subscribers)
        payload = {"id": cmd_id, "cmd": cmd, "params": params or {}}
        for q in subs:
            try:
                q.put_nowait(payload)
            except Exception:
                # subscriber's queue full / closed → skip; others may still respond
                pass
        if not event.wait(timeout):
            with self._lock:
                self._pending.pop(cmd_id, None)
            raise TimeoutError(f"bridge.{cmd} timed out after {timeout}s")
        with self._lock:
            slot = self._pending.pop(cmd_id, {})
        if slot.get("error"):
            raise RuntimeError(str(slot["error"]))
        return slot.get("result")


# Process-wide registry. Both the SSE handler and the MCP tool reach into
# the same Bridge instance by name; lazy so unused modules cost nothing.
_BRIDGES: dict[str, Bridge] = {}
_BRIDGES_LOCK = threading.Lock()


def get_bridge(name: str) -> Bridge:
    """Singleton Bridge per module name. Created on first access."""
    with _BRIDGES_LOCK:
        b = _BRIDGES.get(name)
        if b is None:
            b = Bridge()
            _BRIDGES[name] = b
        return b


def _reset_bridges_for_testing() -> None:
    """Test helper — clear the global registry. Not used in prod."""
    with _BRIDGES_LOCK:
        _BRIDGES.clear()
