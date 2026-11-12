"""Reproducible adapter for the checked-in World's Fair session snapshot."""

import hashlib
import re
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from .migration import migrate_agenda


def worldsfair_agenda(source: dict) -> dict:
    first_day = date(2026, 6, 29)
    timezone = ZoneInfo("America/Los_Angeles")
    events = []
    occurrences = {}
    for row in source["sessions"]:
        day_number = int(re.match(r"Day (\d+)", row["day"])[1])
        day = first_day + timedelta(days=day_number - 1)
        times = row["time"].split("-")
        start, end = [
            datetime.combine(
                day, datetime.strptime(value.strip(), "%I:%M%p").time(), timezone
            ).isoformat()
            for value in times
        ]
        # No source IDs exist. Freeze this content-derived ID on first import;
        # future matching/reconciliation must retain it when a title changes.
        identity = "\n".join([row["title"], row["day"], row.get("room", "")])
        occurrences[identity] = occurrences.get(identity, 0) + 1
        identity += f"\n{occurrences[identity]}"
        ident = "wf-" + hashlib.sha256(identity.encode()).hexdigest()[:20]
        events.append(
            {
                "id": ident,
                "title": row["title"],
                "start": start,
                "end": end,
                "room": row.get("room", ""),
                "type": row.get("type", "other"),
                "track": row.get("track", ""),
                "speakers": [],
            }
        )
    return migrate_agenda(
        {
            "schema_version": "confnote.agenda.v1",
            "conference": {
                "name": source["conference"],
                "date": first_day.isoformat(),
                "timezone": "America/Los_Angeles",
                "url": source["website"],
            },
            "events": events,
        }
    )
