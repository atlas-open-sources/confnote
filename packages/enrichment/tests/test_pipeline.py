import hashlib
import json
from pathlib import Path

import pytest
from enrichment.cli import submit_url
from enrichment.fetch import Snapshot
from enrichment.importers import confs_tech, luma_ical
from enrichment.pipeline import check_candidate, extract_and_review
from enrichment.publish import calendar, publish

ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture
def snapshot():
    text = json.dumps(
        [
            {
                "name": "Python Days",
                "url": "https://example.com/event",
                "startDate": "2026-11-12",
                "endDate": "2026-11-14",
                "city": "London",
                "country": "GB",
            }
        ]
    )
    return Snapshot(
        "https://example.com/feed",
        "2026-11-01T00:00:00+00:00",
        "sha256:" + hashlib.sha256(text.encode()).hexdigest(),
        text,
    )


class Extractor:
    name = "extractor"

    def __init__(self, event):
        self.event = event

    def run(self, prompt):
        return {
            "supported": True,
            "fields": {
                field: {
                    "value": self.event[field],
                    "quote": self.event["provenance"][field][0]["quote"],
                }
                for field in ("name", "start", "end", "url")
            },
        }


class Reviewer:
    name = "reviewer"

    def __init__(self, verdict="agree"):
        self.verdict = verdict

    def run(self, prompt):
        return {"verdict": self.verdict, "reasons": []}


def test_valid_candidate_and_review(snapshot, tmp_path):
    event = confs_tech(snapshot, topic="python")[0]
    assert check_candidate(event, snapshot) == []
    event, errors = extract_and_review(event, snapshot, Extractor(event), Reviewer())
    assert errors == []
    result = publish(
        tmp_path / "data",
        [event],
        ROOT / "packages/events-model/schema/events-v2.schema.json",
        commit=False,
    )
    assert result["events"][0]["id"] == event["id"]
    assert "DTEND;VALUE=DATE:20261115" in (tmp_path / "data/dist/events.ics").read_text()


def test_quote_and_review_fail_closed(snapshot):
    event = confs_tech(snapshot, topic="python")[0]
    _, errors = extract_and_review(event, snapshot, Extractor(event), Reviewer("disagree"))
    assert "review disagreement" in errors
    event["provenance"]["name"][0]["quote"] = "injected unrelated claim"
    assert "quote absent: name" in check_candidate(event, snapshot)


def test_unreviewed_cannot_publish(snapshot, tmp_path):
    event = confs_tech(snapshot, topic="python")[0]
    with pytest.raises(ValueError, match="publication requires"):
        publish(
            tmp_path,
            [event],
            ROOT / "packages/events-model/schema/events-v2.schema.json",
            commit=False,
        )


def test_date_parse_and_id_safety(snapshot):
    event = confs_tech(snapshot, topic="python")[0]
    event["end"] = "2026-02-30"
    assert any(error.startswith("schema:") for error in check_candidate(event, snapshot))
    event["id"] = "../../escape"
    assert any(error.startswith("schema:") for error in check_candidate(event, snapshot))


def test_luma_folded_line_and_inclusive_all_day():
    body = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:abc@luma\r\nSUMMARY:Long\r\n  title\r\nDTSTART;VALUE=DATE:20261112\r\nDTEND;VALUE=DATE:20261115\r\nURL:https://luma.com/example\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
    snapshot = Snapshot(
        "https://example.com/feed",
        "2026-11-01T00:00:00Z",
        "sha256:" + hashlib.sha256(body.encode()).hexdigest(),
        body,
    )
    event = luma_ical(snapshot, program="claude-community")[0]
    assert event["name"] == "Long title"
    assert event["end"] == "2026-11-14"
    assert check_candidate(event, snapshot) == []
    assert "DTEND;VALUE=DATE:20261115" in calendar([event])


def test_restricted_submission_never_fetches(tmp_path):
    class Refuse:
        def fetch(self, url):
            pytest.fail("restricted host must be link-only")

    identifier = submit_url("https://partiful.com/e/test", tmp_path, Refuse())
    assert (
        json.loads((tmp_path / "submissions" / (identifier + ".json")).read_text())["reason"]
        == "link-only source"
    )


def test_extractor_cannot_change_facts(snapshot):
    event = confs_tech(snapshot, topic="python")[0]

    class Invented(Extractor):
        def run(self, prompt):
            result = super().run(prompt)
            result["fields"]["start"]["value"] = "2027-01-01"
            return result

    _, errors = extract_and_review(event, snapshot, Invented(event), Reviewer())
    assert errors == ["extractor disagreement: start"]


def test_missing_review_and_same_model_fail_closed(snapshot):
    event = confs_tech(snapshot, topic="python")[0]
    reviewer = Reviewer()
    reviewer.name = "extractor"
    _, errors = extract_and_review(event, snapshot, Extractor(event), reviewer)
    assert errors == ["extractor and reviewer must be different models"]


def test_cfplink_only_and_dist_escaping(snapshot):
    event = confs_tech(snapshot, topic="python")[0]
    assert event["applications"] == []
    event["name"] = "title\nINJECT:evil"
    output = calendar([event])
    assert "SUMMARY:title\\nINJECT:evil\r\n" in output
    assert "\r\nINJECT:evil" not in output


def test_pretalx_minimal_schedule():
    from enrichment.importers import pretalx

    text = json.dumps(
        {
            "schedule": {
                "conference": {
                    "title": "Open Event",
                    "acronym": "open-2026",
                    "start": "2026-11-10",
                    "end": "2026-11-12",
                    "time_zone_name": "Europe/London",
                }
            }
        }
    )
    snapshot = Snapshot(
        "https://example.com/schedule.json",
        "2026-11-01T00:00:00Z",
        "sha256:" + hashlib.sha256(text.encode()).hexdigest(),
        text,
    )
    event = pretalx(snapshot)[0]
    assert check_candidate(event, snapshot) == []
    assert event["timezone"] == "Europe/London"


def test_withdrawn_claim_removed_from_dist(snapshot, tmp_path):
    event = confs_tech(snapshot, topic="python")[0]
    event, _ = extract_and_review(event, snapshot, Extractor(event), Reviewer())
    schema = ROOT / "packages/events-model/schema/events-v2.schema.json"
    publish(tmp_path, [event], schema, commit=False)
    result = publish(tmp_path, [], schema, commit=False, withdraw=[event["id"]])
    assert result["events"] == []
    assert list((tmp_path / "events").glob("*/*.json")) == []


def test_submission_id_refuses_path_traversal(tmp_path):
    from enrichment.submission import review_submission

    with pytest.raises(ValueError, match="identifier"):
        review_submission("../private", tmp_path, None, None, None)


def test_publication_rejects_self_review(snapshot, tmp_path):
    event = confs_tech(snapshot, topic="python")[0]
    event, _ = extract_and_review(event, snapshot, Extractor(event), Reviewer())
    event["provenance"]["name"][0]["review"]["agent"] = "extractor"
    with pytest.raises(ValueError, match="independently reviewed"):
        publish(
            tmp_path,
            [event],
            ROOT / "packages/events-model/schema/events-v2.schema.json",
            commit=False,
        )


def test_tampered_snapshot_hash_rejected(snapshot):
    event = confs_tech(snapshot, topic="python")[0]
    altered = Snapshot(
        snapshot.url, snapshot.fetched_at, snapshot.content_hash, snapshot.text + "changed"
    )
    assert "snapshot content hash mismatch" in check_candidate(event, altered)
