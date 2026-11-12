"""Tests for chat.discover_module_mcps — the seam that makes
Python-side MCP servers opt-in per modules.config.json.

Also covers the disposability invariant: removing a module's directory +
its config entry must produce zero references in core code."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, "packages/local-app")
import chat  # noqa: E402
import server  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
CORE_STATIC = REPO / "packages" / "core-ui" / "static"
LOCAL_APP = REPO / "packages" / "local-app"
MOD_CFG = CORE_STATIC / "modules.config.json"


# --------------------------------------------------------- enabled-names


def test_enabled_module_names_matches_config():
    names = chat._enabled_module_names()
    assert isinstance(names, list)
    # The shipped default config always has 'chat' as the last slot.
    assert names and names[-1] == "chat"


# ----------------------------------------------------------- discovery


def test_discover_with_no_python_modules_is_noop(monkeypatch, tmp_path):
    # Point the discovery loop at an empty modules dir.
    monkeypatch.setattr(chat, "_modules_root", lambda: tmp_path)
    out = chat.discover_module_mcps(emit=lambda _: None)
    assert out == {
        "servers": {},
        "allowed_tools": [],
        "tool_notices": {},
        "prompt_fragments": [],
    }


def test_discover_loads_tldraw_when_enabled():
    """End-to-end (real filesystem) — when modules.config.json lists
    'tldraw' and modules/tldraw/mcp.py exists, discovery returns the
    sketch server + its tool list + prompt fragment.

    Skipped automatically when tldraw is toggled off in the default
    config — the module is opt-in by design."""
    if "tldraw" not in chat._enabled_module_names():
        pytest.skip("tldraw module toggled off in modules.config.json")
    out = chat.discover_module_mcps(emit=lambda _: None, bridges={"tldraw": object()})
    # The 'sketch' MCP server is named in mcp.py's `make_server` return.
    assert "sketch" in out["servers"]
    assert "mcp__sketch__apply_js" in out["allowed_tools"]
    assert "mcp__sketch__describe_api" in out["allowed_tools"]
    assert "mcp__sketch__save_sketch" in out["allowed_tools"]
    assert out["prompt_fragments"], "tldraw module should contribute a prompt fragment"


# ------------------------------------------ bundle (.app) path resolution
#
# Regression for the packaging bug: in the frozen .app, the config + backend
# module dir live under sys._MEIPASS / server.STATIC_DIR, NOT the source tree.
# Before the fix, discovery used source-relative paths that don't exist in the
# bundle, so the .app found zero backend module MCPs.


def test_modules_root_uses_meipass_when_frozen(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)
    assert chat._modules_root() == tmp_path / "modules"


def test_modules_root_source_fallback_when_not_frozen(monkeypatch):
    monkeypatch.delattr(sys, "frozen", raising=False)
    root = chat._modules_root()
    assert root.name == "modules" and root.parent.name == "local-app"


def test_modules_config_path_follows_server_static_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "STATIC_DIR", tmp_path)
    assert chat._modules_config_path() == tmp_path / "modules.config.json"


def test_discover_finds_backend_module_via_bundle_paths(tmp_path, monkeypatch):
    """End-to-end of the bundle layout: a config under STATIC_DIR + a backend
    mcp.py under _MEIPASS/modules must be discovered when frozen. This is the
    exact path that was broken in the .app."""
    meipass = tmp_path / "meipass"
    (meipass / "static").mkdir(parents=True)
    (meipass / "static" / "modules.config.json").write_text(json.dumps({"slots": ["demo", "chat"]}))
    demo = meipass / "modules" / "demo"
    demo.mkdir(parents=True)
    (demo / "mcp.py").write_text(
        "from claude_agent_sdk import create_sdk_mcp_server, tool\n"
        "def make_server(*, emit, bridges):\n"
        "    @tool('ping', 'p', {})\n"
        "    async def ping(args):\n"
        "        return {'content': [{'type': 'text', 'text': 'pong'}]}\n"
        "    return {'name': 'demo', 'server': create_sdk_mcp_server('demo', '1', [ping]),\n"
        "            'allowed_tools': ['mcp__demo__ping']}\n"
    )
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(meipass), raising=False)
    monkeypatch.setattr(server, "STATIC_DIR", meipass / "static")

    out = chat.discover_module_mcps(emit=lambda _: None, bridges={})
    assert "demo" in out["servers"]
    assert "mcp__demo__ping" in out["allowed_tools"]


def test_discover_swallows_broken_mcp_py(tmp_path, monkeypatch):
    """A module whose mcp.py crashes on import must not break the chat —
    discovery emits a notice and continues."""
    fake_root = tmp_path / "modules"
    (fake_root / "bad").mkdir(parents=True)
    (fake_root / "bad" / "mcp.py").write_text("raise RuntimeError('boom')\n")

    fake_cfg = tmp_path / "modules.config.json"
    fake_cfg.write_text(json.dumps({"slots": ["bad", "chat"]}))

    monkeypatch.setattr(chat, "_modules_config_path", lambda: fake_cfg)
    monkeypatch.setattr(chat, "_modules_root", lambda: fake_root)

    notices: list = []
    out = chat.discover_module_mcps(emit=lambda x: notices.append(x))
    assert out["servers"] == {}
    assert any("bad" in (n.get("notice") or "") for n in notices)


# --------------------------------------------------- disposability gate
#
# Core files (app.js, server.py, chat.py) must not reference 'tldraw' by
# name — only via the generic module-discovery / module-bridge URLs.
# That's the contract that lets us drop the feature without touching
# core code.


CORE_FILES = [
    CORE_STATIC / "app.js",
    LOCAL_APP / "chat.py",
]


def test_core_files_do_not_name_tldraw():
    for f in CORE_FILES:
        text = f.read_text()
        # Allow nothing — even a comment naming tldraw in a core file would
        # signal a leak in the abstraction. The module name lives only in
        # modules.config.json + the module's own dir.
        assert "tldraw" not in text.lower(), f"{f} references 'tldraw' — modularity leak"


def test_server_only_mentions_tldraw_in_generic_paths():
    """server.py is allowed to talk about /api/module/<name>/ generically
    but must not hardcode 'tldraw'."""
    text = (LOCAL_APP / "server.py").read_text().lower()
    assert "tldraw" not in text, "server.py must stay module-agnostic"
