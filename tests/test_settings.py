"""Tests for the app-settings store (provider config + write-only API key).

The contract that matters: the API key is stored server-side and NEVER
returned to the browser — GET-style reads expose only has_api_key. Saving
without a key keeps the existing one; clear_api_key wipes it.
"""

from __future__ import annotations

import json
import sys

import pytest

sys.path.insert(0, "packages/local-app")
import server  # noqa: E402


@pytest.fixture
def tmp_config(monkeypatch, tmp_path):
    """Redirect the settings store into a temp dir. Forces Keychain OFF so
    these tests exercise the file-storage path deterministically (the
    Keychain routing has its own tests below)."""
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    monkeypatch.setattr(server, "CONFIG_DIR", tmp_path / ".confnote")
    monkeypatch.setattr(server, "SETTINGS_PATH", tmp_path / ".confnote" / "settings.json")
    monkeypatch.setenv("CONF_NOTES_NO_KEYCHAIN", "1")
    return tmp_path


# --------------------------------------------------------- defaults


def test_defaults_when_no_file(tmp_config):
    s = server.read_settings()
    assert s["transcription"]["provider"] == "local"
    assert s["transcription"]["local_base_url"].startswith("http://127.0.0.1")
    assert s["transcription"]["api_key"] == ""


def test_public_settings_hides_key(tmp_config):
    server.write_settings({"transcription": {"provider": "openai", "api_key": "sk-secret"}})
    pub = server.public_settings()
    assert "api_key" not in pub["transcription"]
    assert pub["transcription"]["has_api_key"] is True


# --------------------------------------------------------- write semantics


def test_save_provider_and_urls(tmp_config):
    server.write_settings(
        {
            "transcription": {
                "provider": "openai",
                "openai_base_url": "https://api.openai.com",
                "model": "gpt-4o-transcribe",
            }
        }
    )
    s = server.read_settings()["transcription"]
    assert s["provider"] == "openai"
    assert s["model"] == "gpt-4o-transcribe"


def test_key_persists_when_omitted(tmp_config):
    server.write_settings({"transcription": {"api_key": "sk-keep-me"}})
    # a later save that doesn't include api_key must NOT wipe it
    server.write_settings({"transcription": {"provider": "local"}})
    assert server.read_settings()["transcription"]["api_key"] == "sk-keep-me"


def test_key_updates_when_provided(tmp_config):
    server.write_settings({"transcription": {"api_key": "sk-old"}})
    server.write_settings({"transcription": {"api_key": "sk-new"}})
    assert server.read_settings()["transcription"]["api_key"] == "sk-new"


def test_clear_api_key(tmp_config):
    server.write_settings({"transcription": {"api_key": "sk-bye"}})
    server.write_settings({"transcription": {"clear_api_key": True}})
    s = server.read_settings()["transcription"]
    assert s["api_key"] == ""
    assert server.public_settings()["transcription"]["has_api_key"] is False


def test_invalid_provider_falls_back_to_local(tmp_config):
    server.write_settings({"transcription": {"provider": "wat"}})
    assert server.read_settings()["transcription"]["provider"] == "local"


def test_save_in_cat_history_defaults_off_and_persists(tmp_config):
    assert server.read_settings()["transcription"]["save_in_cat_history"] is False
    server.write_settings({"transcription": {"save_in_cat_history": True}})
    assert server.read_settings()["transcription"]["save_in_cat_history"] is True
    assert server.public_settings()["transcription"]["save_in_cat_history"] is True
    # toggling back off works
    server.write_settings({"transcription": {"save_in_cat_history": False}})
    assert server.read_settings()["transcription"]["save_in_cat_history"] is False


def test_settings_file_is_owner_only(tmp_config):
    server.write_settings({"transcription": {"api_key": "sk-x"}})
    mode = (tmp_config / ".confnote" / "settings.json").stat().st_mode & 0o777
    assert mode == 0o600


def test_settings_file_is_valid_json(tmp_config):
    server.write_settings({"transcription": {"provider": "openai", "api_key": "sk-x"}})
    raw = json.loads((tmp_config / ".confnote" / "settings.json").read_text())
    assert raw["transcription"]["provider"] == "openai"
    # raw on-disk DOES hold the key (it's the server-side store)
    assert raw["transcription"]["api_key"] == "sk-x"


# --------------------------------------------------------- test probe


def test_connection_probe_remote_without_key(tmp_config):
    server.write_settings({"transcription": {"provider": "openai", "clear_api_key": True}})
    out = server.test_transcription_connection()
    assert out["ok"] is False
    assert "API key" in out["detail"]


# --------------------------------------------------- Keychain routing
# When the Keychain is available the key must NOT touch settings.json — it
# goes into the Keychain instead (the vault may be iCloud-synced).

# Constants (not inline string literals) so the secret scanner stays quiet
# regardless of how ruff wraps the call sites.
_KC_KEY = "sk-keychain"  # pragma: allowlist secret
_KC_KEEP = "sk-keep"  # pragma: allowlist secret
_KC_BYE = "sk-bye"  # pragma: allowlist secret


@pytest.fixture
def tmp_config_keychain(monkeypatch, tmp_path):
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    monkeypatch.setattr(server, "CONFIG_DIR", tmp_path / ".confnote")
    monkeypatch.setattr(server, "SETTINGS_PATH", tmp_path / ".confnote" / "settings.json")
    store = {"v": None}  # stand-in Keychain
    monkeypatch.setattr(server.keychain, "available", lambda: True)
    monkeypatch.setattr(server.keychain, "get_key", lambda: store["v"])
    monkeypatch.setattr(server.keychain, "has_key", lambda: store["v"] is not None)

    def _set(v):
        store["v"] = v
        return True

    def _del():
        store["v"] = None
        return True

    monkeypatch.setattr(server.keychain, "set_key", _set)
    monkeypatch.setattr(server.keychain, "delete_key", _del)
    return tmp_path, store


def test_key_goes_to_keychain_not_file(tmp_config_keychain):
    tmp_path, store = tmp_config_keychain
    server.write_settings({"transcription": {"provider": "openai", "api_key": _KC_KEY}})
    # stored in the (stand-in) Keychain
    assert store["v"] == _KC_KEY
    # NOT in settings.json
    raw = json.loads((tmp_path / ".confnote" / "settings.json").read_text())
    assert raw["transcription"]["api_key"] == ""
    # resolved back for server-side use + reported as present
    assert server.read_settings()["transcription"]["api_key"] == _KC_KEY
    assert server.public_settings()["transcription"]["has_api_key"] is True


def test_saving_other_fields_keeps_keychain_key(tmp_config_keychain):
    _, store = tmp_config_keychain
    server.write_settings({"transcription": {"api_key": _KC_KEEP}})
    server.write_settings({"transcription": {"provider": "local"}})  # no key in patch
    assert store["v"] == _KC_KEEP


def test_clear_removes_from_keychain(tmp_config_keychain):
    _, store = tmp_config_keychain
    server.write_settings({"transcription": {"api_key": _KC_BYE}})
    server.write_settings({"transcription": {"clear_api_key": True}})
    assert store["v"] is None
    assert server.public_settings()["transcription"]["has_api_key"] is False
