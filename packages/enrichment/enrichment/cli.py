"""URL submission and complete first-wave batch review entry points."""

import argparse
import hashlib
import json
import math
import re
import sys
from pathlib import Path

from .batch import run_batch
from .fetch import Fetcher, Snapshot
from .gazetteer import Gazetteer
from .importers import confs_tech, devpost, linux_foundation, luma_ical
from .pipeline import check_candidate, hold
from .publish import json_write, publish
from .runner import ClaudeRunner, CodexRunner

CONFS_TECH_RAW = (
    "https://raw.githubusercontent.com/tech-conferences/conference-data/main/conferences"
)
CONFS_TECH_LISTING = (
    "https://api.github.com/repos/tech-conferences/conference-data/contents/conferences/{year}"
)
DEVPOST_UPCOMING = "https://devpost.com/api/hackathons?status%5B%5D=upcoming&page={page}"
DEVPOST_MAX_PAGES = 40

# Listing kinds expand at run time into the sources they name; every other kind yields candidates.
# python.org's Python Events calendar is not here: its Google Calendar iCal redirects to
# calendar.google.com, whose robots.txt disallows everything but "/", so the fetcher fails closed.
SOURCES = [
    (
        "claude-community",
        "https://api.lu.ma/ics/get?entity=calendar&id=cal-TOpA5LAFfuDeFpu",
        "ical",
    ),
    ("codex-community", "https://api.lu.ma/ics/get?entity=calendar&id=cal-63UOFcweB97l2gc", "ical"),
    ("hf-builders", "https://api.lu.ma/ics/get?entity=calendar&id=cal-OyNN7ZZW5axQrBr", "ical"),
    ("confs-tech/2026", CONFS_TECH_LISTING.format(year=2026), "confs-tech-listing"),
    ("confs-tech/2027", CONFS_TECH_LISTING.format(year=2027), "confs-tech-listing"),
    (
        "linux-foundation",
        "https://events.linuxfoundation.org/wp-json/lfevents/v1/events",
        "linux-foundation",
    ),
    ("devpost/upcoming/1", DEVPOST_UPCOMING.format(page=1), "devpost"),
]


def confs_tech_files(listing: Snapshot, name: str) -> list[tuple[str, str, str]]:
    """Every topic file a confs.tech year listing names, fetched from the fixed raw origin."""
    year = name.rsplit("/", 1)[-1]
    if not re.fullmatch(r"\d{4}", year):
        raise ValueError("confs.tech listing name must end in a year")
    files = sorted(
        item["name"]
        for item in json.loads(listing.text)
        if item.get("type") == "file" and re.fullmatch(r"[a-z0-9][a-z0-9-]*\.json", item["name"])
    )
    if not files:
        raise ValueError("confs.tech listing names no topic files")
    return [
        (f"{name}/{file.removesuffix('.json')}", f"{CONFS_TECH_RAW}/{year}/{file}", "confs-tech")
        for file in files
    ]


def devpost_pages(first: Snapshot) -> list[tuple[str, str, str]]:
    """The remaining upcoming-hackathon pages, from the first page's paging metadata."""
    meta = json.loads(first.text)["meta"]
    pages = min(math.ceil(meta["total_count"] / meta["per_page"]), DEVPOST_MAX_PAGES)
    return [
        (f"devpost/upcoming/{page}", DEVPOST_UPCOMING.format(page=page), "devpost")
        for page in range(2, pages + 1)
    ]


def follow_on(name: str, kind: str, snapshot: Snapshot) -> list[tuple[str, str, str]]:
    if kind == "confs-tech-listing":
        return confs_tech_files(snapshot, name)
    if kind == "devpost" and name.endswith("/1"):
        return devpost_pages(snapshot)
    return []


def source_candidates(name: str, kind: str, snapshot: Snapshot) -> list[dict]:
    if kind == "ical":
        return luma_ical(snapshot, program=name)
    if kind == "confs-tech":
        return confs_tech(snapshot, topic=name.rsplit("/", 1)[-1])
    if kind == "linux-foundation":
        return linux_foundation(snapshot)
    if kind == "devpost":
        return devpost(snapshot)
    if kind == "confs-tech-listing":
        return []
    raise ValueError("unknown source kind: " + kind)


def submit_url(url: str, queue: Path, fetcher: Fetcher | None = None) -> str:
    """Fetch one public submitted URL, save evidence, queue for the same review gate.

    Submissions never bypass source terms, robots or the review queue. Restrictive
    platforms are link-only: they are recorded without fetching their page.
    """
    from urllib.parse import urlsplit

    identifier = "submission_" + hashlib.sha256(url.encode()).hexdigest()[:24]
    host = (urlsplit(url).hostname or "").lower()
    link_only = any(
        host == domain or host.endswith("." + domain)
        for domain in ("partiful.com", "eventbrite.com", "meetup.com", "tech-week.com")
    )
    value = {
        "id": identifier,
        "url": url,
        "status": "held",
        "reason": "link-only source" if link_only else "pending extraction and independent review",
    }
    if not link_only:
        snapshot = (fetcher or Fetcher()).fetch(url)
        snapshot.save(queue / "snapshots")
        value["content_hash"] = snapshot.content_hash
    json_write(queue / "submissions" / (identifier + ".json"), value)
    return identifier


def run_first_wave(
    work: Path, repo: Path, *, admin1: Path, batch_size: int = 25, replay: bool = False
) -> dict:
    fetcher = Fetcher()
    extractor, reviewer = ClaudeRunner(), CodexRunner()
    gazetteer = Gazetteer(admin1)
    source_results = []
    groups = []
    approved = []
    held_count = 0
    held_ids = []
    work.mkdir(parents=True, exist_ok=True)
    seen = {}
    queue = list(SOURCES)
    while queue:
        name, url, kind = queue.pop(0)
        record = {"source": name, "url": url, "candidates": 0}
        try:
            if replay:
                saved = [
                    json.loads(path.read_text()) for path in (work / "snapshots").glob("*.json")
                ]
                matches = [item for item in saved if item["url"] == url]
                if not matches:
                    raise ValueError("no recorded source snapshot")
                snapshot = Snapshot(**max(matches, key=lambda item: item["fetched_at"]))
            else:
                snapshot = fetcher.fetch(url)
            snapshot.save(work / "snapshots")
            expanded = follow_on(name, kind, snapshot)
            queue[:0] = expanded
            candidates = source_candidates(name, kind, snapshot)
            record.update(candidates=len(candidates), content_hash=snapshot.content_hash)
            if expanded:
                record["expanded"] = len(expanded)
            group = []
            for candidate in sorted(candidates, key=lambda event: event["start"], reverse=True):
                first = seen.get(candidate["id"])
                if first is None:
                    seen[candidate["id"]] = candidate
                    group.append((candidate, snapshot))
                    continue
                # One conference in several confs.tech topic files is one event with every topic.
                first["topics"] += [t for t in candidate["topics"] if t not in first["topics"]]
                record["merged_duplicates"] = record.get("merged_duplicates", 0) + 1
            groups.append(group)
        except Exception as exc:
            record["error"] = f"{type(exc).__name__}: {exc}"
        source_results.append(record)
    # Round-robin: sample across sources rather than spending the whole budget on the first feed.
    candidates = []
    while any(groups):
        for group in groups:
            if group:
                candidates.append(group.pop(0))
    gazetteer.write_manifest(work / "gazetteer.json")
    pipeline_revision = hashlib.sha256(
        b"".join(path.read_bytes() for path in sorted(Path(__file__).parent.glob("*.py")))
    ).hexdigest()
    link_path = work / "links.json"
    links = json.loads(link_path.read_text()) if link_path.exists() else {}
    for start in range(0, len(candidates), batch_size):
        batch = candidates[start : start + batch_size]
        audit = work / "batches" / f"{start // batch_size:03d}"
        signature = hashlib.sha256(
            json.dumps(
                [pipeline_revision, gazetteer.manifest, batch],
                default=lambda x: x.__dict__,
                sort_keys=True,
            ).encode()
        ).hexdigest()
        saved = audit / "result.json"
        cached = json.loads(saved.read_text()) if saved.exists() else {}
        if cached.get("signature") == signature:
            results = cached["results"]
        else:
            print(
                f"Batch {start // batch_size + 1}: candidates {start + 1}–{start + len(batch)} of {len(candidates)}",
                flush=True,
            )
            try:
                results = run_batch(batch, gazetteer, extractor, reviewer, audit)
            except Exception as exc:
                results = [
                    (event, [f"batch runner: {type(exc).__name__}: {exc}"]) for event, _ in batch
                ]
            # Retry failed records independently in smaller groups, without limiting coverage.
            failed = [
                (original, snap)
                for (original, snap), (_, reasons) in zip(batch, results, strict=True)
                if reasons
            ]
            if failed:
                try:
                    retry = run_batch(failed, gazetteer, extractor, reviewer, audit / "retry")
                    replacement = {event["id"]: (event, reasons) for event, reasons in retry}
                    results = [
                        replacement.get(event["id"], (event, reasons)) for event, reasons in results
                    ]
                except Exception as exc:
                    json_write(
                        audit / "retry-error.json", {"error": f"{type(exc).__name__}: {exc}"}
                    )
            json_write(saved, {"signature": signature, "results": results})
        for (candidate, reasons), (_, snapshot) in zip(results, batch, strict=True):
            if not reasons:
                reasons = check_candidate(candidate, snapshot)
            if not reasons:
                urls = {candidate["url"]} if candidate.get("url") else set()
                urls.update(application["url"] for application in candidate.get("applications", []))
                unavailable = []
                for url in sorted(urls):
                    if url not in links:
                        try:
                            fetcher.fetch(url)
                            links[url] = {"passed": True}
                        except Exception as exc:
                            links[url] = {"passed": False, "reason": f"{type(exc).__name__}: {exc}"}
                        json_write(link_path, links)
                    if not links[url]["passed"]:
                        unavailable.append(url)
                # An unavailable optional destination must not suppress verified required facts.
                if candidate.get("url") in unavailable:
                    candidate.pop("url")
                    candidate["provenance"].pop("url", None)
                if any(app["url"] in unavailable for app in candidate.get("applications", [])):
                    candidate["applications"] = []
                    candidate["provenance"].pop("applications", None)
                if unavailable:
                    json_write(
                        work / "optional-omissions" / (candidate["id"] + ".json"),
                        {"unavailable_links": {url: links[url] for url in unavailable}},
                    )
            if reasons:
                hold(work / "holds", candidate, reasons)
                held_count += 1
                held_ids.append(candidate["id"])
            else:
                approved.append(candidate)
                json_write(work / "ready" / (candidate["id"] + ".json"), candidate)
                old_hold = work / "holds" / (candidate["id"] + ".json")
                if old_hold.exists():
                    old_hold.unlink()
            json_write(
                work / "progress.json",
                {
                    "processed": len(approved) + held_count,
                    "approved": len(approved),
                    "held": held_count,
                },
            )
        print(
            f"Processed {len(approved) + held_count}: approved={len(approved)}, held={held_count}",
            flush=True,
        )
    schema = Path(__file__).resolve().parents[2] / "events-model/schema/events-v2.schema.json"
    catalogue = publish(repo, approved, schema, withdraw=held_ids, gazetteer=gazetteer.manifest)
    result = {
        "sources": source_results,
        "candidates": len(candidates),
        "review_attempted": len(candidates),
        "batch_size": batch_size,
        "gazetteer": gazetteer.manifest,
        "published": len(approved),
        "catalogue_total": len(catalogue["events"]),
        "held": held_count,
        "samples": approved[:10],
    }
    json_write(work / "run.json", result)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    first = commands.add_parser("first-wave")
    first.add_argument("--work", type=Path, required=True)
    first.add_argument("--repo", type=Path, required=True)
    first.add_argument("--batch-size", type=int, default=25)
    first.add_argument("--admin1", type=Path, required=True)
    first.add_argument(
        "--replay",
        action="store_true",
        help="reuse saved source snapshots; still check changed candidates and links",
    )
    submit = commands.add_parser("submit")
    submit.add_argument("url")
    submit.add_argument("--queue", type=Path, required=True)
    review = commands.add_parser("review-submission")
    review.add_argument("identifier")
    review.add_argument("--queue", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "submit":
        print(submit_url(args.url, args.queue))
    elif args.command == "review-submission":
        from .submission import review_submission

        event = review_submission(
            args.identifier, args.queue, ClaudeRunner(), CodexRunner(), Fetcher()
        )
        print(json.dumps(event))
    else:
        if args.batch_size < 1 or args.batch_size > 50:
            parser.error("batch size must be between 1 and 50 (all candidates are processed)")
        result = run_first_wave(
            args.work, args.repo, admin1=args.admin1, batch_size=args.batch_size, replay=args.replay
        )
        print(
            json.dumps({key: value for key, value in result.items() if key != "samples"}, indent=2)
        )
        if result["published"] < 10:
            sys.exit(2)
