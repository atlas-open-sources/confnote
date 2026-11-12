"""Shared operational guidance for both concierge providers."""

from pathlib import Path


def conference_operations_guidance() -> str:
    """Read the bundled skill so resumed chats receive current rules each turn."""
    skill = Path(__file__).parent / "skills/conference-operations/SKILL.md"
    text = skill.read_text(encoding="utf-8")
    if text.startswith("---\n"):
        text = text.split("---\n", 2)[2]
    return "[CONFERENCE OPERATIONS — current guidance]\n" + text.strip()
