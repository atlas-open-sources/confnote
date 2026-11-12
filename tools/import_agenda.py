#!/usr/bin/env python3
"""Import a conference agenda JSON into a timestamp-sortable event folder.

Usage:
    python3 tools/import_agenda.py <agenda.json> [output_base_dir]

Creates (or refreshes) an event folder named `<date>-<slug>` containing:
    README.md      conference overview + formatted agenda
    speakers.md    speaker bios
    agenda.json    the raw imported source (copied verbatim)
    notes/         one markdown note file per session (talk/keynote/panel)

Re-running is safe: README/speakers/agenda.json are regenerated, but existing
note files are never overwritten so your notes are preserved.
"""

import json
import re
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo


def notable(ev) -> bool:
    """Every agenda row is note-able — talks, keynotes, panels, AND breaks,
    networking and lunch (where you note people met, links, topics)."""
    return bool(ev.get("id") and ev.get("start"))


TYPE_ICON = {
    "logistics": "🧭",
    "talk": "🎤",
    "keynote": "⭐",
    "panel": "🗣️",
    "workshop": "🛠️",
    "break": "☕",
    "lunch": "🍽️",
    "networking": "🥂",
    "social": "🥂",
    "other": "•",
}


def slugify(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")


def hhmm(iso: str) -> str:
    """'2026-05-19T11:10:00+01:00' -> '1110' (sortable, local to event tz)."""
    return iso[11:13] + iso[14:16]


def note_file(event: dict) -> str:
    filename = event.get("note_file") or f"{hhmm(event['start'])}-{event['id']}.md"
    if not re.fullmatch(r"(?:\d{4}-|session-)[a-z0-9][a-z0-9_-]*\.md", filename):
        raise ValueError("unsafe note filename")
    return filename


def clock(iso: str) -> str:
    """'2026-05-19T11:10:00+01:00' -> '11:10'."""
    return iso[11:16]


def speaker_label(spk_id: str, speakers: dict) -> str:
    s = speakers.get(spk_id, {})
    name = s.get("name", spk_id)
    role = s.get("role") or s.get("title")
    company = s.get("company")
    if role and company:
        return f"{name} ({role}, {company})"
    if role:
        return f"{name} ({role})"
    return name


def speakers_for(event: dict, speakers: dict) -> str:
    return ", ".join(speaker_label(i, speakers) for i in event.get("speakers", []))


def write_readme(event_dir: Path, data: dict) -> None:
    conf = data["conference"]
    speakers = data.get("speakers", {})
    venue = conf.get("venue", {})
    social = conf.get("social", {})

    lines = [
        f"# {conf['name']}",
        "",
        f"> {conf.get('tagline', '')}",
        "",
        f"- **Date:** {conf['date']} ({conf.get('timezone', '')})",
        f"- **Venue:** {venue.get('name', '')} — {venue.get('address', '')}",
        f"- **Organiser:** {conf.get('organiser', '')}",
        f"- **Contact:** {conf.get('contact', '')}",
    ]
    if social:
        social_str = " · ".join(f"{k}: {v}" for k, v in social.items())
        lines.append(f"- **Social:** {social_str}")
    lines += [
        "",
        "## Agenda",
        "",
        "| Time | | Session | Speakers | Notes |",
        "| --- | --- | --- | --- | --- |",
    ]

    for ev in data["events"]:
        icon = TYPE_ICON.get(ev.get("type", ""), "•")
        time = f"{clock(ev['start'])}–{clock(ev['end'])}"
        title = ev["title"]
        spk = speakers_for(ev, speakers)
        if notable(ev):
            note = f"notes/{note_file(ev)}"
            note_link = f"[notes]({note})"
            title = f"**{title}**"
        else:
            note_link = ""
        lines.append(f"| {time} | {icon} | {title} | {spk} | {note_link} |")

    lines += [
        "",
        "## Sessions",
        "",
        "One note file per session, prefixed with `HHMM` so `ls notes/` is in running order:",
        "",
    ]
    for ev in data["events"]:
        if not notable(ev):
            continue
        note = f"notes/{note_file(ev)}"
        spk = speakers_for(ev, speakers)
        lines.append(f"- `{clock(ev['start'])}` [{ev['title']}]({note}) — {spk}")

    lines += ["", "See [speakers.md](speakers.md) for full bios.", ""]
    (event_dir / "README.md").write_text("\n".join(lines))


def write_speakers(event_dir: Path, data: dict) -> None:
    speakers = data.get("speakers", {})
    lines = [f"# Speakers — {data['conference']['name']}", ""]
    for s in speakers.values():
        title = s.get("role") or s.get("title", "")
        company = s.get("company", "")
        heading = s["name"]
        sub = " · ".join(p for p in [title, company] if p)
        lines.append(f"## {heading}")
        if sub:
            lines.append(f"*{sub}*")
        lines.append("")
        lines.append(s.get("bio", ""))
        social = s.get("social", {})
        if social:
            lines.append("")
            lines.append(" · ".join(f"[{k}]({v})" for k, v in social.items()))
        lines.append("")
    (event_dir / "speakers.md").write_text("\n".join(lines))


def write_note(notes_dir: Path, event: dict, data: dict) -> bool:
    """Write a note file. Returns False (and skips) if it already exists."""
    speakers = data.get("speakers", {})
    fname = note_file(event)
    path = notes_dir / fname
    if path.exists():
        return False

    tz = data["conference"].get("timezone", "")
    start = datetime.fromisoformat(event["start"].replace("Z", "+00:00"))
    end = datetime.fromisoformat(event["end"].replace("Z", "+00:00"))
    if tz and start.tzinfo is not None and end.tzinfo is not None:
        start = start.astimezone(ZoneInfo(tz))
        end = end.astimezone(ZoneInfo(tz))
    spk = speakers_for(event, speakers)
    tags = ", ".join(event.get("tags", []))
    desc = event.get("description", "")
    links = event.get("links", [])
    link_lines = []
    for item in links:
        if isinstance(item, str):
            link_lines.append(f"- {item}")
        elif isinstance(item, dict) and item.get("url"):
            label = item.get("label") or item.get("title") or item["url"]
            link_lines.append(f"- [{label}]({item['url']})")
    front = [
        "---",
        f"session: {event['title']}",
        f"speakers: {spk}",
        f"session_id: {event['id']}",
        f"day: {start.date().isoformat()}",
        f"time: {start:%Y-%m-%d %H:%M}–{end:%H:%M} ({tz})",
        f"room: {event.get('room', '')}",
        f"track: {event.get('track', '')}",
        f"type: {event.get('type', '')}",
        f"tags: [{tags}]",
        "recording:",
        "transcript:",
        "---",
        "",
        f"# {event['title']}",
        "",
        "## Human notes",
        "",
        "",
        "## Summary",
        "",
        "AI-driven — seeded from the agenda, an agent refines this.",
        "",
        f"> {desc}" if desc else "> No description provided.",
        "",
        "## Research",
        "",
        "Speaker & company dossier — run tools/research.py before the conference.",
        "",
        "## AI notes",
        "",
        "Agent-owned. Live notes and follow-up research land here.",
        "",
        "## Transcript",
        "",
        "## Actions",
        "",
        "Tasks and follow-ups — `- [ ] task` lines, tick them off as you go.",
        "",
        "## Links",
        "",
        *link_lines,
        "",
        "",
        "## Scratchpad",
        "",
        "",
        # Encrypted, agent-invisible commentary — filled only via the app's
        # Private tab (encrypted client-side). Empty on import.
        "## Private",
        "",
    ]
    path.write_text("\n".join(front))
    return True


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    agenda_path = Path(sys.argv[1]).expanduser().resolve()
    base = (
        Path(sys.argv[2]).expanduser().resolve()
        if len(sys.argv) > 2
        else Path(__file__).resolve().parent.parent
    )

    data = json.loads(agenda_path.read_text())
    # Share the runtime validator so CLI imports cannot bypass ownership rules.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "packages/local-app"))
    from agenda_manifest import validate_manifest, validate_note_targets

    result = validate_manifest(data)
    if not result["ok"]:
        raise ValueError("; ".join(result["errors"]))
    data = result["manifest"]
    conf = data["conference"]
    event_dir = base / f"{conf['date']}-{slugify(conf['name'])}"
    notes_dir = event_dir / "notes"
    notes_dir.mkdir(parents=True, exist_ok=True)
    (notes_dir / "assets").mkdir(exist_ok=True)

    previous_path = event_dir / "agenda.json"
    previous = json.loads(previous_path.read_text()) if previous_path.exists() else {}
    paths = {e["id"]: note_file(e) for e in previous.get("events", []) if notable(e)}
    for event in data["events"]:
        if event["id"] in paths:
            event["note_file"] = paths[event["id"]]
        elif data.get("schema_version") == "confnote.agenda.v2":
            event["note_file"] = event.get("note_file") or f"session-{event['id']}.md"
        note_file(event)
    validate_note_targets(data["events"], paths)
    previous_path.write_text(json.dumps(data, indent=2) + "\n")
    write_readme(event_dir, data)
    write_speakers(event_dir, data)

    created, skipped = [], []
    for ev in data["events"]:
        if not notable(ev):
            continue
        (created if write_note(notes_dir, ev, data) else skipped).append(ev["id"])
        # Seed a per-talk drop folder so files can be dumped here manually,
        # even before the app is opened. The app and manual dumps share it.
        stem = Path(note_file(ev)).stem
        adir = notes_dir / "assets" / stem
        adir.mkdir(parents=True, exist_ok=True)
        readme = adir / "README.txt"
        if not readme.exists():
            readme.write_text(
                f"Drop folder for: {ev['title']}\n\n"
                "Put images, screenshots, PDFs, or notes for this talk here.\n"
                "The notes app's '\U0001f4ce Files' tab lists everything in this\n"
                "folder. Images pasted/dropped in the app also land here.\n"
            )

    print(f"Imported -> {event_dir}")
    print(f"  notes created: {len(created)}  (skipped existing: {len(skipped)})")
    if skipped:
        print(f"  preserved: {', '.join(skipped)}")


if __name__ == "__main__":
    main()
