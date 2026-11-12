import hashlib
import json
from datetime import UTC, datetime

import pytest
from enrichment import cli
from enrichment.batch import location_context, source_context
from enrichment.fetch import Snapshot
from enrichment.importers import devpost, devpost_dates, linux_foundation
from enrichment.pipeline import check_candidate

NOW = datetime(2026, 11, 9, tzinfo=UTC)


def snap(url, text):
    return Snapshot(
        url, "2026-11-09T00:00:00Z", "sha256:" + hashlib.sha256(text.encode()).hexdigest(), text
    )


def listing(*names):
    rows = [{"name": name, "type": "file"} for name in names]
    rows.append({"name": "archive", "type": "dir"})
    return json.dumps(rows)


def test_registry_lists_every_confs_tech_year_and_the_open_sources():
    kinds = {name: kind for name, _, kind in cli.SOURCES}
    assert kinds["confs-tech/2026"] == kinds["confs-tech/2027"] == "confs-tech-listing"
    assert kinds["linux-foundation"] == "linux-foundation"
    assert kinds["devpost/upcoming/1"] == "devpost"
    assert {"claude-community", "codex-community", "hf-builders"} <= set(kinds)
    hosts = " ".join(url for _, url, _ in cli.SOURCES)
    # Discovery-only by licence; musa's call, not an import.
    assert "developers.events" not in hosts and "dev.events" not in hosts


def test_confs_tech_listing_expands_to_fixed_raw_topic_files():
    found = cli.confs_tech_files(
        snap(cli.CONFS_TECH_LISTING.format(year=2027), listing("python.json", "tech-comm.json")),
        "confs-tech/2027",
    )
    assert found == [
        (
            "confs-tech/2027/python",
            "https://raw.githubusercontent.com/tech-conferences/conference-data/main/conferences/2027/python.json",
            "confs-tech",
        ),
        (
            "confs-tech/2027/tech-comm",
            "https://raw.githubusercontent.com/tech-conferences/conference-data/main/conferences/2027/tech-comm.json",
            "confs-tech",
        ),
    ]
    with pytest.raises(ValueError):
        cli.confs_tech_files(snap("https://api.github.com/x", listing("../evil.json")), "x/2026")


def test_devpost_first_page_expands_to_the_remaining_pages():
    first = snap(
        cli.DEVPOST_UPCOMING.format(page=1),
        json.dumps({"hackathons": [], "meta": {"total_count": 20, "per_page": 9}}),
    )
    assert [name for name, _, _ in cli.follow_on("devpost/upcoming/1", "devpost", first)] == [
        "devpost/upcoming/2",
        "devpost/upcoming/3",
    ]
    assert cli.follow_on("devpost/upcoming/2", "devpost", first) == []


@pytest.mark.parametrize(
    ("text", "dates"),
    [
        ("Nov 09 - 30, 2026", ("2026-11-09", "2026-11-30")),
        ("Jan 25 - Feb 11, 2027", ("2027-01-25", "2027-02-11")),
        ("Dec 19, 2026 - Jan 18, 2027", ("2026-12-19", "2027-01-18")),
        ("Dec 31, 2026", ("2026-12-31", "2026-12-31")),
        ("Dec 28 - Jan 03, 2027", None),
        ("Ongoing", None),
    ],
)
def test_devpost_submission_period(text, dates):
    assert devpost_dates(text) == dates


def test_linux_foundation_quotes_wordpress_escaped_source():
    text = json.dumps(
        [
            {
                "id": 225690,
                "name": "Cloud Native AI &amp; Inference Day",
                "description": "Not republished.",
                "date_start": "2026/11/09",
                "date_end": "2026/11/12",
                "external_url": "",
                "url": "https://events.linuxfoundation.org/kubecon/",
                "location": {"city": "Salt Lake City", "region": "UT", "country": "United States"},
                "cta_register_url": "https://events.linuxfoundation.org/kubecon/register/",
                "cta_speak_url": "https://events.linuxfoundation.org/kubecon/program/cfp/",
                "cfp_date_end": "2027/1/18",
            },
            {
                "id": 2,
                "name": "Open Compliance Summit",
                "date_start": "2026/12/10",
                "date_end": "2026/12/11",
                "url": "https://events.linuxfoundation.org/ocs/",
                "cta_speak_url": "https://events.linuxfoundation.org/ocs/cfp/",
                "cfp_date_end": "2026/08",
            },
            {"id": 3, "name": "Undated", "date_start": "2027/02", "date_end": ""},
        ]
    ).replace("/", "\\/")
    snapshot = snap("https://events.linuxfoundation.org/wp-json/lfevents/v1/events", text)
    event, month_only = linux_foundation(snapshot, now=NOW)
    assert "deadline" not in month_only["applications"][0]
    assert check_candidate(month_only, snapshot) == []
    assert (event["name"], event["start"], event["end"]) == (
        "Cloud Native AI & Inference Day",
        "2026-11-09",
        "2026-11-12",
    )
    assert event["url"] == "https://events.linuxfoundation.org/kubecon/"
    assert [a["type"] for a in event["applications"]] == ["register", "cfp"]
    assert event["applications"][1]["deadline"] == "2027-01-18"
    assert "description" not in json.dumps(event)
    assert check_candidate(event, snapshot) == []
    assert '"description"' in source_context(event, snapshot)
    assert "Salt Lake City UT United States" in location_context(source_context(event, snapshot))


def test_devpost_page_yields_hackathons_with_source_quotes():
    text = json.dumps(
        {
            "hackathons": [
                {
                    "id": 31808,
                    "title": "#BuildHybridAI 2026 - Internships & Prizes",
                    "displayed_location": {"icon": "globe", "location": "Online"},
                    "url": "https://firebasehybridaihackathon.devpost.com/",
                    "submission_period_dates": "Nov 09 - 30, 2026",
                    "prize_amount": "$30,000",
                },
                {"id": 1, "title": "Undated", "url": "https://x.devpost.com/"},
            ],
            "meta": {"total_count": 2, "per_page": 9},
        }
    ).replace("&", "\\u0026")  # Devpost's JSON is HTML-safe.
    snapshot = snap(cli.DEVPOST_UPCOMING.format(page=1), text)
    [event] = devpost(snapshot, now=NOW)
    assert event["name"] == "#BuildHybridAI 2026 - Internships & Prizes"
    assert (event["format"], event["start"], event["end"]) == (
        "hackathon",
        "2026-11-09",
        "2026-11-30",
    )
    assert event["applications"][0]["platform"] == "devpost"
    assert "prize" not in json.dumps(event)
    assert check_candidate(event, snapshot) == []
    assert "Online" in location_context(source_context(event, snapshot))


def test_first_wave_merges_one_conference_listed_under_several_topics(tmp_path, monkeypatch):
    row = {
        "name": "JSConf",
        "url": "https://example.org/jsconf",
        "startDate": "2026-12-01",
        "endDate": "2026-12-02",
        "city": "Berlin",
        "country": "Germany",
    }
    feeds = {
        cli.CONFS_TECH_LISTING.format(year=2026): listing("javascript.json", "typescript.json"),
        f"{cli.CONFS_TECH_RAW}/2026/javascript.json": json.dumps([row]),
        f"{cli.CONFS_TECH_RAW}/2026/typescript.json": json.dumps([row]),
    }
    batches = []

    class FakeGazetteer:
        manifest = {"fixture": True}

        def __init__(self, path):
            pass

        def write_manifest(self, path):
            path.write_text("{}")

    class FakeFetcher:
        def fetch(self, url):
            return snap(url, feeds[url])

    def batch(items, *args):
        batches.append([event["topics"] for event, _ in items])
        return [(event, []) for event, _ in items]

    monkeypatch.setattr(
        cli,
        "SOURCES",
        [("confs-tech/2026", cli.CONFS_TECH_LISTING.format(year=2026), "confs-tech-listing")],
    )
    monkeypatch.setattr(cli, "Gazetteer", FakeGazetteer)
    monkeypatch.setattr(cli, "Fetcher", FakeFetcher)
    monkeypatch.setattr(cli, "run_batch", batch)
    monkeypatch.setattr(cli, "check_candidate", lambda event, snapshot: [])
    monkeypatch.setattr(cli, "publish", lambda repo, events, schema, **kwargs: {"events": events})
    result = cli.run_first_wave(tmp_path / "work", tmp_path / "repo", admin1=tmp_path / "admin1")
    assert batches == [[["javascript", "typescript"]]]
    assert result["candidates"] == result["published"] == 1
    sources = {item["source"]: item for item in result["sources"]}
    assert sources["confs-tech/2026"]["expanded"] == 2
    assert sources["confs-tech/2026/typescript"]["merged_duplicates"] == 1
