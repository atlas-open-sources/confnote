"""Current operational rules reach resumed Claude and ChatGPT turns."""

import agent_guidance
import chat
import pytest


def test_resumed_claude_turn_reads_current_skill(monkeypatch, tmp_path):
    skill = tmp_path / "skills/conference-operations/SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("---\nname: conference-operations\n---\nFirst rules")
    monkeypatch.setattr(agent_guidance, "__file__", str(tmp_path / "agent_guidance.py"))
    first = chat._context_envelope("Conference", "Notes", "LIVE")
    skill.write_text("---\nname: conference-operations\n---\nRevised rules")
    resumed = chat._context_envelope("Conference", "Notes", "LIVE")
    assert "First rules" in first
    assert "Revised rules" in resumed and "First rules" not in resumed
    assert "name: conference-operations" not in resumed
    assert "STATUS: LIVE" in resumed


def test_missing_packaged_skill_does_not_silently_drop_rules(monkeypatch, tmp_path):
    monkeypatch.setattr(agent_guidance, "__file__", str(tmp_path / "agent_guidance.py"))
    with pytest.raises(FileNotFoundError):
        agent_guidance.conference_operations_guidance()
