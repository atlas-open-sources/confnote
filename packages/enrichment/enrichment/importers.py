"""Deterministic candidate adapters. Candidates are never implicitly published."""

import hashlib
import html
import json
import re
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from .fetch import Snapshot
from .geography import COUNTRIES, event_status, normalized, resolve_place


def identity(namespace: str, value: str) -> str:
    return "evt_" + namespace + "_" + hashlib.sha256(value.encode()).hexdigest()[:24]


def evidence(
    snapshot: Snapshot, quote: str, locator: str, source_type: str, license_id: str
) -> list[dict]:
    return [
        {
            "source_url": snapshot.url,
            "source_type": source_type,
            "fetched_at": snapshot.fetched_at,
            "content_hash": snapshot.content_hash,
            "quote": quote[:200],
            "locator": locator,
            "extractor": {
                "agent": "deterministic-importer",
                "prompt_rev": "v1",
                "run": snapshot.content_hash,
            },
            "check": {"rule": "pending", "passed": False},
            "review": {"agent": "pending", "verdict": "pending", "at": snapshot.fetched_at},
            "license": license_id,
        }
    ]


def base_event(event_id: str, name: str, start: str, end: str) -> dict:
    return {
        "id": event_id,
        "kind": "event",
        "name": name,
        "category": "tech",
        "format": "other",
        "start": start,
        "end": end,
        "timezone": None,
        "applications": [],
        "topics": [],
        "provenance": {},
    }


def ical_date(value: str, params: str) -> str:
    if re.fullmatch(r"\d{8}", value):
        return datetime.strptime(value, "%Y%m%d").date().isoformat()
    if value.endswith("Z"):
        return datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC).isoformat()
    match = re.search(r"TZID=([^;:]+)", params)
    if not match:
        raise ValueError("floating iCal time has no timezone")
    return (
        datetime.strptime(value, "%Y%m%dT%H%M%S")
        .replace(tzinfo=ZoneInfo(match[1].strip('"')))
        .isoformat()
    )


def unescape(value: str) -> str:
    return re.sub(r"\\([nN,;\\])", lambda m: "\n" if m[1].lower() == "n" else m[1], value)


def luma_ical(
    snapshot: Snapshot, *, program: str | None = None, now: datetime | None = None
) -> list[dict]:
    events = []
    # Preserve physical source quotes while unfolding logical RFC 5545 content lines.
    for block in re.findall(r"BEGIN:VEVENT\r?\n(.*?)END:VEVENT", snapshot.text, re.S):
        fields = {}
        for physical in re.split(r"\r?\n(?![ \t])", block):
            line = re.sub(r"\r?\n[ \t]", "", physical)
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            fields[key.split(";", 1)[0]] = (value, key, physical)
        if not {"UID", "SUMMARY", "DTSTART", "DTEND"}.issubset(fields):
            continue
        start = ical_date(*fields["DTSTART"][:2])
        end = ical_date(*fields["DTEND"][:2])
        if len(end) == 10:  # iCal all-day DTEND is exclusive; model dates are inclusive.
            end = (datetime.fromisoformat(end) - timedelta(days=1)).date().isoformat()
        event = base_event(
            identity("luma", fields["UID"][0]), unescape(fields["SUMMARY"][0]), start, end
        )
        if program:
            event["program"] = program
        url = fields.get("URL", (None,))[0]
        if not url:
            match = re.search(
                r"https://(?:lu\.ma|luma\.com)/[A-Za-z0-9._/-]+",
                fields.get("DESCRIPTION", ("",))[0],
            )
            url = match[0] if match else None
        if url:
            event["url"] = url
            event["applications"] = [
                {
                    "type": "register",
                    "url": url,
                    "platform": "luma",
                    "approval": "unknown",
                    "status": "unknown",
                }
            ]
        for target, source in (("name", "SUMMARY"), ("start", "DTSTART"), ("end", "DTEND")):
            event["provenance"][target] = evidence(
                snapshot, fields[source][2], "ical:" + source, "ical", "facts"
            )
        if url:
            folded_url = re.search(r"(?:\r?\n[ \t])?".join(re.escape(char) for char in url), block)
            url_quote = folded_url[0] if folded_url else url
            event["provenance"]["url"] = evidence(
                snapshot, url_quote, "ical:URL-or-DESCRIPTION", "ical", "facts"
            )
            event["provenance"]["applications"] = evidence(
                snapshot, url_quote, "ical:URL-or-DESCRIPTION", "ical", "facts"
            )
        place, source = resolve_place(unescape(fields.get("LOCATION", ("",))[0]), event["name"])
        event.update(place)
        if source:
            quote = fields[source][2]
            for field in place:
                event["provenance"][field] = evidence(
                    snapshot, quote, "ical:" + source + "+offline-gazetteer-v1", "ical", "facts"
                )
                # Ambiguous city disambiguation may also depend on a country in LOCATION.
                if (
                    source == "SUMMARY"
                    and fields.get("LOCATION")
                    and not fields["LOCATION"][0].startswith("http")
                ):
                    event["provenance"][field] += evidence(
                        snapshot, fields["LOCATION"][2], "ical:LOCATION", "ical", "facts"
                    )
        event["status"] = event_status(
            end, fields.get("STATUS", (None,))[0], now=now, timezone=event["timezone"]
        )
        event["provenance"]["status"] = evidence(
            snapshot, fields["DTEND"][2], "ical:DTEND+status-clock-v1", "ical", "facts"
        )
        if "STATUS" in fields:
            event["provenance"]["status"] += evidence(
                snapshot, fields["STATUS"][2], "ical:STATUS", "ical", "facts"
            )
        events.append(event)
    return events


def confs_tech(snapshot: Snapshot, *, topic: str, now: datetime | None = None) -> list[dict]:
    events = []
    for row in json.loads(snapshot.text):
        event = base_event(
            identity("confs", row["url"] + row["startDate"]),
            row["name"],
            row["startDate"],
            row.get("endDate", row["startDate"]),
        )
        event.update(format="conference", url=row["url"], topics=[topic])
        for target, source in (
            ("name", "name"),
            ("start", "startDate"),
            ("end", "endDate"),
            ("url", "url"),
            ("city", "city"),
            ("country", "country"),
        ):
            if source in row:
                event[target] = row[source]
                quote = json.dumps(row[source], ensure_ascii=False)
                if quote not in snapshot.text:
                    quote = json.dumps(row[source], ensure_ascii=True)
                event["provenance"][target] = evidence(
                    snapshot, quote, f"json:{source}", "json-feed", "MIT"
                )
        event["applications"] = []
        if row.get("cfpUrl"):
            application = {"type": "cfp", "url": row["cfpUrl"], "status": "unknown"}
            if row.get("cfpEndDate"):
                application["deadline"] = row["cfpEndDate"]
            event["applications"].append(application)
        for source in ("cfpUrl", "cfpEndDate"):
            if row.get(source):
                event["provenance"].setdefault("applications", []).extend(
                    evidence(
                        snapshot, json.dumps(row[source]), f"json:{source}", "json-feed", "MIT"
                    )
                )
        if row.get("online") is True:
            event["attendance_mode"] = "online"
            event.pop("city", None)
            event.pop("country", None)
            event["provenance"].pop("city", None)
            event["provenance"].pop("country", None)
            event["provenance"]["attendance_mode"] = evidence(
                snapshot,
                "true",
                "json:online",
                "json-feed",
                "MIT",
            )
        else:
            source_country = row.get("country", "")
            country_code = next(
                (
                    code
                    for code, names in COUNTRIES.items()
                    if normalized(source_country) in names or source_country == code
                ),
                None,
            )
            if country_code:
                event["country"] = country_code
            elif source_country:
                event.pop("country", None)
                event["provenance"].pop("country", None)
            place, _ = resolve_place(
                row.get("city", "")
                + ", "
                + (COUNTRIES[country_code][0] if country_code else source_country),
                "",
            )
            if place.get("city"):
                event.update(place)
                event["provenance"]["timezone"] = evidence(
                    snapshot,
                    json.dumps(row["city"]),
                    "json:city+offline-gazetteer-v1",
                    "json-feed",
                    "MIT",
                )
        event["status"] = event_status(
            event["end"], row.get("status"), now=now, timezone=event["timezone"]
        )
        event["provenance"]["status"] = list(
            event["provenance"].get("end", event["provenance"]["start"])
        )
        if row.get("status"):
            event["provenance"]["status"] += evidence(
                snapshot, json.dumps(row["status"]), "json:status", "json-feed", "MIT"
            )
        events.append(event)
    return events


HTML_SAFE_JSON = {"&": "\\u0026", "<": "\\u003c", ">": "\\u003e"}


def json_quote(snapshot: Snapshot, value: object) -> str:
    """The value as the source JSON spells it: WordPress escapes '/', Rails escapes '&<>',
    some feeds escape non-ASCII."""
    for spelled in (json.dumps(value, ensure_ascii=False), json.dumps(value)):
        html_safe = spelled
        for char, escaped in HTML_SAFE_JSON.items():
            html_safe = html_safe.replace(char, escaped)
        for quote in (spelled, spelled.replace("/", "\\/"), html_safe):
            if quote in snapshot.text:
                return quote
    # An absent quote fails the deterministic check and holds the event.
    return json.dumps(value, ensure_ascii=False)


def json_evidence(snapshot: Snapshot, value: object, source: str) -> list[dict]:
    return evidence(snapshot, json_quote(snapshot, value), f"json:{source}", "json-feed", "facts")


def row_identity(row: dict) -> str | None:
    """The candidate ID a structured JSON source row produces, so review can find its context."""
    if isinstance(row.get("url"), str) and isinstance(row.get("startDate"), str):
        return identity("confs", row["url"] + row["startDate"])
    if "date_start" in row and "id" in row:
        return identity("lf", str(row["id"]))
    if "submission_period_dates" in row and "id" in row:
        return identity("devpost", str(row["id"]))
    return None


def lf_date(value: str | None) -> str | None:
    """A full Linux Foundation "2027/1/18" date; month-only values like "2026/08" are not dates."""
    try:
        return datetime.strptime(value or "", "%Y/%m/%d").date().isoformat()
    except ValueError:
        return None


def linux_foundation(snapshot: Snapshot, *, now: datetime | None = None) -> list[dict]:
    """Linux Foundation events JSON: facts and links only, never descriptions or images."""
    events = []
    for row in json.loads(snapshot.text):
        start, end = lf_date(row.get("date_start")), lf_date(row.get("date_end"))
        if not (row.get("id") and row.get("name") and start and end):
            continue
        event = base_event(identity("lf", str(row["id"])), html.unescape(row["name"]), start, end)
        event["format"] = "conference"
        for target, source in (("name", "name"), ("start", "date_start"), ("end", "date_end")):
            event["provenance"][target] = json_evidence(snapshot, row[source], source)
        url_source = "external_url" if row.get("external_url") else "url"
        if row.get(url_source):
            event["url"] = row[url_source]
            event["provenance"]["url"] = json_evidence(snapshot, row[url_source], url_source)
        if row.get("cta_register_url"):
            event["applications"].append(
                {
                    "type": "register",
                    "url": row["cta_register_url"],
                    "platform": "own-site",
                    "approval": "unknown",
                    "status": "unknown",
                }
            )
            event["provenance"].setdefault("applications", []).extend(
                json_evidence(snapshot, row["cta_register_url"], "cta_register_url")
            )
        if row.get("cta_speak_url"):
            application = {"type": "cfp", "url": row["cta_speak_url"], "status": "unknown"}
            event["provenance"].setdefault("applications", []).extend(
                json_evidence(snapshot, row["cta_speak_url"], "cta_speak_url")
            )
            if lf_date(row.get("cfp_date_end")):
                application["deadline"] = lf_date(row["cfp_date_end"])
                event["provenance"]["applications"] += json_evidence(
                    snapshot, row["cfp_date_end"], "cfp_date_end"
                )
            event["applications"].append(application)
        event["status"] = event_status(end, None, now=now, timezone=None)
        event["provenance"]["status"] = list(event["provenance"]["end"])
        events.append(event)
    return events


DEVPOST_DATES = re.compile(
    r"(?P<m1>[A-Z][a-z]{2}) (?P<d1>\d{1,2})(?:, (?P<y1>\d{4}))?"
    r"(?: - (?:(?P<m2>[A-Z][a-z]{2}) )?(?P<d2>\d{1,2}), (?P<y2>\d{4}))?"
)


def devpost_dates(text: str) -> tuple[str, str] | None:
    """Devpost's submission period: "Nov 09 - 30, 2026", "Dec 19, 2026 - Jan 18, 2027", "Dec 31, 2026"."""
    match = DEVPOST_DATES.fullmatch(text.strip())
    if not match or not (match["y1"] or match["y2"]):
        return None
    start_year = match["y1"] or match["y2"]
    end_year = match["y2"] or match["y1"]
    try:
        start = datetime.strptime(f"{match['m1']} {match['d1']} {start_year}", "%b %d %Y").date()
        end = datetime.strptime(
            f"{match['m2'] or match['m1']} {match['d2'] or match['d1']} {end_year}", "%b %d %Y"
        ).date()
    except ValueError:
        return None
    if end < start:
        return None
    return start.isoformat(), end.isoformat()


def devpost(snapshot: Snapshot, *, now: datetime | None = None) -> list[dict]:
    """One page of Devpost's upcoming hackathons: name, submission period and link only."""
    events = []
    for row in json.loads(snapshot.text).get("hackathons", []):
        dates = devpost_dates(row.get("submission_period_dates") or "")
        if not (row.get("id") and row.get("title") and row.get("url") and dates):
            continue
        event = base_event(identity("devpost", str(row["id"])), html.unescape(row["title"]), *dates)
        event.update(format="hackathon", url=row["url"])
        event["applications"] = [
            {
                "type": "register",
                "url": row["url"],
                "platform": "devpost",
                "approval": "unknown",
                "status": "unknown",
            }
        ]
        event["provenance"]["name"] = json_evidence(snapshot, row["title"], "title")
        for target in ("start", "end"):
            event["provenance"][target] = json_evidence(
                snapshot, row["submission_period_dates"], "submission_period_dates"
            )
        for target in ("url", "applications"):
            event["provenance"][target] = json_evidence(snapshot, row["url"], "url")
        event["status"] = event_status(event["end"], None, now=now, timezone=None)
        event["provenance"]["status"] = list(event["provenance"]["end"])
        events.append(event)
    return events


def pretalx(snapshot: Snapshot, *, now: datetime | None = None) -> list[dict]:
    document = json.loads(snapshot.text)
    conference = document["schedule"]["conference"]
    event = base_event(
        identity("pretalx", conference.get("acronym", conference["title"])),
        conference["title"],
        conference["start"],
        conference["end"],
    )
    event["format"] = "conference"
    event["timezone"] = conference.get("time_zone_name")
    for target, source in (("name", "title"), ("start", "start"), ("end", "end")):
        event["provenance"][target] = evidence(
            snapshot,
            json.dumps(conference[source]),
            f"json:schedule.conference.{source}",
            "json-feed",
            "facts",
        )
    event["status"] = event_status(
        event["end"], conference.get("status"), now=now, timezone=event["timezone"]
    )
    event["provenance"]["status"] = list(event["provenance"]["end"])
    return [event]
