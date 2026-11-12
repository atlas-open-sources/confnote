"""Local-first catalogue with an optional, explicitly configured refresh source."""

import json
import math
import os
import threading
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit

MAX_CATALOGUE_BYTES = 8 * 1024 * 1024
REFRESH_SECONDS = 24 * 60 * 60
EMPTY = {"schema_version": "events.catalogue.v2", "events": []}


def _decode(raw):
    if len(raw) > MAX_CATALOGUE_BYTES:
        raise ValueError("Catalogue is larger than the local read limit")
    data = json.loads(raw)
    if (
        not isinstance(data, dict)
        or data.get("schema_version") != "events.catalogue.v2"
        or not isinstance(data.get("events"), list)
    ):
        raise ValueError("Expected an events.catalogue.v2 index")
    # Reject malformed rendered records before replacing a last-known-good cache.
    for event in data["events"]:
        if not isinstance(event, dict) or any(
            not isinstance(event.get(field), str) or not event[field]
            for field in ("id", "name", "start", "end")
        ):
            raise ValueError("Catalogue event needs id, name, start and end strings")
        for field in ("start", "end"):
            try:
                datetime.fromisoformat(event[field].replace("Z", "+00:00"))
            except ValueError as error:
                raise ValueError("Catalogue event has an invalid date") from error
    return data


def _atomic_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data))
    temporary.replace(path)


class CatalogueStore:
    def __init__(self, snapshot, cache, url="", *, clock=time.time, opener=urllib.request.urlopen):
        self.snapshot = Path(snapshot)
        self.cache = Path(cache)
        self.url = url
        self.clock = clock
        self.opener = opener
        self.lock = threading.Lock()

    def metadata(self):
        try:
            data = json.loads((self.cache / "metadata.json").read_text())
            if not isinstance(data, dict) or data.get("url") != self.url:
                return {}
            checked = data.get("checked_at")
            if not isinstance(checked, (int, float)) or not math.isfinite(checked):
                return {}
            return data
        except (OSError, ValueError):
            return {}

    def read(self):
        """Never performs network I/O or starts a refresh."""
        configured = os.environ.get("CONFNOTE_CATALOGUE_DIR")
        sources = []
        if configured:
            sources.append((Path(configured) / "index.json", "local"))
        if self.metadata():
            sources.append((self.cache / "index.json", "cache"))
        sources.append((self.snapshot, "bundled"))
        last_error = ""
        for source, kind in sources:
            try:
                with source.open("rb") as stream:
                    data = _decode(stream.read(MAX_CATALOGUE_BYTES + 1))
                updated = datetime.fromtimestamp(source.stat().st_mtime, UTC).isoformat()
                return {
                    **data,
                    "catalogue_updated_at": updated,
                    "catalogue_source": kind,
                    "refresh_available": bool(self.url),
                }
            except FileNotFoundError:
                continue
            except (OSError, ValueError) as error:
                last_error = str(error)
        return {
            **EMPTY,
            "message": "No local catalogue configured yet.",
            "error": last_error,
            "refresh_available": bool(self.url),
        }

    def refresh(self, *, force=False):
        """Keep the last known good index; 304 preserves its original updated date."""
        if not self.url:
            return {"ok": False, "disabled": True}
        try:
            parsed = urlsplit(self.url)
        except ValueError:
            return {"ok": False, "error": "Invalid catalogue URL"}
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            return {"ok": False, "error": "Catalogue URL must be HTTPS without credentials"}
        with self.lock:
            meta = self.metadata()
            now = self.clock()
            if not force and "checked_at" in meta and now - meta["checked_at"] < REFRESH_SECONDS:
                return {"ok": True, "unchanged": True}
            headers = {"User-Agent": "confnote-catalogue/0.1", "Accept": "application/json"}
            etag = meta.get("etag")
            if isinstance(etag, str) and "\r" not in etag and "\n" not in etag:
                headers["If-None-Match"] = etag
            request = urllib.request.Request(self.url, headers=headers)
            try:
                with self.opener(request, timeout=15) as response:
                    data = _decode(response.read(MAX_CATALOGUE_BYTES + 1))
                    etag = response.headers.get("ETag", "")
                _atomic_json(self.cache / "index.json", data)
                _atomic_json(
                    self.cache / "metadata.json", {"url": self.url, "etag": etag, "checked_at": now}
                )
                return {"ok": True, "updated": True}
            except urllib.error.HTTPError as error:
                if error.code == 304 and (self.cache / "index.json").exists():
                    _atomic_json(self.cache / "metadata.json", {**meta, "checked_at": now})
                    return {"ok": True, "unchanged": True}
                return {"ok": False, "error": f"Catalogue refresh returned HTTP {error.code}"}
            except (OSError, ValueError) as error:
                return {"ok": False, "error": str(error)}


_stores = {}
_background = set()
_store_lock = threading.Lock()


def _store(snapshot=None, cache=None):
    snapshot = snapshot or Path(__file__).parent / "../core-ui/static/catalogue/index.json"
    cache = (
        os.environ.get("CONFNOTE_CATALOGUE_CACHE_DIR")
        or cache
        or Path.home() / "Library/Application Support/confnote/catalogue"
    )
    url = os.environ.get("CONFNOTE_CATALOGUE_URL", "")
    key = (str(snapshot), str(cache), url)
    with _store_lock:
        if key not in _stores:
            _stores[key] = CatalogueStore(snapshot, cache, url)
        return _stores[key]


def catalogue_payload(snapshot=None, cache=None):
    return _store(snapshot, cache).read()


def refresh_catalogue(snapshot=None, cache=None):
    return _store(snapshot, cache).refresh(force=True)


def start_background_refresh(snapshot=None, cache=None):
    store = _store(snapshot, cache)
    if not store.url:
        return
    with _store_lock:
        if store in _background:
            return
        _background.add(store)

    def refresh_daily():
        while True:
            store.refresh()
            # A daemon owns no resources between checks; process exit cancels it.
            threading.Event().wait(REFRESH_SECONDS)

    threading.Thread(target=refresh_daily, name="catalogue-refresh", daemon=True).start()
