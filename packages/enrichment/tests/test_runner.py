import json
from types import SimpleNamespace

import pytest
from enrichment.runner import ClaudeRunner, CodexRunner


def test_claude_has_no_tools_and_source_stays_stdin(monkeypatch):
    def run(args, **kwargs):
        assert args[args.index("--tools") + 1] == ""
        assert "--safe-mode" in args
        assert "--strict-mcp-config" in args
        assert kwargs["input"] == "untrusted $(touch /tmp/not-executed)"
        assert not kwargs.get("shell")
        return SimpleNamespace(stdout=json.dumps({"result": '{"supported":true}'}))

    monkeypatch.setattr("subprocess.run", run)
    assert ClaudeRunner().run("untrusted $(touch /tmp/not-executed)") == {"supported": True}


def test_codex_tool_use_rejected(monkeypatch):
    def run(args, **kwargs):
        assert "--ignore-user-config" in args
        assert "features.shell_tool=false" in args
        return SimpleNamespace(stdout=json.dumps({"item": {"type": "command_execution"}}))

    monkeypatch.setattr("subprocess.run", run)
    with pytest.raises(ValueError, match="tool use"):
        CodexRunner().run("review")
