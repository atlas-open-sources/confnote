"""Promote a URL submission only through the normal evidence and review gates."""

import json
from pathlib import Path

from events_model import validate_event

from .fetch import Snapshot
from .importers import evidence, identity
from .pipeline import extract_and_review, hold
from .publish import json_write


def review_submission(identifier: str, queue: Path, extractor, reviewer, fetcher) -> dict | None:
    if (
        not identifier.startswith("submission_")
        or len(identifier) != 35
        or any(char not in "0123456789abcdef" for char in identifier[11:])
    ):
        raise ValueError("invalid submission identifier")
    record_path = queue / "submissions" / (identifier + ".json")
    record = json.loads(record_path.read_text())
    if "content_hash" not in record:
        raise ValueError("link-only submissions cannot be extracted")
    snapshot = Snapshot(
        **json.loads(
            (
                queue / "snapshots" / (record["content_hash"].removeprefix("sha256:") + ".json")
            ).read_text()
        )
    )
    # Only the fetched public page enters the model. No vault content or filesystem tools.
    response = extractor.run(
        'Extract one event from SOURCE or return {"supported":false}. Return {"supported":true,"event":{"name":string,"start":ISO-date-or-offset-timestamp,"end":same-precision,"timezone":IANA-or-null,"url":source-url},"quotes":{"name":verbatim,"start":verbatim,"end":verbatim,"url":verbatim}}. Each quote <=200 chars. Unknown facts must not be guessed.\n'
        + json.dumps({"SOURCE_URL": snapshot.url, "SOURCE": snapshot.text[:60000]})
    )
    if response.get("supported") is not True:
        record["reason"] = "extractor could not support event facts"
        json_write(record_path, record)
        return None
    event = response["event"]
    if set(event) != {"name", "start", "end", "timezone", "url"}:
        raise ValueError("unexpected submission fields")
    event.update(
        id=identity("submission", snapshot.url),
        kind="event",
        category="tech",
        format="other",
        applications=[],
        topics=[],
        provenance={},
    )
    for field in ("name", "start", "end", "url"):
        quote = response["quotes"][field]
        if (
            not isinstance(quote, str)
            or not quote
            or len(quote) > 200
            or quote not in snapshot.text
        ):
            raise ValueError("unsupported submission quote")
        event["provenance"][field] = evidence(
            snapshot, quote, "page:quote", "user-submission", "facts"
        )
    validate_event(event)
    event, problems = extract_and_review(event, snapshot, extractor, reviewer, fetcher)
    if problems:
        hold(queue / "holds", event, problems)
        record["reason"] = "; ".join(problems)
        json_write(record_path, record)
        return None
    json_write(queue / "ready" / (event["id"] + ".json"), event)
    record.update(status="reviewed", event_id=event["id"])
    json_write(record_path, record)
    return event
