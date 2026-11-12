"""Deterministic gates around untrusted extraction and independent review."""

import copy
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path

from events_model import validate_event

from .fetch import Fetcher, Snapshot
from .runner import Runner

CORE_FIELDS = ("name", "start", "end", "url")


def check_candidate(event: dict, snapshot: Snapshot, fetcher: Fetcher | None = None) -> list[str]:
    problems = []
    if (
        "sha256:" + hashlib.sha256(snapshot.text.encode(snapshot.encoding)).hexdigest()
        != snapshot.content_hash
    ):
        problems.append("snapshot content hash mismatch")
    try:
        validate_event(event)
    except ValueError as exc:
        problems.append("schema: " + str(exc))
    for field in CORE_FIELDS:
        if field in event and not event.get("provenance", {}).get(field):
            problems.append("missing evidence: " + field)
    for field, records in event.get("provenance", {}).items():
        if not records:
            problems.append("empty evidence: " + field)
        for record in records:
            if not record["quote"] or record["quote"] not in snapshot.text:
                problems.append("quote absent: " + field)
            if (
                record["content_hash"] != snapshot.content_hash
                or record["source_url"] != snapshot.url
            ):
                problems.append("snapshot mismatch: " + field)
    if fetcher:
        urls = {event["url"]} if event.get("url") else set()
        urls.update(application["url"] for application in event.get("applications", []))
        for url in sorted(urls):
            try:
                fetcher.fetch(url)
            except Exception as exc:
                problems.append(f"link unavailable: {url}: {type(exc).__name__}: {exc}")
    return problems


def extract_and_review(
    event: dict,
    snapshot: Snapshot,
    extractor: Runner,
    reviewer: Runner,
    fetcher: Fetcher | None = None,
) -> tuple[dict, list[str]]:
    if extractor.name == reviewer.name:
        return event, ["extractor and reviewer must be different models"]
    candidate = copy.deepcopy(event)
    # Limit model context to physical source evidence. Full snapshot remains the deterministic authority.
    source = "\n".join(
        dict.fromkeys(
            record["quote"] for records in event["provenance"].values() for record in records
        )
    )
    fields = {key: value for key, value in event.items() if key in CORE_FIELDS}
    prompt = (
        'Extract every CANDIDATE field from SOURCE. Preserve ISO date normalization. Return {"fields": {field: {"value": value, "quote": verbatim_source_quote}}, "supported": true|false}. No additional fields.\n'
        + json.dumps({"CANDIDATE": fields, "SOURCE": source})
    )
    extraction = extractor.run(prompt)
    if extraction.get("supported") is not True or set(extraction.get("fields", {})) != set(fields):
        return candidate, ["extractor did not support every requested field"]
    for field, claim in extraction["fields"].items():
        if claim.get("value") != candidate[field]:
            return candidate, ["extractor disagreement: " + field]
        quote = claim.get("quote")
        if (
            not isinstance(quote, str)
            or not quote
            or len(quote) > 200
            or quote not in snapshot.text
        ):
            return candidate, ["extractor quote absent: " + field]
        record = candidate["provenance"][field][0]
        record["quote"] = quote
        record["extractor"] = {
            "agent": extractor.name,
            "prompt_rev": "extract-v1",
            "run": snapshot.content_hash,
        }
    problems = check_candidate(candidate, snapshot, fetcher)
    if problems:
        return candidate, problems
    review = reviewer.run(
        'Independently check CANDIDATE against SOURCE. Dates may be normalized to ISO. iCal all-day DTEND is exclusive but candidate date-only end is inclusive. Registry category/format/program/topic and generated IDs are configured metadata, not source assertions. City/ISO country/IANA timezone are deterministically derived with a bounded offline city gazetteer from LOCATION/SUMMARY evidence; UTC start/end instants stay unchanged. Online attendance has no physical city. Null/absent geography means deliberately unknown: do not reject a record for incomplete city-table coverage and do not infer missing fields. Known ambiguous names such as bare Sydney and London require explicit country context. Status is cancelled for source CANCELLED, postponed for POSTPONED, completed when the end has passed AS_OF, otherwise scheduled (including source TENTATIVE). Date-only end is inclusive in the local timezone; unknown timezone uses UTC. Return {"verdict": "agree"|"disagree", "reasons": [strings]}. Approve only supported source facts and matching quotes.\n'
        + json.dumps(
            {"CANDIDATE": candidate, "SOURCE": source, "AS_OF": datetime.now(UTC).isoformat()}
        )
    )
    if review.get("verdict") != "agree":
        return candidate, ["review disagreement", *review.get("reasons", [])]
    for records in candidate["provenance"].values():
        for record in records:
            record["check"] = {"rule": "quote-in-snapshot+schema-date+links", "passed": True}
            record["review"] = {
                "agent": reviewer.name,
                "verdict": "agree",
                "at": datetime.now(UTC).isoformat(),
            }
    validate_event(candidate)
    return candidate, []


def hold(directory: Path, event: dict, reasons: list[str]) -> None:
    # Validator checks IDs before any ID is used as a path.
    validate_event(event)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / (event["id"] + ".json")).write_text(
        json.dumps({"event": event, "reasons": reasons}, ensure_ascii=False, indent=2) + "\n"
    )
