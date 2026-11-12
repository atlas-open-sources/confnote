"""Local-only git publication and reproducible public data exports."""

import json
import re
import shutil
import subprocess
from datetime import datetime, timedelta
from pathlib import Path

from events_model import validate_catalogue, validate_event


def json_write(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def ical_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("\n", "\\n").replace(";", "\\;").replace(",", "\\,")


def ical_time(value: str, *, inclusive_end: bool = False) -> str:
    if len(value) == 10:
        day = datetime.fromisoformat(value)
        if inclusive_end:
            day += timedelta(days=1)
        return ";VALUE=DATE:" + day.strftime("%Y%m%d")
    from datetime import UTC

    return ":" + datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC).strftime(
        "%Y%m%dT%H%M%SZ"
    )


def calendar(events: list[dict]) -> str:
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//confnote//events v2//EN",
        "CALSCALE:GREGORIAN",
    ]
    for event in events:
        lines += [
            "BEGIN:VEVENT",
            f"UID:{event['id']}@confnote",
            "DTSTAMP:19700101T000000Z",
            "DTSTART" + ical_time(event["start"]),
            "DTEND" + ical_time(event["end"], inclusive_end=True),
            "SUMMARY:" + ical_escape(event["name"]),
        ]
        if event.get("city") or event.get("country"):
            lines.append(
                "LOCATION:"
                + ical_escape(
                    ", ".join(value for value in (event.get("city"), event.get("country")) if value)
                )
            )
        if event.get("status") == "cancelled":
            lines.append("STATUS:CANCELLED")
        if event.get("url"):
            lines.append("URL:" + event["url"])
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    # Fold by UTF-8 bytes, not code points (RFC 5545).
    folded = []
    for line in lines:
        current = ""
        for char in line:
            if len((current + char).encode()) > 75:
                folded.append(current)
                current = " "
            current += char
        folded.append(current)
    return "\r\n".join(folded) + "\r\n"


def build_dist(repo: Path) -> dict:
    events = [json.loads(path.read_text()) for path in sorted((repo / "events").glob("*/*.json"))]
    catalogue = {
        "schema_version": "events.catalogue.v2",
        "events": sorted(events, key=lambda event: (event["start"], event["id"])),
    }
    validate_catalogue(catalogue)
    output = repo / "dist"
    json_write(output / "index.json", catalogue)
    (output / "events.ndjson").write_text(
        "".join(json.dumps(event, ensure_ascii=False) + "\n" for event in catalogue["events"])
    )
    json_write(
        output / "applications.json",
        [
            {"event_id": event["id"], **application}
            for event in events
            for application in event["applications"]
        ],
    )
    (output / "events.ics").write_bytes(calendar(catalogue["events"]).encode())
    (output / "llms.txt").write_text(
        "# Open events catalogue\n\nFacts licensed CC-BY-4.0; source notices remain applicable.\n\n- [JSON](index.json)\n- [Applications](applications.json)\n- [iCalendar](events.ics)\n\nAlways verify deadlines on the original source.\n"
    )
    for name in ("ATTRIBUTION.md", "LICENSE", "confs-tech-LICENSE"):
        if (repo / name).is_file():
            shutil.copyfile(repo / name, output / name)
    geography_notice = repo / "taxonomy/geonames-sources.json"
    if geography_notice.is_file():
        shutil.copyfile(geography_notice, output / "geonames-sources.json")
    return catalogue


def publish(
    repo: Path,
    events: list[dict],
    schema: Path,
    *,
    commit: bool = True,
    withdraw: list[str] | None = None,
    gazetteer: dict | None = None,
) -> dict:
    for event in events:
        validate_event(event)
        for field in ("name", "start", "end"):
            if not event["provenance"].get(field):
                raise ValueError("publication requires field evidence")
        if not event["provenance"] or any(
            not item["check"]["passed"]
            or item["review"]["verdict"] != "agree"
            or item["extractor"]["agent"] == item["review"]["agent"]
            for records in event["provenance"].values()
            for item in records
        ):
            raise ValueError("publication requires checked and independently reviewed provenance")
    repo.mkdir(parents=True, exist_ok=True)
    if not (repo / ".git").exists():
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
    for folder in (
        "series",
        "events",
        "sessions",
        "people",
        "orgs",
        "venues",
        "taxonomy",
        "schema",
        "dist",
    ):
        (repo / folder).mkdir(exist_ok=True)
    shutil.copyfile(schema, repo / "schema/events-v2.schema.json")
    shutil.copyfile(schema.parent.parent / "taxonomy.json", repo / "taxonomy/index.json")
    (repo / "LICENSE").write_text(
        "Event facts: Creative Commons Attribution 4.0 International (CC-BY-4.0).\nhttps://creativecommons.org/licenses/by/4.0/legalcode\nSource licences and notices in ATTRIBUTION.md remain applicable.\n"
    )
    (repo / "ATTRIBUTION.md").write_text(
        "# Attribution\n\nCatalogue compiled by confnote. Every event retains source URLs and field evidence.\nLuma calendar facts are imported via public iCal subscriptions; no guest lists, biographies or descriptions are republished.\nconfs.tech data: MIT, tech-conferences/conference-data contributors. See source MIT notice when that source is published.\nLinux Foundation event facts (name, dates, links) come from the public events.linuxfoundation.org events feed; Devpost hackathon facts (name, submission period, link) from Devpost's public upcoming-hackathons listing. Facts and links only: no descriptions, images, logos or prize text are republished.\n"
    )
    if gazetteer:
        json_write(repo / "taxonomy/geonames-sources.json", gazetteer)
        with (repo / "ATTRIBUTION.md").open("a") as notice:
            notice.write(
                "\nGeography derives from GeoNames (https://www.geonames.org/), CC-BY-4.0. "
                "Cities1000 and countryInfo-derived countries are mirrored by geonamescache 3.0.2 "
                "(https://pypi.org/project/geonamescache/3.0.2/), software copyright Ramiro Gómez, MIT. "
                "Admin1 names use the panchicore/elasticsearch-geonames mirror. "
                "Mirror URLs, counts and exact SHA-256 hashes are in geonames-sources.json in dist "
                "(taxonomy/geonames-sources.json in the source repository). "
                "These are offline snapshots, not a claim of current administrative boundaries. "
                "Model interpretation selects a source-supported GeoNames place; no coordinates or raw gazetteer are republished.\n"
            )
    shutil.copyfile(
        Path(__file__).resolve().parents[1] / "confs-tech-LICENSE", repo / "confs-tech-LICENSE"
    )
    for event in events:
        json_write(repo / "events" / event["start"][:4] / (event["id"] + ".json"), event)
    for event_id in withdraw or []:
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,159}", event_id):
            raise ValueError("unsafe withdrawal id")
        for previous in (repo / "events").glob("*/" + event_id + ".json"):
            previous.unlink()
    catalogue = build_dist(repo)
    if commit:
        paths = [
            "events",
            "schema",
            "dist",
            "LICENSE",
            "ATTRIBUTION.md",
            "confs-tech-LICENSE",
            "taxonomy",
        ]
        subprocess.run(["git", "-C", str(repo), "add", "--", *paths], check=True)
        changed = subprocess.run(
            ["git", "-C", str(repo), "diff", "--cached", "--quiet", "--", *paths], check=False
        )
        if changed.returncode == 1:
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(repo),
                    "commit",
                    "-m",
                    "feat: publish reviewed event catalogue",
                    "--",
                    *paths,
                ],
                check=True,
            )
        elif changed.returncode != 0:
            raise RuntimeError("cannot inspect staged data publication")
    return catalogue
