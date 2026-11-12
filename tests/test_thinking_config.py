"""Unit tests for chat.py's level-name → SDK ThinkingConfig mapping and
the durable_history → messages adapter. Both are pure functions; no SDK
runtime involved."""

from __future__ import annotations

import sys

sys.path.insert(0, "packages/local-app")
import chat  # noqa: E402

# ------------------------------------------------------ _thinking_config


def test_thinking_off_disables():
    assert chat._thinking_config("off") == {"type": "disabled"}


def test_thinking_auto_is_adaptive():
    assert chat._thinking_config("auto") == {"type": "adaptive"}


def test_thinking_deep_enables_with_budget():
    cfg = chat._thinking_config("deep")
    assert cfg["type"] == "enabled"
    assert cfg["budget_tokens"] >= 4000  # generous enough to matter


def test_thinking_default_when_none():
    assert chat._thinking_config(None) == {"type": "disabled"}


def test_thinking_unknown_falls_back_to_disabled():
    assert chat._thinking_config("weird-level") == {"type": "disabled"}
    assert chat._thinking_config("") == {"type": "disabled"}


def test_thinking_case_insensitive():
    assert chat._thinking_config("OFF") == {"type": "disabled"}
    assert chat._thinking_config("Auto") == {"type": "adaptive"}
    assert chat._thinking_config("DEEP")["type"] == "enabled"


def test_thinking_levels_constant_matches_router():
    assert "off" in chat.THINKING_LEVELS
    assert "auto" in chat.THINKING_LEVELS
    assert "deep" in chat.THINKING_LEVELS


# ------------------------------------------------- _history_to_messages


def test_history_to_messages_filters_and_shapes():
    history = [
        {"role": "user", "text": "hi"},
        {"role": "assistant", "text": "hello"},
        {"role": "system", "text": "ignored"},  # not user/assistant
        {"role": "user", "text": "   "},  # blank → dropped
        {"role": "user", "text": "real"},
    ]
    out = chat._history_to_messages(history)
    assert out == [
        {"role": "user", "text": "hi"},
        {"role": "assistant", "text": "hello"},
        {"role": "user", "text": "real"},
    ]


def test_history_to_messages_handles_empty():
    assert chat._history_to_messages([]) == []
    assert chat._history_to_messages(None or []) == []


def test_history_to_messages_handles_missing_text():
    history = [
        {"role": "user"},  # no text field
        {"role": "user", "text": None},
    ]
    assert chat._history_to_messages(history) == []
