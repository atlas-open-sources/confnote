"""Generic events v2 validation; JSON Schema is the language-neutral authority."""

import json
from datetime import datetime
from pathlib import Path
from typing import NotRequired, TypedDict
from zoneinfo import ZoneInfo

from jsonschema import Draft202012Validator, FormatChecker


class Evidence(TypedDict):
    source_url: str
    source_type: str
    fetched_at: str
    content_hash: str
    quote: str
    locator: str
    extractor: dict[str, str]
    check: dict[str, str | bool]
    review: dict[str, str]
    license: str


class Application(TypedDict):
    type: str
    url: str
    platform: NotRequired[str]
    approval: NotRequired[str]
    deadline: NotRequired[str | None]
    opens_at: NotRequired[str | None]
    status: NotRequired[str]
    price: NotRequired[dict]
    eligibility: NotRequired[str]
    capacity: NotRequired[int | None]


class Event(TypedDict):
    id: str
    kind: str
    name: str
    category: str
    format: str
    start: str
    end: str
    timezone: str | None
    applications: list[Application]
    topics: list[str]
    provenance: dict[str, list[Evidence]]
    series: NotRequired[str | None]
    super_event: NotRequired[str | None]
    sub_events: NotRequired[list[str]]
    sessions: NotRequired[list[str]]
    city: NotRequired[str | None]
    country: NotRequired[str | None]
    level: NotRequired[str | None]
    region: NotRequired[str | None]
    extensions: NotRequired[dict]
    program: NotRequired[str | None]
    url: NotRequired[str]


class Session(TypedDict):
    id: str
    kind: str
    event: str
    title: str
    start: str
    end: str
    day: str


class Entity(TypedDict):
    id: str
    kind: str
    name: str


class Catalogue(TypedDict):
    schema_version: str
    events: list[Event]
    sessions: NotRequired[list[Session]]
    series: NotRequired[list[Entity]]
    people: NotRequired[list[Entity]]
    orgs: NotRequired[list[Entity]]
    venues: NotRequired[list[Entity]]


SCHEMA = json.loads(
    (Path(__file__).resolve().parents[2] / "schema/events-v2.schema.json").read_text()
)
_VALIDATOR = Draft202012Validator(SCHEMA, format_checker=FormatChecker())


def _times(value: dict) -> None:
    if (len(value["start"]) == 10) != (len(value["end"]) == 10):
        raise ValueError("start/end precision must match")
    start = datetime.fromisoformat(value["start"].replace("Z", "+00:00"))
    end = datetime.fromisoformat(value["end"].replace("Z", "+00:00"))
    if end < start:
        raise ValueError("end precedes start")
    if value.get("timezone") is not None:
        try:
            ZoneInfo(value["timezone"])
        except (KeyError, ValueError) as exc:
            raise ValueError("invalid timezone") from exc


def validate_event(value: object) -> None:
    """Raise ValueError for invalid event structure, dates or timezone."""
    errors = list(
        _VALIDATOR.evolve(schema={"$ref": "#/$defs/Event", "$defs": SCHEMA["$defs"]}).iter_errors(
            value
        )
    )
    if errors:
        raise ValueError("; ".join(error.message for error in errors))
    _times(value)


def validate_catalogue(value: object) -> None:
    errors = list(_VALIDATOR.iter_errors(value))
    if errors:
        raise ValueError("; ".join(error.message for error in errors))
    ids = set()
    for collection in ("events", "sessions", "series", "people", "orgs", "venues"):
        for entity in value.get(collection, []):
            if entity["id"] in ids:
                raise ValueError(f"duplicate id: {entity['id']}")
            ids.add(entity["id"])
    for event in value["events"]:
        _times(event)
    for session in value.get("sessions", []):
        _times(session)
        timezone = next(
            (e.get("timezone") for e in value["events"] if e["id"] == session["event"]), None
        )
        if session["day"] != local_day(session["start"], timezone):
            raise ValueError("session day differs from start")


def local_day(start: str, timezone: str | None = None) -> str:
    if not timezone or len(start) == 10:
        return start[:10]
    instant = datetime.fromisoformat(start.replace("Z", "+00:00"))
    if instant.tzinfo is None:
        return start[:10]
    return instant.astimezone(ZoneInfo(timezone)).date().isoformat()
