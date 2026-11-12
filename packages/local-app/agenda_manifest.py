"""confnote agenda manifest validation and normalization.

The manifest is the headless creation contract. Manual UI, agent extraction,
URL ingestion, pasted JSON, and CLI imports should all normalize to this shape
before anything writes to the markdown vault.
"""

from __future__ import annotations

import copy
import re
from datetime import datetime
from zoneinfo import ZoneInfo

SCHEMA_VERSION = "confnote.agenda.v1"
V2_SCHEMA_VERSION = "confnote.agenda.v2"
NOTE_FILE_RE = re.compile(r"^(?:\d{4}-|session-)[a-z0-9][a-z0-9_-]*\.md$")


def note_file_for_event(event: dict) -> str:
    filename = (
        event.get("note_file") or f"{event['start'][11:13]}{event['start'][14:16]}-{event['id']}.md"
    )
    if not NOTE_FILE_RE.fullmatch(filename):
        raise ValueError("unsafe note filename")
    return filename


EVENT_TYPES = {
    "talk",
    "keynote",
    "panel",
    "workshop",
    "break",
    "networking",
    "logistics",
    "lunch",
    "social",
    "other",
}

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")


def slugify(text: str) -> str:
    text = (text or "").lower().strip()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")


def parse_datetime(value: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def event_day(start: str, timezone: str | None = None) -> str:
    instant = parse_datetime(start)
    if not instant or not timezone or instant.tzinfo is None:
        return start[:10]
    try:
        return instant.astimezone(ZoneInfo(timezone)).date().isoformat()
    except (KeyError, ValueError):
        return start[:10]


def validate_note_targets(events: list[dict], prior: dict[str, str] | None = None) -> None:
    """Each session owns one distinct path; trusted prior mappings survive moves."""
    seen = set()
    for event in events:
        filename = note_file_for_event(event)
        ident = event.get("id", "")
        if not _ID_RE.fullmatch(ident):
            raise ValueError("unsafe session id")
        owned = re.fullmatch(r"(?:\d{4}-|session-)" + re.escape(ident) + r"\.md", filename)
        if not owned and (prior or {}).get(ident) != filename:
            raise ValueError("note_file belongs to another session")
        if filename in seen:
            raise ValueError("duplicate note_file target")
        seen.add(filename)


def conference_slug(manifest: dict) -> str:
    conf = manifest.get("conference") or {}
    return f"{conf.get('date')}-{slugify(conf.get('name', 'conference'))}"


def _as_list(value) -> list:
    return value if isinstance(value, list) else []


def _normalize_links(value) -> list[dict]:
    out = []
    for item in _as_list(value):
        if isinstance(item, str):
            url = item.strip()
            if url:
                out.append({"url": url})
        elif isinstance(item, dict):
            url = str(item.get("url") or "").strip()
            if url:
                link = {"url": url}
                label = str(item.get("label") or item.get("title") or "").strip()
                if label:
                    link["label"] = label
                out.append(link)
    return out


def normalize_manifest(obj: dict) -> dict:
    """Return a normalized copy of a manifest-like dict.

    This is intentionally conservative: it fills stable defaults and coerces
    common UI/agent-friendly forms, but it does not invent event times or
    speakers. Validation decides whether the result is commit-worthy.
    """
    manifest = copy.deepcopy(obj or {})
    manifest["schema_version"] = manifest.get("schema_version") or SCHEMA_VERSION

    conf = dict(manifest.get("conference") or {})
    name = str(conf.get("name") or "").strip()
    date = str(conf.get("date") or "").strip()
    if name:
        conf["name"] = name
    if date:
        conf["date"] = date
    conf["id"] = str(conf.get("id") or slugify(f"{name}-{date[:4]}")).strip("-")
    conf["timezone"] = str(conf.get("timezone") or "").strip()
    conf["url"] = str(conf.get("url") or "").strip()
    conf["description"] = str(conf.get("description") or conf.get("tagline") or "").strip()
    if "tagline" in conf and not conf["description"]:
        conf["description"] = str(conf.get("tagline") or "").strip()
    venue = conf.get("venue") if isinstance(conf.get("venue"), dict) else {}
    conf["venue"] = {
        "name": str(venue.get("name") or "").strip(),
        "address": str(venue.get("address") or "").strip(),
        "city": str(venue.get("city") or "").strip(),
        "country": str(venue.get("country") or "").strip(),
    }
    manifest["conference"] = conf

    for key in ("rooms", "tracks"):
        seen = set()
        rows = []
        for item in _as_list(manifest.get(key)):
            if not isinstance(item, dict):
                continue
            label = str(item.get("name") or item.get("id") or "").strip()
            item_id = str(item.get("id") or slugify(label)).strip()
            if not label or not item_id or item_id in seen:
                continue
            seen.add(item_id)
            rows.append({"id": item_id, "name": label})
        manifest[key] = rows

    speakers = {}
    for raw_id, raw in (manifest.get("speakers") or {}).items():
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or raw_id).strip()
        speaker_id = str(raw.get("id") or raw_id or slugify(name)).strip()
        if not speaker_id:
            continue
        speaker = {
            "name": name,
            "role": str(raw.get("role") or raw.get("title") or "").strip(),
            "company": str(raw.get("company") or "").strip(),
            "bio": str(raw.get("bio") or "").strip(),
            "url": str(raw.get("url") or "").strip(),
            "social": raw.get("social") if isinstance(raw.get("social"), dict) else {},
        }
        speakers[speaker_id] = speaker
    manifest["speakers"] = speakers

    events = []
    seen_events = set()
    for raw in _as_list(manifest.get("events")):
        if not isinstance(raw, dict):
            continue
        title = str(raw.get("title") or "").strip()
        event_id = str(raw.get("id") or slugify(title)).strip()
        if event_id in seen_events:
            suffix = 2
            base = event_id
            while f"{base}-{suffix}" in seen_events:
                suffix += 1
            event_id = f"{base}-{suffix}"
        if event_id:
            seen_events.add(event_id)
        event_type = str(raw.get("type") or "talk").strip().lower()
        if event_type not in EVENT_TYPES:
            event_type = "other"
        events.append(
            {
                "id": event_id,
                "type": event_type,
                "title": title,
                "description": str(raw.get("description") or "").strip(),
                "start": str(raw.get("start") or "").strip(),
                "end": str(raw.get("end") or "").strip(),
                "room": str(raw.get("room") or "").strip(),
                "track": str(raw.get("track") or "").strip(),
                "speakers": [
                    str(s).strip() for s in _as_list(raw.get("speakers")) if str(s).strip()
                ],
                "tags": [str(t).strip() for t in _as_list(raw.get("tags")) if str(t).strip()],
                "links": _normalize_links(raw.get("links")),
            }
        )
    if manifest["schema_version"] == V2_SCHEMA_VERSION:
        for event, raw in zip(
            events,
            [r for r in _as_list(manifest.get("events")) if isinstance(r, dict)],
            strict=True,
        ):
            event["session_id"] = event["id"]
            event["day"] = event_day(event["start"], conf.get("timezone"))
            event["note_file"] = raw.get("note_file") or f"session-{event['id']}.md"
    for event, raw in zip(
        events, [r for r in _as_list(manifest.get("events")) if isinstance(r, dict)], strict=True
    ):
        if raw.get("note_file"):
            event["note_file"] = raw["note_file"]
    if manifest["schema_version"] == V2_SCHEMA_VERSION and events:
        conf["start_date"] = conf.get("start_date") or conf.get("date")
        conf["end_date"] = max(
            [
                conf.get("end_date") or conf.get("date", ""),
                *[event_day(e["end"], conf.get("timezone")) for e in events],
            ]
        )
    manifest["events"] = events

    # Events name their room/track by id. One the manifest didn't list becomes
    # its own entry, so the multi-track rail can still label its column.
    for key, field in (("rooms", "room"), ("tracks", "track")):
        known = {row["id"] for row in manifest[key]} | {row["name"] for row in manifest[key]}
        for event in events:
            value = event[field]
            if value and value not in known:
                known.add(value)
                manifest[key].append({"id": value, "name": value})

    sources = []
    for raw in _as_list(manifest.get("sources")):
        if isinstance(raw, str):
            url = raw.strip()
            if url:
                sources.append({"url": url})
        elif isinstance(raw, dict):
            url = str(raw.get("url") or "").strip()
            label = str(raw.get("label") or raw.get("title") or "").strip()
            retrieved_at = str(raw.get("retrieved_at") or "").strip()
            if url or label:
                source = {}
                if url:
                    source["url"] = url
                if label:
                    source["label"] = label
                if retrieved_at:
                    source["retrieved_at"] = retrieved_at
                sources.append(source)
    manifest["sources"] = sources
    return manifest


def _parallel_without_room(events: list[dict]) -> int:
    """Count events that run at the same time as another event while neither
    names a room or track: an agenda whose parallel rooms were flattened."""
    timed = []
    for event in events:
        start = parse_datetime(event.get("start", ""))
        end = parse_datetime(event.get("end", ""))
        if start and end and end > start and not (event.get("room") or event.get("track")):
            timed.append((start, end, event.get("id")))
    flagged = set()
    for i, (start, end, event_id) in enumerate(timed):
        for other_start, other_end, other_id in timed[i + 1 :]:
            if start < other_end and other_start < end:
                flagged.update((event_id, other_id))
    return len(flagged)


def validate_manifest(obj: dict, *, require_schema_version: bool = False) -> dict:
    """Validate and normalize a manifest.

    Returns {ok, manifest, errors, warnings, summary}. The normalized manifest
    is returned even when invalid so a UI can preserve the user's draft.
    """
    errors: list[str] = []
    warnings: list[str] = []
    if not isinstance(obj, dict):
        return {
            "ok": False,
            "manifest": {},
            "errors": ["manifest must be a JSON object"],
            "warnings": [],
            "summary": {},
        }

    manifest = normalize_manifest(obj)
    version = manifest.get("schema_version")
    if require_schema_version and version not in (SCHEMA_VERSION, V2_SCHEMA_VERSION):
        errors.append(f"schema_version must be {SCHEMA_VERSION}")
    elif version not in (SCHEMA_VERSION, V2_SCHEMA_VERSION, "1.0"):
        warnings.append(f"unknown schema_version {version!r}; importing as {SCHEMA_VERSION}")

    conf = manifest.get("conference") or {}
    if not conf.get("name"):
        errors.append("conference.name is required")
    if not conf.get("date"):
        errors.append("conference.date is required")
    elif not _DATE_RE.match(str(conf.get("date"))):
        errors.append("conference.date must be YYYY-MM-DD")
    if not conf.get("timezone"):
        warnings.append("conference.timezone is recommended for correct live status")
    if conf.get("id") and not _ID_RE.match(conf["id"]):
        warnings.append("conference.id should be a lowercase slug")

    speaker_ids = set((manifest.get("speakers") or {}).keys())
    for sid, speaker in (manifest.get("speakers") or {}).items():
        if not _ID_RE.match(str(sid)):
            warnings.append(f"speaker id {sid!r} should be a lowercase slug")
        if not speaker.get("name"):
            errors.append(f"speaker {sid!r} needs name")

    events = manifest.get("events") or []
    if not events:
        errors.append("events must contain at least one item")
    seen = set()
    for idx, event in enumerate(events):
        label = event.get("id") or f"event[{idx}]"
        if not event.get("id"):
            errors.append(f"{label} needs id")
        elif not _ID_RE.match(event["id"]):
            errors.append(f"event {event['id']!r} id must be a lowercase slug")
        elif event["id"] in seen:
            errors.append(f"event id {event['id']!r} is duplicated")
        seen.add(event.get("id"))
        if event.get("note_file") and not NOTE_FILE_RE.fullmatch(event["note_file"]):
            errors.append(f"{label} has unsafe note_file")
        if not event.get("title"):
            errors.append(f"{label} needs title")
        start = parse_datetime(event.get("start", ""))
        end = parse_datetime(event.get("end", ""))
        _iso_hint = "full ISO 8601 with timezone, e.g. 2026-05-19T09:30:00+01:00"
        if not start:
            errors.append(
                f"{label} needs ISO start (got {event.get('start', '')!r}; want {_iso_hint})"
            )
        if not end:
            errors.append(f"{label} needs ISO end (got {event.get('end', '')!r}; want {_iso_hint})")
        if start and end and end <= start:
            errors.append(f"{label} end must be after start")
        if event.get("type") not in EVENT_TYPES:
            warnings.append(f"{label} uses non-standard type {event.get('type')!r}")
        for sid in event.get("speakers", []):
            if sid not in speaker_ids:
                warnings.append(f"{label} references unknown speaker {sid!r}")

    unplaced = _parallel_without_room(events)
    if unplaced:
        warnings.append(
            f"{unplaced} events overlap other events but have no room or track; set each "
            "event's `room` (listed in top-level `rooms`) so parallel sessions show side by "
            "side, instead of tagging the title"
        )
    try:
        validate_note_targets(events)
    except (ValueError, KeyError, TypeError) as exc:
        errors.append(str(exc))

    summary = {
        "schema_version": SCHEMA_VERSION,
        "slug": conference_slug(manifest) if conf.get("name") and conf.get("date") else "",
        "name": conf.get("name", ""),
        "date": conf.get("date", ""),
        "event_count": len(events),
        "speaker_count": len(speaker_ids),
        "room_count": len(manifest.get("rooms") or []),
        "track_count": len(manifest.get("tracks") or []),
    }
    return {
        "ok": not errors,
        "manifest": manifest,
        "errors": errors,
        "warnings": warnings,
        "summary": summary,
    }
