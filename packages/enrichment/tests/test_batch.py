import hashlib

import pytest
from enrichment.batch import index_response, run_batch, source_context
from enrichment.fetch import Snapshot
from enrichment.gazetteer import Gazetteer
from enrichment.importers import luma_ical


def pairs(count=2):
    text = "BEGIN:VCALENDAR\r\n"
    for index in range(count):
        text += (
            f"BEGIN:VEVENT\r\nUID:fixture-{index}\r\nSUMMARY:Sydney workshop {index}\r\n"
            "LOCATION:Sydney, Australia\r\nDTSTART:20261208T090000Z\r\n"
            "DTEND:20261208T103000Z\r\nSTATUS:TENTATIVE\r\nEND:VEVENT\r\n"
        )
    text += "END:VCALENDAR\r\n"
    snapshot = Snapshot(
        "https://example.org/feed",
        "2026-11-01T00:00:00Z",
        "sha256:" + hashlib.sha256(text.encode()).hexdigest(),
        text,
    )
    return [(event, snapshot) for event in luma_ical(snapshot)]


class Places:
    def suggest(self, text):
        return [
            {"id": "2147714", "city": "Sydney", "country": "AU", "timezone": "Australia/Sydney"}
        ]


class Model:
    def __init__(self, name, response):
        self.name = name
        self.response = response

    def run(self, prompt):
        assert "fixture-" in prompt
        return self.response


def extract(items):
    return {
        "events": [
            {
                "id": event["id"],
                "supported": True,
                "required_errors": [],
                "place_id": "2147714",
                "quote": "LOCATION:Sydney, Australia",
                "online": False,
            }
            for event, _ in items
        ]
    }


def review(items):
    return {
        "events": [
            {"id": event["id"], "verdict": "agree", "required_errors": [], "omit": []}
            for event, _ in items
        ]
    }


def test_batch_partial_response_does_not_falsely_review_missing_record(tmp_path):
    items = pairs()
    results = run_batch(
        items,
        Places(),
        Model("claude", extract(items)),
        Model("codex", review(items[:1])),
        tmp_path,
    )
    assert results[0][1] == []
    assert results[0][0]["city"] == "Sydney"
    assert results[0][0]["provenance"]["city"][0]["extractor"]["agent"] == "claude"
    assert results[0][0]["provenance"]["name"][0]["extractor"]["agent"] == "deterministic-importer"
    assert results[1][1]
    assert results[1][0]["provenance"]["name"][0]["review"]["verdict"] == "pending"


def test_disagreement_holds_only_required_failure_optional_geo_becomes_unknown(tmp_path):
    items = pairs()
    response = review(items)
    response["events"][0]["omit"] = ["timezone"]
    response["events"][1].update(verdict="disagree", required_errors=["wrong date"])
    results = run_batch(
        items, Places(), Model("claude", extract(items)), Model("codex", response), tmp_path
    )
    assert results[0][1] == []
    assert "city" not in results[0][0] and results[0][0]["timezone"] is None
    assert results[1][1]


def test_bad_optional_quote_cannot_gain_provenance(tmp_path):
    items = pairs(1)
    response = extract(items)
    response["events"][0]["quote"] = "invented location"
    results = run_batch(
        items, Places(), Model("claude", response), Model("codex", review(items)), tmp_path
    )
    assert results[0][1] == []
    assert "city" not in results[0][0]
    assert "city" not in results[0][0]["provenance"]


def test_bad_snapshot_hash_cannot_publish(tmp_path):
    items = pairs(1)
    event, snap = items[0]
    bad = Snapshot(snap.url, snap.fetched_at, "sha256:" + "0" * 64, snap.text)
    results = run_batch(
        [(event, bad)],
        Places(),
        Model("claude", extract(items)),
        Model("codex", review(items)),
        tmp_path,
    )
    assert results[0][1] and "snapshot content hash mismatch" in results[0][1]


def test_no_self_review_and_duplicate_response_rejected(tmp_path):
    items = pairs(1)
    with pytest.raises(ValueError, match="independent"):
        run_batch(items, Places(), Model("same", {}), Model("same", {}), tmp_path)
    row = {"id": "a"}
    assert index_response({"events": [row, row]}, {"a"}) == {}


def test_source_context_scoped_to_actual_event():
    items = pairs()
    assert "workshop 0" in source_context(*items[0])
    assert "workshop 1" not in source_context(*items[0])


def test_real_offline_gazetteer_city_country_region_and_ambiguous_candidates(tmp_path):
    admin = tmp_path / "admin1.txt"
    admin.write_text("JP.35\tShiga\tShiga\t1852553\n")
    gazetteer = Gazetteer(admin)
    sydney = gazetteer.suggest("Sydney Australia")
    assert any(
        p.get("city") == "Sydney" and p["country"] == "AU" and p["timezone"] == "Australia/Sydney"
        for p in sydney
    )
    assert any(p.get("city") == "Sydney" and p["country"] == "CA" for p in sydney)
    assert any(
        p.get("region") == "Shiga" and p["country"] == "JP" for p in gazetteer.suggest("SHIGA")
    )
    assert any(
        p["id"] == "country:JM" and p["timezone"] == "America/Jamaica"
        for p in gazetteer.suggest("Jamaica")
    )
    assert gazetteer.manifest["city_count"] > 100000
    assert not gazetteer.suggest("unmatchedlocationxyz")


def test_json_context_preserves_physical_source_whitespace():
    from enrichment.importers import confs_tech

    text = '[\n  {\n    "name": "SciPy",\n    "url": "https://example.org",\n    "startDate": "2026-12-01",\n    "city": "Chennai",\n    "country": "India"\n  }\n]'
    snapshot = Snapshot(
        "https://example.org/feed",
        "2026-11-01T00:00:00Z",
        "sha256:" + hashlib.sha256(text.encode()).hexdigest(),
        text,
    )
    event = confs_tech(snapshot, topic="python")[0]
    context = source_context(event, snapshot)
    assert context in snapshot.text
    assert '"city": "Chennai",\n    "country": "India"' in context


def test_first_wave_batches_every_candidate_without_total_cap(tmp_path, monkeypatch):
    from enrichment import cli

    items = pairs(105)
    snapshot = items[0][1]
    calls = []

    class FakeGazetteer:
        manifest = {"fixture": True}

        def __init__(self, path):
            pass

        def write_manifest(self, path):
            path.write_text("{}")

    class FakeFetcher:
        def fetch(self, url):
            return snapshot

    def batch(items, *args):
        calls.append(len(items))
        return [(event, []) for event, _ in items]

    monkeypatch.setattr(cli, "SOURCES", [("fixture", snapshot.url, "ical")])
    monkeypatch.setattr(cli, "Gazetteer", FakeGazetteer)
    monkeypatch.setattr(cli, "Fetcher", FakeFetcher)
    monkeypatch.setattr(cli, "run_batch", batch)
    monkeypatch.setattr(cli, "publish", lambda repo, events, schema, **kwargs: {"events": events})
    result = cli.run_first_wave(tmp_path / "work", tmp_path / "repo", admin1=tmp_path / "admin1")
    assert result["candidates"] == result["review_attempted"] == result["published"] == 105
    assert result["held"] == 0
    assert calls == [25, 25, 25, 25, 5]


def test_attendance_rejection_keeps_independently_supported_geography(tmp_path):
    items = pairs(1)
    response = review(items)
    response["events"][0]["omit"] = ["attendance_mode"]
    results = run_batch(
        items, Places(), Model("claude", extract(items)), Model("codex", response), tmp_path
    )
    assert results[0][1] == []
    assert results[0][0]["city"] == "Sydney"
    assert "attendance_mode" not in results[0][0]


def test_folded_source_url_retains_physical_quote():
    from enrichment.pipeline import check_candidate

    _, original = pairs(1)[0]
    text = original.text.replace(
        "STATUS:TENTATIVE", "URL:https://luma.com/Claude_PEAK_HR\r\n 1\r\nSTATUS:TENTATIVE"
    )
    snapshot = Snapshot(
        original.url,
        original.fetched_at,
        "sha256:" + hashlib.sha256(text.encode()).hexdigest(),
        text,
    )
    event = luma_ical(snapshot)[0]
    assert event["url"] == "https://luma.com/Claude_PEAK_HR1"
    assert event["provenance"]["url"][0]["quote"] == "https://luma.com/Claude_PEAK_HR\r\n 1"
    assert check_candidate(event, snapshot) == []


def test_dist_carries_source_and_geography_notices(tmp_path):
    from enrichment.publish import build_dist

    (tmp_path / "events").mkdir()
    (tmp_path / "taxonomy").mkdir()
    for name in ("ATTRIBUTION.md", "LICENSE", "confs-tech-LICENSE"):
        (tmp_path / name).write_text("fixture notice: " + name)
    (tmp_path / "taxonomy/geonames-sources.json").write_text('{"license":"CC-BY-4.0"}\n')
    build_dist(tmp_path)
    for name in ("ATTRIBUTION.md", "LICENSE", "confs-tech-LICENSE"):
        assert (tmp_path / "dist" / name).read_bytes() == (tmp_path / name).read_bytes()
    assert (tmp_path / "dist/geonames-sources.json").read_bytes() == (
        tmp_path / "taxonomy/geonames-sources.json"
    ).read_bytes()
