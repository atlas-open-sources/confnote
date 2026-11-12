"""Non-destructive v1 vault migration. Existing note/asset paths remain stable."""

import copy
import json
import os
import re
from pathlib import Path

from . import local_day

ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
NOTE_RE = re.compile(r"^(?:\d{4}-|session-)[a-z0-9][a-z0-9_-]*\.md$")


def migrate_agenda(source: dict) -> dict:
    """Preserve legacy extras and filenames; add stable identity and day metadata."""
    data = copy.deepcopy(source)
    if data.get("schema_version") not in (None, "1.0", "confnote.agenda.v1", "confnote.agenda.v2"):
        raise ValueError("unsupported agenda version")
    conf = data.get("conference") or {}
    if not conf.get("name") or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", conf.get("date", "")):
        raise ValueError("conference name and date required")
    seen = set()
    files = set()
    data.setdefault("events", [])
    for event in data["events"]:
        ident = event.get("id", "")
        if not ID_RE.fullmatch(ident) or ident in seen:
            raise ValueError("unsafe or duplicate session id")
        seen.add(ident)
        start = event.get("start", "")
        if not re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", start):
            raise ValueError("session needs a dated start")
        legacy = start[11:13] + start[14:16] + "-" + ident + ".md"
        filename = event.get("note_file") or legacy
        if not NOTE_RE.fullmatch(filename) or filename in files:
            raise ValueError("unsafe or duplicate note path")
        files.add(filename)
        event.update(
            session_id=ident, day=local_day(start, conf.get("timezone")), note_file=filename
        )
    conf["start_date"] = conf.get("start_date") or conf["date"]
    conf["end_date"] = max(
        [
            conf["date"],
            conf.get("end_date") or conf["date"],
            *[local_day(e["end"], conf.get("timezone")) for e in data.get("events", [])],
        ]
    )
    data["conference"] = conf
    data["schema_version"] = "confnote.agenda.v2"
    return data


def migrate_vault(directory: Path) -> dict:
    """Explicit opt-in, validate everything before atomic agenda replacement.

    Notes and assets are not rewritten or moved. Thus interrupted migrations can
    be retried and markdown links, encrypted sections and attachment paths survive.
    """
    path = directory / "agenda.json"
    if directory.is_symlink() or path.is_symlink():
        raise ValueError("symlink vault is not supported")
    data = migrate_agenda(json.loads(path.read_text()))
    for event in data["events"]:
        note = directory / "notes" / event["note_file"]
        if note.is_symlink() or (directory / "notes").is_symlink():
            raise ValueError("symlink notes are not supported")
    temporary = directory / ".agenda-v2.tmp"
    # Exclusive creation refuses pre-existing files and symlinks.
    with temporary.open("x") as stream:
        json.dump(data, stream, indent=2, ensure_ascii=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    return data
