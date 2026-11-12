"""macOS Keychain storage for the transcription API key.

The key is confnote's one secret and the vault lives under ~/Documents
(possibly iCloud-synced), so we keep the key OUT of settings.json and in the
login Keychain instead.

Backend: the native **Keychain Services** API via PyObjC's `Security`
framework — which is already in the bundle (pywebview pulls in the PyObjC
stack). Versus shelling out to `/usr/bin/security`, this:
  - passes the key in-process (no brief argv exposure in `ps`), and
  - gives the item a per-app access control tied to confnote's code
    signature rather than trusting the `security` CLI.

Off macOS (or if the framework can't load, or CONF_NOTES_NO_KEYCHAIN is
set) `available()` is False and the caller falls back to the chmod-600
settings file. A small in-process cache avoids re-querying on every read.
"""

from __future__ import annotations

import os
import sys

SERVICE = "confnote-transcription-api-key"
ACCOUNT = "confnote"

# errSecItemNotFound — returned by lookups/deletes when nothing is stored.
_ERR_NOT_FOUND = -25300

# Load the native framework once. Guarded so non-macOS (CI/Linux) just
# disables Keychain rather than crashing the import of server.py.
_sec = None
try:  # pragma: no cover - platform dependent
    if sys.platform == "darwin":
        import CoreFoundation  # noqa: F401  (ensures CF types are bridged)
        import Security as _sec
except Exception:  # pragma: no cover
    _sec = None

# {"loaded": bool, "value": str | None}; value None == "no key stored".
_cache: dict = {"loaded": False, "value": None}


def available() -> bool:
    if os.environ.get("CONF_NOTES_NO_KEYCHAIN"):
        return False
    return _sec is not None


def _query() -> dict:
    return {
        _sec.kSecClass: _sec.kSecClassGenericPassword,
        _sec.kSecAttrService: SERVICE,
        _sec.kSecAttrAccount: ACCOUNT,
    }


def set_key(value: str) -> bool:
    """Store/replace the key. Returns True on success."""
    if not available() or not value:
        return False
    try:
        _sec.SecItemDelete(_query())  # idempotent replace
        attrs = _query()
        attrs[_sec.kSecValueData] = value.encode("utf-8")
        status, _ref = _sec.SecItemAdd(attrs, None)
        ok = status == 0
    except Exception:
        ok = False
    if ok:
        _cache.update(loaded=True, value=value)
    return ok


def has_key() -> bool:
    """Return whether a key exists without reading the secret bytes."""
    if not available():
        return False
    if _cache["loaded"]:
        return bool(_cache["value"])
    try:
        q = _query()
        q[_sec.kSecReturnAttributes] = True
        q[_sec.kSecMatchLimit] = _sec.kSecMatchLimitOne
        status, _attrs = _sec.SecItemCopyMatching(q, None)
        return status == 0
    except Exception:
        return False


def get_key() -> str | None:
    """Return the stored key, or None. Cached after first read."""
    if not available():
        return None
    if _cache["loaded"]:
        return _cache["value"]
    val = None
    try:
        q = _query()
        q[_sec.kSecReturnData] = True
        q[_sec.kSecMatchLimit] = _sec.kSecMatchLimitOne
        status, data = _sec.SecItemCopyMatching(q, None)
        if status == 0 and data is not None:
            val = bytes(data).decode("utf-8")
    except Exception:
        val = None
    _cache.update(loaded=True, value=val)
    return val


def delete_key() -> bool:
    """Remove the key. Returns True if removed or already absent."""
    _cache.update(loaded=True, value=None)
    if not available():
        return False
    try:
        status = _sec.SecItemDelete(_query())
        return status in (0, _ERR_NOT_FOUND)
    except Exception:
        return False


def _reset_cache_for_testing() -> None:
    _cache.update(loaded=False, value=None)
