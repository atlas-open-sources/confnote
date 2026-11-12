import json

import pytest
from catalogue import catalogue_payload


def test_catalogue_reads_only_explicit_dist(monkeypatch, tmp_path):
    monkeypatch.setenv("CONFNOTE_CATALOGUE_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.delenv("CONFNOTE_CATALOGUE_DIR", raising=False)
    assert catalogue_payload()["events"] == []
    monkeypatch.setenv("CONFNOTE_CATALOGUE_DIR", str(tmp_path))
    payload = {
        "schema_version": "events.catalogue.v2",
        "events": [{"id": "test", "name": "Test", "start": "2099-01-01", "end": "2099-01-01"}],
    }
    (tmp_path / "index.json").write_text(json.dumps(payload))
    result = catalogue_payload()
    assert result["events"] == payload["events"]
    assert result["catalogue_source"] == "local"
    assert result["catalogue_updated_at"]
    (tmp_path / "index.json").write_text("not JSON")
    assert catalogue_payload()["events"] == []
    assert "error" in catalogue_payload()


def test_bundled_snapshot_and_etag_cache_are_network_free_on_read(tmp_path, monkeypatch):
    import io
    import urllib.error

    from catalogue import REFRESH_SECONDS, CatalogueStore

    monkeypatch.delenv("CONFNOTE_CATALOGUE_DIR", raising=False)
    snapshot = tmp_path / "bundle.json"
    snapshot.write_text(json.dumps({"schema_version": "events.catalogue.v2", "events": []}))
    now = [100]
    requests = []
    payload = {
        "schema_version": "events.catalogue.v2",
        "events": [{"id": "cached", "name": "Cached", "start": "2099-01-01", "end": "2099-01-01"}],
    }

    class Reply(io.BytesIO):
        headers = {"ETag": '"revision-1"'}

    def opener(request, timeout):
        requests.append(request)
        assert timeout == 15
        if len(requests) == 2:
            raise urllib.error.HTTPError(request.full_url, 304, "unchanged", {}, None)
        return Reply(json.dumps(payload).encode())

    store = CatalogueStore(
        snapshot,
        tmp_path / "cache",
        "https://catalogue.example/index.json",
        clock=lambda: now[0],
        opener=opener,
    )
    assert store.read()["catalogue_source"] == "bundled"
    assert requests == []
    assert store.refresh()["updated"]
    cached = store.read()
    assert cached["events"] == payload["events"]
    assert cached["catalogue_source"] == "cache"
    assert len(requests) == 1
    assert store.refresh()["unchanged"]
    assert len(requests) == 1
    now[0] += REFRESH_SECONDS
    assert store.refresh()["unchanged"]
    assert requests[-1].get_header("If-none-match") == '"revision-1"'
    assert store.read()["catalogue_updated_at"] == cached["catalogue_updated_at"]


def test_bad_refresh_preserves_last_good_snapshot_and_unset_url_never_fetches(
    tmp_path, monkeypatch
):
    import io

    from catalogue import CatalogueStore

    monkeypatch.delenv("CONFNOTE_CATALOGUE_DIR", raising=False)
    source = tmp_path / "snapshot.json"
    source.write_text(json.dumps({"schema_version": "events.catalogue.v2", "events": []}))
    calls = []

    def opener(request, timeout):
        calls.append(request)
        return io.BytesIO(b"[]")

    disabled = CatalogueStore(source, tmp_path / "cache", opener=opener)
    assert disabled.refresh()["disabled"]
    assert calls == []
    enabled = CatalogueStore(
        source, tmp_path / "cache", "https://catalogue.example/index.json", opener=opener
    )
    assert not enabled.refresh(force=True)["ok"]
    assert enabled.read()["catalogue_source"] == "bundled"
    assert len(calls) == 1
    invalid = CatalogueStore(
        source, tmp_path / "cache", "http://localhost/index.json", opener=opener
    )
    assert not invalid.refresh()["ok"]
    assert len(calls) == 1


@pytest.mark.parametrize(
    "bad_event",
    [None, {"id": "bad"}, {"id": "bad", "name": "Bad", "start": "invalid", "end": "2099-01-01"}],
)
def test_malformed_event_refresh_keeps_good_cache(tmp_path, monkeypatch, bad_event):
    import io

    from catalogue import CatalogueStore

    monkeypatch.delenv("CONFNOTE_CATALOGUE_DIR", raising=False)
    good = {
        "schema_version": "events.catalogue.v2",
        "events": [{"id": "good", "name": "Good", "start": "2099-01-01", "end": "2099-01-01"}],
    }
    payloads = [good, {"schema_version": "events.catalogue.v2", "events": [bad_event]}]

    class Reply(io.BytesIO):
        headers = {}

    def opener(request, timeout):
        return Reply(json.dumps(payloads.pop(0)).encode())

    store = CatalogueStore(
        tmp_path / "absent.json",
        tmp_path / "cache",
        "https://catalogue.example/index.json",
        opener=opener,
    )
    assert store.refresh(force=True)["ok"]
    before = (tmp_path / "cache/index.json").read_bytes()
    assert not store.refresh(force=True)["ok"]
    assert (tmp_path / "cache/index.json").read_bytes() == before
    assert store.read()["events"] == good["events"]
