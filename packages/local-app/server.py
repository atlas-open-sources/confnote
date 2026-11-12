#!/usr/bin/env python3
"""confnote — zero-dependency local server (Python 3 stdlib only).

Run:
    python3 packages/local-app/server.py            # serves http://localhost:8787
    CONF_NOTES_PORT=9000 python3 packages/local-app/server.py

Canonical store = the markdown files in <conf>/notes/. This server is just a
fast editor over them. Section ownership contract:

    ## Human notes   app-editable  (you, live)
    ## Summary       AI-driven     (read-only here, agent-written)
    ## AI notes      AGENT-OWNED   (read-only here, preserved on every save)
    ## Transcript    app-editable  (manual paste / local transcription)
    ## Links         app-editable
    ## Scratchpad    app-editable

On save the server re-reads the file from disk and rewrites ONLY the
app-editable sections, so an agent writing `## Summary`/`## AI notes` during
a live talk is never clobbered.

Optional chat (chat.py, run via packages/local-app/run.sh): a floating bubble
talks to the Claude Agent SDK with this talk's context; it can only rewrite
`## Summary`, and only when explicitly asked. Core app stays stdlib; chat is
disabled gracefully if claude-agent-sdk / the `claude` CLI is absent.
"""

import json
import math
import os
import queue
import re
import socketserver
import sys
import threading
import time
import webbrowser
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import chatgpt_agent
import chatgpt_auth
import concierge_tools
import keychain
import recording_flow
import transcription
import vault_transfer
from agenda_manifest import (
    SCHEMA_VERSION,
    conference_slug,
    note_file_for_event,
    validate_manifest,
    validate_note_targets,
)
from bridge import get_bridge
from first_run import seed_first_run

# Module name in URLs like /api/module/<name>/events must be a simple slug.
_MODULE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")

# Serialize agent runs. ThreadingHTTPServer dispatches each request on its own
# thread, so two overlapping chat POSTs (e.g. a message submitted while /brief
# is still streaming) would otherwise run two claude sessions against the same
# chat JSONL + resume id and race. The frontend also queues mid-stream submits;
# this lock is the server-side belt-and-braces so a stray concurrent request
# waits its turn instead of corrupting the stream.
_AGENT_LOCK = threading.Lock()
_SCHEDULE_LOCK = threading.RLock()
_NOTE_WRITE_LOCK = threading.RLock()


class ScheduleConflict(ValueError):
    """The caller's schedule snapshot no longer matches the stored agenda."""


def _schedule_integer(value, name):
    if isinstance(value, bool) or not isinstance(value, int) or not -1440 <= value <= 1440:
        raise ValueError(f"{name} must be an integer between -1440 and 1440.")
    return value


def effective_event(data, event):
    """Project displayed times without altering raw agenda times or note identity."""
    offset = _schedule_integer(data.get("schedule_offset_minutes", 0), "schedule_offset_minutes")
    result = dict(event)
    if offset:
        for field in ("start", "end"):
            value = event.get(field)
            if value:
                result[field] = (
                    datetime.fromisoformat(value) + timedelta(minutes=offset)
                ).isoformat()
    return result


def set_conference_schedule(slug, offset_minutes, expected_offset, expected_revision=None):
    """Atomically change an absolute offset; never write, rename or recreate notes."""
    _schedule_integer(offset_minutes, "offset_minutes")
    _schedule_integer(expected_offset, "expected_offset")
    if expected_revision is not None and (
        isinstance(expected_revision, bool)
        or not isinstance(expected_revision, int)
        or expected_revision < 0
    ):
        raise ValueError("expected_revision must be a non-negative integer.")
    with _SCHEDULE_LOCK:
        data = load_agenda(slug)
        if data is None:
            raise FileNotFoundError("Conference not found.")
        current_offset = data.get("schedule_offset_minutes", 0)
        revision = data.get("schedule_revision", 0)
        if current_offset != expected_offset or (
            expected_revision is not None and revision != expected_revision
        ):
            raise ScheduleConflict("Conference schedule changed. Reload before rescheduling.")
        # Validate the complete projection before any disk mutation.
        proposed = {**data, "schedule_offset_minutes": offset_minutes}
        for event in proposed.get("events", []):
            effective_event(proposed, event)
        if current_offset != offset_minutes:
            proposed["schedule_revision"] = revision + 1
            atomic_write(BASE_DIR / slug / "agenda.json", json.dumps(proposed, indent=2) + "\n")
        return conference_payload(slug)


# ---- vault selection -------------------------------------------------------
# The notes vault is user-switchable from Settings. The chosen vault + a
# recents list persist APP-GLOBALLY (outside any vault), namespaced by channel
# so the dev and prod apps remember independent selections on the same Mac.
DEFAULT_VAULT = Path.home() / "Documents/confnote"


def app_channel() -> str:
    """ "dev" or "prod". CONFNOTE_CHANNEL wins (run.sh sets it); otherwise infer
    from the frozen bundle's executable name / id ("confnote dev" → dev)."""
    ch = (os.environ.get("CONFNOTE_CHANNEL") or "").strip().lower()
    if ch in ("dev", "prod"):
        return ch
    exe = (sys.executable or "").lower()
    if "confnote dev" in exe:
        return "dev"
    try:
        if getattr(sys, "frozen", False):
            plist = Path(sys.executable).resolve().parent.parent / "Info.plist"
            if plist.is_file() and ".confnote.dev." in plist.read_text(errors="ignore"):
                return "dev"
    except Exception:
        pass
    return "prod"


def app_state_path() -> Path:
    return Path.home() / "Library/Application Support/confnote" / app_channel() / "state.json"


def read_app_state() -> dict:
    try:
        d = json.loads(app_state_path().read_text())
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def write_app_state(state: dict) -> None:
    p = app_state_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(state, indent=2))


def resolve_base_dir() -> Path:
    """Vault resolution order: CONF_NOTES_DIR env (tests / fast loop / power
    users) → the UI-selected vault persisted in app state → the default."""
    env = os.environ.get("CONF_NOTES_DIR")
    if env:
        return Path(env).expanduser().resolve()
    cur = (read_app_state().get("current_vault") or "").strip()
    if cur:
        return Path(cur).expanduser().resolve()
    return DEFAULT_VAULT.expanduser().resolve()


BASE_DIR = resolve_base_dir()
BASE_DIR.mkdir(parents=True, exist_ok=True)


def vault_recents() -> list[str]:
    return [p for p in (read_app_state().get("recents") or []) if isinstance(p, str) and p]


def set_current_vault(path: str) -> None:
    """Persist `path` as the current vault and push it to the front of recents
    (deduped, capped). Used by /api/vault/switch before relaunch."""
    st = read_app_state()
    recents = [p for p in (st.get("recents") or []) if isinstance(p, str) and p and p != path]
    recents.insert(0, path)
    st["recents"] = recents[:8]
    st["current_vault"] = path
    write_app_state(st)


def vault_payload() -> dict:
    cur = str(BASE_DIR)
    return {
        "current": cur,
        "default": str(DEFAULT_VAULT.expanduser().resolve()),
        "channel": app_channel(),
        "recents": [p for p in vault_recents() if p != cur],
        "env_pinned": bool(os.environ.get("CONF_NOTES_DIR")),
    }


def request_vault_relaunch(port: int) -> None:
    """Re-exec so BASE_DIR + every derived path re-resolve against the newly
    persisted vault. Frozen .app → relaunch the bundle via `open -n` (clean
    Finder env reads the persisted vault). Source run → execve, pinning the port
    so the browser tab reconnects. We do NOT strip CONF_NOTES_DIR: env wins by
    contract, and the switch endpoint already declines to relaunch when it's set
    (the selection is persisted for when the override is later removed)."""

    def _go():
        import subprocess

        time.sleep(0.4)  # let the HTTP response flush first
        try:
            if getattr(sys, "frozen", False):
                bundle = Path(sys.executable).resolve().parents[2]  # …/<name>.app
                subprocess.Popen(["open", "-n", str(bundle)])
                os._exit(0)
            env = dict(os.environ)
            env["CONF_NOTES_PORT"] = str(port)
            os.execve(sys.executable, [sys.executable, *sys.argv], env)
        except Exception:
            os._exit(0)

    threading.Thread(target=_go, daemon=True).start()


def _find_static() -> Path:
    """Locate static/ in dev AND in a PyInstaller .app (where --add-data lands
    it under Contents/Resources, not next to this file). Probe candidates and
    pick whichever actually holds index.html.

    Dev: static lives at packages/core-ui/static (sibling package).
    Bundled .app: static is copied next to the executable / under Resources.
    """
    here = Path(__file__).resolve().parent
    exe = Path(sys.executable).resolve()
    cands = [
        here / "static",  # legacy / co-located
        here.parent / "core-ui" / "static",  # monorepo sibling (dev)
        Path(getattr(sys, "_MEIPASS", here)) / "static",
        exe.parent / "static",
        exe.parent.parent / "Resources" / "static",  # macOS .app bundle
    ]
    for c in cands:
        if (c / "index.html").is_file():
            return c
    return here / "static"


STATIC_DIR = _find_static()
CONF_RE = re.compile(r"^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$")
# A .confnote bundle is capped at vault_transfer.MAX_BYTES; leave room for the
# {"bundle": …, "mode": …} envelope and JSON escaping.
IMPORT_BODY_LIMIT = 2 * vault_transfer.MAX_BYTES
NOTE_RE = re.compile(r"^(?:\d{4}-|session-)[a-z0-9][a-z0-9_-]*\.md$")


def notable(ev) -> bool:
    """Every agenda row is note-able — talks AND breaks/networking/lunch
    (drop people you met, links, topics there too)."""
    return bool(ev.get("id") and ev.get("start"))


# `Brief` and `Debrief` are CONFERENCE-LEVEL (BRIEF.md / DEBRIEF.md in the
# conf root), not per-session sections. They were temporarily per-session
# in earlier iterations; that's been undone — the per-session orphans were
# removed in the v0.1 cleanup. Actions remain per-session.
CANON_SECTIONS = [
    "Human notes",
    "Summary",
    "Research",
    "AI notes",
    "Transcript",
    "Actions",
    "Links",
    "Scratchpad",
    "Private",
]
EDITABLE = {
    "Human notes",
    "Transcript",
    "Actions",
    "Links",
    "Scratchpad",
    "Private",
}  # Summary/Research/AI notes are AI-driven
# `Private` holds client-encrypted ciphertext only (AES-GCM, key derived in the
# browser from a passphrase the server never sees). It is editable (the client
# PUTs the opaque ciphertext) but is STRIPPED from anything the agent reads, so
# the concierge can never see private commentary even in encrypted form.
PRIVATE_SECTION = "Private"
ACTION_RE = re.compile(r"^\s*[-*]\s+\[([ xX])\]\s+(.*)$")  # Actions section task items
# localhost-only by default. Set CONF_NOTES_HOST=0.0.0.0 to reach it from
# other devices (e.g. phone over Tailscale) — opt-in; also exposes to LAN.
HOST = os.environ.get("CONF_NOTES_HOST", "127.0.0.1")
IMG_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}

try:  # the only optional dependency, isolated
    import chat as chatmod

    CHAT_OK = chatmod.available()
except Exception:
    chatmod, CHAT_OK = None, False
MIME = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    # Recordings beside a note (notes/assets/<talk>/), opened from its Files tab.
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".webm": "audio/webm",
    ".pdf": "application/pdf",
}

# A note's attachment can come from a shared vault. Opened on its own (an SVG or
# HTML file from the Files tab), it must not run script on the app's origin,
# where it could call the local API. PDFs are left out: a sandboxed PDF does not
# render in WebKit or Chrome.
ASSET_SANDBOX_CSP = (
    "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'"
)


def asset_headers(ctype: str) -> dict:
    headers = {"X-Content-Type-Options": "nosniff"}
    if ctype != "application/pdf":
        headers["Content-Security-Policy"] = ASSET_SANDBOX_CSP
    return headers


# ---------- markdown note parsing / merging ----------


def parse_note(text: str):
    lines = text.split("\n")
    fm, i = {}, 0
    if lines and lines[0].strip() == "---":
        i = 1
        while i < len(lines) and lines[i].strip() != "---":
            if ":" in lines[i]:
                k, _, v = lines[i].partition(":")
                fm[k.strip()] = v.strip()
            i += 1
        i += 1
    title = ""
    while i < len(lines):
        if lines[i].startswith("# "):
            title = lines[i][2:].strip()
            i += 1
            break
        if lines[i].strip() == "":
            i += 1
            continue
        break
    # Only the known canonical headings delimit sections. A user (or agent)
    # typing "## Anything else" inside a section keeps it as content rather
    # than corrupting the structure.
    sections, cur, buf = {}, None, []
    for line in lines[i:]:
        if line.startswith("## ") and line[3:].strip() in CANON_SECTIONS:
            if cur is not None:
                sections[cur] = "\n".join(buf).strip("\n")
            cur = line[3:].strip()
            buf = []
        elif cur is not None:
            buf.append(line)
    if cur is not None:
        sections[cur] = "\n".join(buf).strip("\n")
    return fm, title, sections


def escape_canon_headings(body: str) -> str:
    """A body line that reads as a canonical heading starts a new section on the
    next parse, so a write to one section (agent Research, an imported
    description) could replace another (Human notes). Demote it one level."""
    return "\n".join(
        "#" + line if line.startswith("## ") and line[3:].strip() in CANON_SECTIONS else line
        for line in body.split("\n")
    )


def build_note(fm: dict, title: str, sections: dict) -> str:
    fm_lines = "\n".join(f"{k}: {v}" for k, v in fm.items())
    out = [f"---\n{fm_lines}\n---\n", f"\n# {title}\n"]
    for name in CANON_SECTIONS:
        body = escape_canon_headings(sections.get(name) or "").strip("\n")
        out.append(f"\n## {name}\n\n{body}\n" if body else f"\n## {name}\n\n")
    return "".join(out)


def atomic_write(path: Path, text: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)


# ---------- link extraction (Bug #3: URLs sit in Human notes, never Links) ----------
# Users drop links inline while taking notes; the `## Links` section stays
# empty. We mirror (not move) any URL found in Human notes into Links on save —
# non-destructive, deduped. Bare domains need an allowlisted TLD so prose like
# `app.js` / `Node.js` / `v0.2` is never mistaken for a link.
_LINK_TLDS = (
    "com|org|net|io|ai|dev|co|app|gg|xyz|me|tech|sh|so|to|edu|gov|"
    "cloud|page|site|ly|fm|tv|info|app|run|new"
)
URL_SCHEME_RE = re.compile(r"https?://[^\s<>)\]]+", re.I)
MD_LINK_RE = re.compile(r"\]\(\s*([^)\s]+)\s*\)")
BARE_DOMAIN_RE = re.compile(
    r"(?<![\w@/.-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:" + _LINK_TLDS + r"))"
    r"(?:/[^\s<>)\]]*)?",
    re.I,
)
_LINK_TRAIL = ".,;:!?)]}>\"'"


def extract_links(text: str) -> list[str]:
    """URLs / markdown-link targets / allowlisted bare domains in `text`, in
    order of first appearance, deduped case-insensitively."""
    if not text:
        return []
    found: list[str] = []
    seen: set[str] = set()

    def add(u: str) -> None:
        u = u.strip().strip("<>").strip(_LINK_TRAIL)
        if not u:
            return
        key = u.lower()
        if key not in seen:
            seen.add(key)
            found.append(u)

    for m in MD_LINK_RE.finditer(text):  # capture the URL, not the label
        add(m.group(1))
    for m in URL_SCHEME_RE.finditer(text):
        add(m.group(0))
    for m in BARE_DOMAIN_RE.finditer(text):
        add(m.group(0))
    return found


def merge_links_into_section(human_notes: str, links_section: str) -> str:
    """Append any link from `human_notes` not already present in `links_section`
    as a `- <url>` bullet. Returns the (possibly unchanged) Links body."""
    existing = (links_section or "").lower()
    new = [f"- {u}" for u in extract_links(human_notes) if u.lower() not in existing]
    if not new:
        return links_section
    base = (links_section or "").rstrip()
    block = "\n".join(new)
    return base + "\n" + block if base else block


# ---------- conference / agenda helpers ----------


def speaker_label(spk_id: str, speakers: dict) -> str:
    s = speakers.get(spk_id, {})
    name = s.get("name", spk_id)
    role = s.get("role") or s.get("title")
    company = s.get("company")
    if role and company:
        return f"{name} ({role}, {company})"
    return f"{name} ({role})" if role else name


def conf_dirs():
    return sorted(
        (p for p in BASE_DIR.iterdir() if p.is_dir() and CONF_RE.match(p.name)),
        key=lambda p: p.name,
        reverse=True,
    )


def load_agenda(slug: str):
    d = BASE_DIR / slug
    if not (CONF_RE.match(slug) and d.is_dir()):
        return None
    f = d / "agenda.json"
    return json.loads(f.read_text()) if f.exists() else None


def note_path(slug: str, fname: str) -> Path | None:
    if not (CONF_RE.match(slug) and NOTE_RE.match(fname)):
        return None
    p = (BASE_DIR / slug / "notes" / fname).resolve()
    if BASE_DIR not in p.parents or not p.exists():
        return None
    return p


def resolve_note_file(slug: str, note_file: str) -> str | None:
    """Map a loosely-specified note reference to the real `HHMM-<id>.md` file.

    The agent's `note_file` argument is sometimes slightly off — missing the
    `.md`, an over-qualified `<slug>/<file>` path, the bare session id without
    the `HHMM-` prefix, or just the `HHMM` time. When `save_research` /
    `read_note` couldn't resolve it they returned "Unknown session", and the
    agent used to work around that by inventing a sidecar file — the
    `…--agent-research.md` orphan bug. Resolving leniently here keeps research
    landing in the real `## Research` section. Returns the canonical filename
    only on an UNAMBIGUOUS match, else None (caller surfaces the miss)."""
    if not CONF_RE.match(slug):
        return None
    name = (note_file or "").strip().replace("\\", "/")
    if "/" in name:
        name = name.rsplit("/", 1)[-1]  # drop an over-qualified slug/ prefix
    if not name:
        return None
    if name.endswith(".md"):
        name = name[:-3]
    name = name.lower()
    nd = BASE_DIR / slug / "notes"
    if not nd.is_dir():
        return None
    cands = []
    for f in nd.glob("*.md"):
        stem = f.stem.lower()
        if stem == name:
            return f.name  # exact (already canonical) — unambiguous
        hhmm, _, ident = stem.partition("-")
        if name in (ident, hhmm):  # bare id, or HHMM time
            cands.append(f.name)
    return cands[0] if len(cands) == 1 else None


def resolve_read_target(current_slug: str, target: str) -> tuple[str | None, str | None]:
    """Which conference a cross-conference read should hit, as (slug, error).
    Empty target → the current conference. A valid slug → that conference. A
    NON-empty INVALID slug → (None, error) so the caller surfaces 'no such
    conference' instead of silently answering from the current one."""
    target = (target or "").strip()
    if not target:
        return (current_slug or "", None)
    if load_agenda(target):
        return (target, None)
    return (None, f"No such conference: {target}. Call list_conferences for valid slugs.")


# Agent scratch space. Flat, sanitized filenames only (no slashes → no
# traversal). `slug=""` → vault-global agent dir; a conference slug → that
# conference's sources dir, so fetched agenda JSON/HTML lands next to the
# conference it built (provenance + debuggability).
ARTIFACT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")


def agent_artifact_path(name: str, slug: str = "") -> Path | None:
    name = (name or "").strip()
    if not ARTIFACT_RE.match(name) or name in (".", ".."):
        return None
    if slug:
        if not (CONF_RE.match(slug) and (BASE_DIR / slug).is_dir()):
            return None
        base = BASE_DIR / slug / ".confnote" / "sources"
    else:
        base = BASE_DIR / ".confnote" / "agent"
    p = (base / name).resolve()
    if base.resolve() not in p.parents:
        return None  # belt + braces — ARTIFACT_RE already bars traversal
    return p


def files_payload(slug: str, fname: str):
    p = note_path(slug, fname)
    if not p:
        return None
    adir = p.parent / "assets" / p.stem
    out = []
    if adir.is_dir():
        for f in sorted(adir.iterdir()):
            if not f.is_file() or f.name == "README.txt" or f.suffix == ".tmp":
                continue
            rel = f"assets/{p.stem}/{f.name}"
            out.append(
                {
                    "name": f.name,
                    "size": f.stat().st_size,
                    "is_image": f.suffix.lower() in IMG_EXT,
                    "rel": rel,
                    "url": f"/assets?slug={slug}&path={rel}",
                }
            )
    return {"dir": f"notes/assets/{p.stem}/", "files": out}


# Hint/placeholder text the importer seeds into the AI-driven sections
# (kept in sync with tools/import_agenda.write_note). A note that still holds
# only these seeds is NOT populated — otherwise every freshly imported session
# would light the "has notes" tick.
_SEED_MARKERS = (
    "AI-driven — seeded from the agenda",
    "Speaker & company dossier — run tools/research.py",
    "Agent-owned. Live notes and follow-up research land here.",
    "Tasks and follow-ups — `- [ ] task` lines",
)


def _section_has_real_content(name: str, body: str) -> bool:
    """Whether a section holds real (non-seed) content. Actions counts only
    with a genuine checkbox item; the AI sections discount the importer's hint
    text and Summary's seeded `> description` blockquote."""
    body = (body or "").strip()
    if not body:
        return False
    if name == "Actions":
        return bool(parse_actions(body))
    for line in body.splitlines():
        s = line.strip()
        if not s or any(m in s for m in _SEED_MARKERS):
            continue
        if name == "Summary" and s.startswith(">"):
            continue  # seeded description blockquote, not user content
        return True
    return False


def has_content(p: Path) -> bool:
    """True if the session note carries any real content. Previously this only
    looked at `Human notes`, so a session whose substance lived in Summary /
    Research / AI notes / Transcript / Actions / Scratchpad never lit the green
    "has notes" tick. Links is excluded: the importer seeds it from the agenda,
    and user-added URLs are mirrored from (and remain in) Human notes."""
    _, _, secs = parse_note(p.read_text())
    return any(
        _section_has_real_content(name, secs.get(name) or "")
        for name in CANON_SECTIONS
        if name != "Links"
    )


def conferences_payload():
    items = []
    for d in conf_dirs():
        data = load_agenda(d.name)
        if not data:
            continue
        conf = data["conference"]
        events = [e for e in data["events"] if notable(e)]
        with_notes = 0
        for e in events:
            try:
                fn = note_file_for_event(e)
            except (ValueError, KeyError, TypeError):
                continue
            p = d / "notes" / fn
            if p.exists() and has_content(p):
                with_notes += 1
        items.append(
            {
                "slug": d.name,
                "name": conf["name"],
                "date": conf["date"],
                "tagline": conf.get("tagline", ""),
                "venue": conf.get("venue", {}).get("name", ""),
                "sessions": len(events),
                "with_notes": with_notes,
            }
        )
    return items


def conference_payload(slug: str):
    data = load_agenda(slug)
    if not data:
        return None
    speakers = data.get("speakers", {})
    out_events = []
    for e in data["events"]:
        displayed = effective_event(data, e)
        ev = {
            "id": e["id"],
            "type": e.get("type"),
            "title": e["title"],
            "start": displayed["start"],
            "end": displayed["end"],
            "room": e.get("room", ""),
            "track": e.get("track", ""),
            "description": e.get("description", ""),
            "tags": e.get("tags", []),
            "speakers": [speaker_label(i, speakers) for i in e.get("speakers", [])],
        }
        if notable(e):
            try:
                fn = note_file_for_event(e)
            except (ValueError, KeyError, TypeError):
                continue
            ev["note"] = fn
            p = BASE_DIR / slug / "notes" / fn
            ev["has_notes"] = p.exists() and has_content(p)
            ev["attending"] = p.exists() and _is_pick(parse_note(p.read_text())[0])
        out_events.append(ev)
    return {
        "conference": data["conference"],
        "rooms": data.get("rooms", []),
        "tracks": data.get("tracks", []),
        "sources": data.get("sources", []),
        "events": out_events,
        "chat": True,
        "schedule_offset_minutes": _schedule_offset_or_zero(data.get("schedule_offset_minutes", 0)),
        "schedule_revision": _schedule_revision_or_zero(data.get("schedule_revision", 0)),
    }


# An agenda.json from a shared vault or an import is untrusted: the UI only ever
# receives integers for the schedule fields (an agenda with no events skips the
# per-event check in effective_event).
def _schedule_offset_or_zero(value) -> int:
    try:
        return _schedule_integer(value, "schedule_offset_minutes")
    except ValueError:
        return 0


def _schedule_revision_or_zero(value) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return 0
    return value


# ---------- debrief action items ----------


def parse_actions(debrief: str):
    """Pull `- [ ] text` / `- [x] text` lines out of a Debrief body.
    `*` bullets and an uppercase `[X]` count too; done iff x/X.
    A checkbox with empty/whitespace text is a placeholder, not an action."""
    items = []
    for line in (debrief or "").split("\n"):
        m = ACTION_RE.match(line)
        if m:
            text = m.group(2).strip()
            if text:
                items.append({"text": text, "done": m.group(1).lower() == "x"})
    return items


def actions_payload(slug: str):
    """Aggregate open/total action items across a conference's notes,
    plus any unsorted items in INBOX.md (synthetic "Inbox" entry, shown
    at the top). Mirrors conference_payload: iterate notable events,
    read each note's Actions section, keep only sessions with ≥1 action."""
    data = load_agenda(slug)
    if not data:
        return None
    # Ensure any `## Action Items` the debrief wrote are mirrored into INBOX
    # before we aggregate. Idempotent (deduped) — a no-op once filed — so the
    # debrief's follow-ups always show up here without needing to re-run
    # /debrief, even for a DEBRIEF.md written before this feature existed.
    try:
        sync_debrief_actions_to_inbox(slug)
    except Exception:
        pass
    sessions, open_n, total_n = [], 0, 0

    # Inbox first (when present + non-empty) so unsorted items stay visible.
    inbox_p = BASE_DIR / slug / INBOX_NAME
    if inbox_p.exists():
        inbox_items = parse_actions(_inbox_read_actions(inbox_p))
        if inbox_items:
            inbox_open = sum(1 for it in inbox_items if not it["done"])
            sessions.append(
                {
                    "note": INBOX_NAME,
                    "title": "Inbox",
                    "time": "—",
                    "open": inbox_open,
                    "total": len(inbox_items),
                    "items": inbox_items,
                    "inbox": True,
                }
            )
            open_n += inbox_open
            total_n += len(inbox_items)

    for e in data["events"]:
        if not notable(e):
            continue
        fn = note_file_for_event(e)
        p = BASE_DIR / slug / "notes" / fn
        if not p.exists():
            continue
        _, _, secs = parse_note(p.read_text())
        items = parse_actions(secs.get("Actions", ""))
        if not items:
            continue
        s_open = sum(1 for it in items if not it["done"])
        sessions.append(
            {
                "note": fn,
                "title": e["title"],
                "time": e["start"][11:16],
                "open": s_open,
                "total": len(items),
                "items": items,
            }
        )
        open_n += s_open
        total_n += len(items)
    return {"open": open_n, "total": total_n, "sessions": sessions}


# ---------- picks: "attending" lives in the session note's frontmatter ----------
# One plan everywhere: the agenda stars, My Agenda, the Planner, auto-record and
# both Concierges read the same `attending: true` line, so a pick travels with
# the notebook (sync, export) instead of living in one browser's storage. The
# hosted twin is web-app/lib/service.ts (picksPayload / putPicks).
PICK_KEY = "attending"
FRONTMATTER_FENCE = "---"


def _is_pick(fm: dict) -> bool:
    return str(fm.get(PICK_KEY, "")).strip().lower() == "true"


def with_frontmatter_flag(text: str, key: str, on: bool) -> str:
    """`text` with `key: true` set (on) or removed (off) in its frontmatter.
    Only the frontmatter block changes; the body stays byte for byte."""
    lines = text.split("\n")
    if not lines or lines[0].strip() != FRONTMATTER_FENCE:
        return f"{FRONTMATTER_FENCE}\n{key}: true\n{FRONTMATTER_FENCE}\n{text}" if on else text
    end = next((i for i in range(1, len(lines)) if lines[i].strip() == FRONTMATTER_FENCE), None)
    if end is None:
        # A frontmatter block that never closes: the body would read as
        # frontmatter, so refuse rather than drop a body line.
        raise ValueError("The note's frontmatter has no closing ---; fix the note first.")
    kept = [line for line in lines[1:end] if line.partition(":")[0].strip() != key]
    if on:
        kept.append(f"{key}: true")
    return "\n".join([lines[0], *kept, *lines[end:]])


def _pickable_notes(data: dict) -> list[str]:
    files = []
    for e in data.get("events", []):
        if not notable(e):
            continue
        try:
            files.append(note_file_for_event(e))
        except (ValueError, KeyError, TypeError):
            continue
    return files


def read_picks(slug: str) -> list[str] | None:
    """The conference's picked session notes, sorted; None if no such conference."""
    data = load_agenda(slug)
    if not data:
        return None
    picked = []
    for fn in _pickable_notes(data):
        p = BASE_DIR / slug / "notes" / fn
        if p.exists() and _is_pick(parse_note(p.read_text())[0]):
            picked.append(fn)
    return sorted(picked)


def set_picks(slug: str, picks) -> dict | None:
    """Apply {note_file: bool} to the conference's notes. Unknown files are an
    error (nothing is written); None if no such conference."""
    data = load_agenda(slug)
    if not data:
        return None
    if not isinstance(picks, dict) or not all(isinstance(v, bool) for v in picks.values()):
        raise ValueError("picks must map note files to true or false.")
    known = set(_pickable_notes(data))
    unknown = [fn for fn in picks if fn not in known or not note_path(slug, fn)]
    if unknown:
        raise ValueError(f"Not a session note of {slug}: {', '.join(sorted(unknown))}")
    changed = {}
    with _NOTE_WRITE_LOCK:
        for fn, on in picks.items():
            p = note_path(slug, fn)
            text = p.read_text()
            if _is_pick(parse_note(text)[0]) == on:
                continue
            atomic_write(p, with_frontmatter_flag(text, PICK_KEY, on))
            changed[fn] = p.stat().st_mtime
    return {"slug": slug, "notes": read_picks(slug), "changed": changed}


# ---------- chat: section-preserving writes & conference scope ----------


def _now() -> datetime:
    """Override-able 'now' for tests (CONF_NOW=ISO8601)."""
    override = os.environ.get("CONF_NOW")
    if override:
        try:
            dt = datetime.fromisoformat(override)
            return dt if dt.tzinfo else dt.replace(tzinfo=UTC)
        except ValueError:
            pass
    return datetime.now(UTC)


def _parse_iso(s: str):
    """Agenda timestamps carry an offset ('...+01:00'); fall back to naive
    -> UTC so comparisons never raise."""
    try:
        dt = datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def conf_status(data: dict, now: datetime | None = None) -> str:
    """One human line: where we are in the conference vs `now`.

    pre-conference  -> "Pre-conference — starts in 2h 10m (09:30)."
    live            -> "LIVE: 'Opening Keynote' (until 10:10). Next: …"
    between events  -> "Between sessions — next 'Coffee' at 10:40 (in 15m)."
    post-conference -> "Post-conference — ended 3h ago."
    """
    now = now or _now()
    evs = sorted(
        (
            effective_event(data, e)
            for e in data.get("events", [])
            if e.get("start") and e.get("end")
        ),
        key=lambda e: e["start"],
    )
    if not evs:
        return "No scheduled events."
    starts = [_parse_iso(e["start"]) for e in evs]
    ends = [_parse_iso(e["end"]) for e in evs]
    first = min((start for start in starts if start), default=None)
    last = max((end for end in ends if end), default=None)

    minutes_per_day = 24 * 60

    def human(delta_s: float) -> str:
        m = int(abs(delta_s) // 60)
        if m < 60:
            return f"{m}m"
        if m >= minutes_per_day:
            days = m // minutes_per_day
            return "1 day" if days == 1 else f"{days} days"
        return f"{m // 60}h {m % 60}m" if m % 60 else f"{m // 60}h"

    if first and now < first:
        return (
            f"Pre-conference — starts in {human((first - now).total_seconds())} "
            f"({evs[0]['start'][11:16]}, {evs[0]['title']})."
        )
    if last and now >= last:
        return f"Post-conference — ended {human((now - last).total_seconds())} ago."
    # somewhere in the day: find a live event, else the next one
    live = [e for e, s, en in zip(evs, starts, ends, strict=True) if s and en and s <= now < en]
    talks = [e for e in live if e.get("type") not in ("break", "networking", "logistics")]
    current = sorted(talks or live, key=lambda e: e["start"], reverse=True)
    if current:
        labels = [f"'{e['title']}' (until {e['end'][11:16]})" for e in current]
        return "LIVE: " + "; ".join(labels) + ". " + _next_line(evs, starts, now)
    return "Between sessions — " + _next_line(evs, starts, now)


def _next_line(evs, starts, now) -> str:
    for e, s in zip(evs, starts, strict=True):
        if s and s > now:
            mins = int((s - now).total_seconds() // 60)
            when = f"in {mins}m" if mins < 60 else f"at {e['start'][11:16]}"
            return f"Next: '{e['title']}' {when}."
    return "No more sessions today."


def _event_for_note(data: dict, fname: str):
    for e in data.get("events", []):
        if not notable(e):
            continue
        if note_file_for_event(e) == fname:
            return e
    return None


# ---------- private-commentary passphrase params ----------
# The passphrase and derived key NEVER reach the server — encryption is
# client-side (WebCrypto). We persist only what the browser needs to re-derive
# and verify the key on a later session: the KDF salt + iteration count and a
# small verifier (a known token encrypted under the key). Stored per-vault so
# it travels with the encrypted notes. Forgetting the passphrase is, by design,
# unrecoverable — there is nothing here that can decrypt without it.
PRIVATE_CONFIG_KEYS = {"v", "salt", "iterations", "kdf", "verifier_iv", "verifier_ct"}


def private_config_path() -> Path:
    return BASE_DIR / ".confnote" / "private.json"


def read_private_config() -> dict | None:
    p = private_config_path()
    if not p.is_file():
        return None
    try:
        cfg = json.loads(p.read_text())
        return cfg if isinstance(cfg, dict) else None
    except Exception:
        return None


def write_private_config(cfg: dict) -> None:
    p = private_config_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(p, json.dumps(cfg))


def strip_private(text: str) -> str:
    """Return a note's markdown with the Private section blanked — used on every
    path that feeds note content to the agent. The Private body is encrypted
    ciphertext, but we never even hand the agent the blob: blank it, so private
    commentary is invisible to the concierge by construction."""
    fm, title, secs = parse_note(text)
    if not secs.get(PRIVATE_SECTION):
        return text
    secs[PRIVATE_SECTION] = ""
    return build_note(fm, title, secs)


def apply_note_section(p: Path, name: str, text: str) -> str:
    """Re-read from disk and rewrite ONLY `name` — every other section
    (including live agent/human edits) is preserved."""
    fm, title, secs = parse_note(p.read_text())
    secs[name] = (text or "").strip()
    atomic_write(p, build_note(fm, title, secs))
    return f"{name} section updated in {p.name}."


def conf_doc_path(slug: str, name: str) -> Path | None:
    """Path to a conference-level BRIEF.md / DEBRIEF.md, validated."""
    if not CONF_RE.match(slug) or name not in ("BRIEF.md", "DEBRIEF.md"):
        return None
    d = BASE_DIR / slug
    return d / name if d.is_dir() else None


# ---------- conference-level INBOX (unsorted actions) ----------
# When the user runs `/action ...` outside any session context, the item
# lands in <conf>/INBOX.md instead of falling on the floor. The Actions
# rollup surfaces INBOX entries as a synthetic "Inbox" session at the
# top of the list. Same `- [ ] text` shape as the per-session Actions
# section, so the existing tickRemoteAction / parse_actions machinery
# all works against it.

INBOX_NAME = "INBOX.md"


def inbox_path(slug: str) -> Path | None:
    if not CONF_RE.match(slug):
        return None
    d = BASE_DIR / slug
    return d / INBOX_NAME if d.is_dir() else None


def _inbox_read_actions(p: Path) -> str:
    if not p.exists():
        return ""
    text = p.read_text()
    # Same section parser as a note — INBOX.md is just a tiny note shape
    # without frontmatter. parse_note tolerates a missing FM block.
    _, _, secs = parse_note(text)
    return secs.get("Actions", "")


def append_inbox_action(slug: str, item: str) -> Path | None:
    p = inbox_path(slug)
    if not p:
        return None
    body = (item or "").strip()
    if not body:
        return p
    line = body if body.startswith("- [") else f"- [ ] {body}"
    existing = _inbox_read_actions(p).rstrip()
    new_actions = (existing + "\n" + line).strip() if existing else line
    # Rebuild file with a stable shape. We don't go through parse_note /
    # build_note because INBOX isn't a session note (no canonical section
    # ordering). Keep it small and human-editable.
    p.write_text(f"# Inbox\n\n## Actions\n\n{new_actions}\n")
    return p


def _norm_action(text: str) -> str:
    """Normalize an action's text for dedup: drop markdown emphasis/links and
    collapse whitespace/trailing punctuation so cosmetic rewrites between
    /debrief runs don't create duplicate inbox entries."""
    t = (text or "").lower()
    t = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", t)  # [label](url) -> label
    t = re.sub(r"[*`_]", "", t)  # strip emphasis / code ticks
    t = re.sub(r"\s+", " ", t).strip()
    return t.rstrip(".!,;: ")


def _extract_md_section(text: str, headings: tuple) -> str:
    """Return the body of the first `## <heading>` block whose (emphasis-
    stripped, lowercased) title is in `headings`, up to the next heading."""
    out, capturing = [], False
    for line in (text or "").split("\n"):
        m = re.match(r"^#{1,6}\s+(.*)$", line)
        if m:
            if capturing:
                break  # next heading closes the section
            title = re.sub(r"[*`_]", "", m.group(1)).strip().lower()
            capturing = title in headings
            continue
        if capturing:
            out.append(line)
    return "\n".join(out).strip()


# Headings the debrief may use for its rolled-up follow-ups.
_DEBRIEF_ACTION_HEADINGS = ("action items", "actions", "next steps", "follow-ups", "follow ups")


def sync_debrief_actions_to_inbox(slug: str) -> int:
    """After /debrief, copy the DEBRIEF.md action-items checkboxes into
    INBOX.md so they surface (and tick) in the ✔ Actions rollup. Deduped by
    normalized text → re-running /debrief won't pile up. The narrative list
    stays in DEBRIEF.md; INBOX holds the tickable copy. Returns # added."""
    if not slug:
        return 0
    text = read_conf_doc(slug, "DEBRIEF.md")
    section = _extract_md_section(text or "", _DEBRIEF_ACTION_HEADINGS)
    items = parse_actions(section)
    if not items:
        return 0
    inbox_p = inbox_path(slug)
    if not inbox_p:
        return 0
    seen = {_norm_action(it["text"]) for it in parse_actions(_inbox_read_actions(inbox_p))}
    added = 0
    for it in items:
        key = _norm_action(it["text"])
        if not key or key in seen:
            continue
        append_inbox_action(slug, it["text"])
        seen.add(key)
        added += 1
    return added


def append_transcript(
    slug: str, note_file: str, text: str, recording: str = "", source: str = ""
) -> Path | None:
    """Append `text` to a session note's Transcript section (preserving any
    existing transcript), and stamp the `recording:`/`transcript:` frontmatter.
    Returns the path, or None on bad input / empty text."""
    p = note_path(slug, note_file)
    if not p:
        return None
    body = (text or "").strip()
    if not body:
        return p
    fm, title, secs = parse_note(p.read_text())
    existing = (secs.get("Transcript") or "").rstrip()
    secs["Transcript"] = (existing + "\n\n" + body).strip() if existing else body
    if recording:
        fm["recording"] = recording
    if source:
        fm["transcript"] = source
    atomic_write(p, build_note(fm, title, secs))
    return p


def append_session_action(slug: str, note_file: str, item: str) -> Path | None:
    """Append `- [ ] item` to a session note's Actions section, preserving
    everything else. Returns the path on success, None on bad input."""
    p = note_path(slug, note_file)
    if not p:
        return None
    body = (item or "").strip()
    if not body:
        return p
    line = body if body.startswith("- [") else f"- [ ] {body}"
    fm, title, secs = parse_note(p.read_text())
    existing = (secs.get("Actions") or "").rstrip()
    secs["Actions"] = (existing + "\n" + line).strip() if existing else line
    atomic_write(p, build_note(fm, title, secs))
    return p


# ---------- block recording → one slice per session ----------
# One continuous Cat recording covers a block of sessions. After Stop it is
# transcribed with segment times, `recording_split` finds the boundaries, and
# each padded slice is filed beside its note (audio in notes/assets/<stem>/,
# header + timed lines appended to ## Transcript).

SLICE_PAD_S = 30
# The Cat transcribes the whole block before its job completes.
BLOCK_POLL_TIMEOUT_S = 3600.0
AUTO_TICK_S = 20

_BLOCK_LOCK = threading.RLock()
_BLOCKS: dict = {}  # slug → {id, started_at, notes, room, auto}
_AUTO: dict = {}  # slug → starred note files (pushed by the page)
_AUTO_THREAD: list = []


def block_events(slug: str, start_wall, end_wall, notes=None, room: str = "") -> list:
    """Sessions of `slug` inside [start_wall, end_wall], in agenda order, in the
    shape `recording_split.find_boundaries` reads. `notes` (starred files)
    narrows the set; otherwise one room: `room`, or the busiest in the window."""
    agenda = load_agenda(slug)
    if not agenda:
        return []
    speakers = agenda.get("speakers") or {}
    picked = []
    for raw in agenda.get("events", []):
        if not notable(raw):
            continue
        ev = effective_event(agenda, raw)
        fname = f"{raw['start'][11:13]}{raw['start'][14:16]}-{raw['id']}.md"
        s, e = datetime.fromisoformat(ev["start"]), datetime.fromisoformat(ev["end"])
        if e <= start_wall or s >= end_wall or not note_path(slug, fname):
            continue
        if notes and fname not in notes:
            continue
        people = [speakers.get(sid) or {"name": sid} for sid in raw.get("speakers", [])]
        picked.append(
            {
                "note": fname,
                "title": raw.get("title", ""),
                "speakers": [p.get("name") or "" for p in people],
                "orgs": [p.get("company") for p in people if p.get("company")],
                "start": ev["start"],
                "end": ev["end"],
                "room": raw.get("room", ""),
            }
        )
    if not notes:
        rooms = [ev["room"] for ev in picked]
        target = room or (max(set(rooms), key=rooms.count) if rooms else "")
        picked = [ev for ev in picked if ev["room"] == target]
    return sorted(picked, key=lambda ev: ev["start"])


def file_slices(
    slug: str,
    block_path,
    cuts,
    segments,
    *,
    duration: float,
    gaps=(),
    events=(),
    pad: int = SLICE_PAD_S,
    cutter=recording_flow.cut_slice,
) -> list:
    """Cut and file one slice per cut. Appends (never overwrites) the header +
    the slice's lines to ## Transcript and stamps recording / recording_full /
    transcript. Idempotent: a note already holding a slice of this block file
    is skipped."""
    import recording_split

    block_path = str(block_path)
    by_note = {ev["note"]: ev for ev in events}
    gap_s = recording_flow.gap_total(gaps)
    out = []
    for sl in recording_split.plan_slices(cuts, duration, pad=pad):
        cut = sl.cut
        p = note_path(slug, cut.note)
        row = {"note": cut.note, "confidence": cut.confidence}
        if not p:
            out.append({**row, "status": "error", "error": "unknown note"})
            continue
        fm, _title, _secs = parse_note(p.read_text())
        if fm.get("recording_full") == block_path:
            out.append({**row, "status": "skipped", "recording": fm.get("recording", "")})
            continue
        name = recording_flow.slice_name(sl.wall_start)
        dest = p.parent / "assets" / p.stem / name
        try:
            cutter(block_path, dest, sl.start, sl.end - sl.start)
        except Exception as e:
            out.append({**row, "status": "error", "error": str(e)})
            continue
        text = recording_flow.transcript_block(
            sl,
            f"assets/{p.stem}/{name}",
            segments,
            by_note.get(cut.note),
            gap_s,
        )
        rel = f"notes/assets/{p.stem}/{name}"
        append_transcript(slug, cut.note, text, recording=rel, source="local-ai-cat")
        fm, title, secs = parse_note(p.read_text())
        fm["recording_full"] = block_path
        atomic_write(p, build_note(fm, title, secs))
        out.append({**row, "status": "filed", "recording": rel})
    return out


def _segments_cache(slug: str, audio: Path) -> Path:
    return BASE_DIR / slug / ".confnote" / "recordings" / f"{audio.stem}.segments.json"


def _timed_segments(slug: str, audio: Path) -> list:
    """Segments for `audio`: the cached copy, else ask the Cat (verbose_json).
    Empty on failure; the caller then falls back to agenda times."""
    cache = _segments_cache(slug, audio)
    if cache.is_file():
        try:
            return transcription.segments_from_payload(json.loads(cache.read_text()))
        except Exception:
            pass
    cfg = transcription.provider_cfg(read_settings())
    try:
        segs = transcription.transcribe_segments(
            cfg, audio.read_bytes(), audio.name, MIME.get(audio.suffix, "audio/mp4")
        )
    except Exception:
        return []
    if segs:
        cache.parent.mkdir(parents=True, exist_ok=True)
        rows = [{"start": t0, "end": t1, "text": text} for t0, t1, text in segs]
        atomic_write(cache, json.dumps({"segments": rows}))
    return segs


def split_block(
    slug: str, audio_path: str, *, notes=None, room: str = "", segments=None, started_at=None
) -> dict:
    """Split one block recording into per-session slices and file them."""
    import recording_split

    audio = Path(audio_path).expanduser()
    if not audio.is_file():
        raise FileNotFoundError("recording not found")
    birth, mtime = recording_flow.birth_and_mtime(audio)
    # Lid-shut gaps are read on the file's own clock; an explicit start
    # (a copied file, a wrong birth time) moves them along with it.
    shift = (started_at - birth) if started_at else timedelta(0)
    started_at = started_at or birth
    gaps = [
        recording_split.Gap(g.start + shift, g.end + shift)
        for g in recording_split.clamshell_gaps(birth, mtime)
    ]
    duration = recording_flow.audio_duration(audio)
    end_wall = recording_split.wall_time(duration, started_at, gaps)
    events = block_events(slug, started_at, end_wall, notes=notes, room=room)
    if not events:
        return {"ok": True, "results": [], "fallback": False, "detail": "no sessions in this block"}
    if segments is None:
        segments = _timed_segments(slug, audio)
    # No segments: find_boundaries cuts at agenda times, marked low.
    fallback = not segments
    segments = segments or []
    cuts = recording_split.find_boundaries(segments, events, started_at=started_at, gaps=gaps)
    results = file_slices(
        slug,
        audio,
        cuts,
        segments,
        duration=duration,
        gaps=gaps,
        events=events,
    )
    detail = "no timed transcript; cut at agenda times (low confidence)" if fallback else ""
    return {"ok": True, "results": results, "fallback": fallback, "detail": detail}


def block_status(slug: str) -> dict:
    with _BLOCK_LOCK:
        b = _BLOCKS.get(slug)
    if not b:
        return {"recording": False}
    return {"recording": True, "started_at": b["started_at"].isoformat(), "auto": b["auto"]}


def start_block(slug: str, notes=None, auto: bool = False) -> dict:
    with _BLOCK_LOCK:
        if slug in _BLOCKS:
            return block_status(slug)
        cfg = transcription.provider_cfg(read_settings())
        job = transcription.start_recording(cfg)
        _BLOCKS[slug] = {
            "id": job.get("id"),
            "started_at": datetime.now(UTC),
            "notes": list(notes or []),
            "auto": auto,
        }
    return block_status(slug)


def stop_block(slug: str) -> dict:
    """Stop the Cat recording, then split + file it. Segments in the Cat's
    job (when it sends them) save a second transcription pass."""
    with _BLOCK_LOCK:
        b = _BLOCKS.pop(slug, None)
    if not b:
        raise LookupError("no block recording running")
    cfg = transcription.provider_cfg(read_settings())
    job = transcription.stop_recording(cfg, b["id"], poll_timeout=BLOCK_POLL_TIMEOUT_S)
    audio = job.get("audioPath") or ""
    if not audio:
        raise RuntimeError("the Cat returned no audio file")
    segs = transcription.segments_from_payload(job) or None
    out = split_block(slug, audio, notes=b["notes"] or None, segments=segs)
    return {**out, "audio_path": audio}


def auto_enabled() -> bool:
    return bool(read_settings(resolve_key=False).get("transcription", {}).get("auto_record_block"))


def auto_tick(now=None) -> None:
    """One pass of the auto-record timer: start a block at the first starred
    session − 2 min, stop + split at the last starred end + 3 min."""
    if not auto_enabled():
        return
    now = now or datetime.now(UTC)
    for slug in list(_AUTO):
        notes = read_picks(slug) or []
        # Starred sessions of today (in the agenda's own zone) make the block.
        day = [
            ev
            for ev in block_events(slug, now - timedelta(days=1), now + timedelta(days=1), notes)
            if datetime.fromisoformat(ev["start"]).date()
            == now.astimezone(datetime.fromisoformat(ev["start"]).tzinfo).date()
        ]
        win = recording_flow.window(day) if notes else None
        with _BLOCK_LOCK:
            running = _BLOCKS.get(slug)
        try:
            if win and win[0] <= now < win[1] and not running:
                start_block(slug, notes, auto=True)
            elif running and running["auto"] and (not win or now >= win[1]):
                stop_block(slug)
        except Exception as e:
            print(f"[confnote] auto-record {slug}: {e}", file=sys.stderr)


def _auto_loop() -> None:
    while True:
        auto_tick()
        time.sleep(AUTO_TICK_S)


def set_auto_notes(slug: str, notes) -> None:
    """The page registers a conference for auto-record. The timer reads the
    picks from the notes themselves (read_picks); `notes` is what the page
    showed, kept for the status reply."""
    _AUTO[slug] = [n for n in notes or [] if isinstance(n, str)]
    if not _AUTO_THREAD:
        t = threading.Thread(target=_auto_loop, name="auto-record", daemon=True)
        _AUTO_THREAD.append(t)
        t.start()


# ---------- app settings (provider config, etc.) ----------
# Stored server-side at <vault>/.confnote/settings.json (same .confnote/
# convention the Local AI Cat handover uses). Secrets (API keys) NEVER go
# to the browser: GET returns has_api_key:bool, never the raw key. This is
# the write-only-key pattern the transcription handover calls for.

CONFIG_DIR = BASE_DIR / ".confnote"
SETTINGS_PATH = CONFIG_DIR / "settings.json"

# Shape is extensible; transcription is the first (and currently only)
# section. `provider` selects local (Local AI Cat) vs remote (OpenAI) —
# both speak the same OpenAI-compatible /v1/audio/transcriptions surface,
# so only base_url + key + model differ.
_DEFAULT_SETTINGS = {
    "transcription": {
        "provider": "local",
        "local_base_url": "http://127.0.0.1:11434",
        "openai_base_url": "https://api.openai.com",
        "model": "whisper-1",
        "api_key": "",
        # When local (Cat): whether the transcription is kept in Cat's own
        # history. Default off — confnote keeps the audio + transcript in the
        # conference folder, so Cat history would just be a duplicate.
        "save_in_cat_history": False,
        # Record one block over the starred sessions (first start − 2 min to
        # last end + 3 min) and split it per session. Off by default.
        "auto_record_block": False,
    }
}


def read_settings(resolve_key: bool = True) -> dict:
    """Full settings INCLUDING secrets — server-side use only. For anything
    that reaches the browser, use public_settings().

    The API key is resolved from the Keychain when available (it's kept out
    of settings.json entirely); otherwise it comes from the file."""
    out = json.loads(json.dumps(_DEFAULT_SETTINGS))  # deep copy of defaults
    if SETTINGS_PATH.is_file():
        try:
            disk = json.loads(SETTINGS_PATH.read_text()) or {}
        except Exception:
            disk = {}
        for k, v in disk.items():
            if isinstance(v, dict) and isinstance(out.get(k), dict):
                out[k].update(v)
            else:
                out[k] = v
    if resolve_key and keychain.available():
        # Keychain is the source of truth for the key; the file shouldn't
        # hold one, but prefer the Keychain value regardless.
        out["transcription"]["api_key"] = keychain.get_key() or ""
    return out


def public_settings() -> dict:
    """Browser-safe view: the raw api_key is dropped and replaced with a
    has_api_key boolean."""
    s = read_settings(resolve_key=False)
    tr = dict(s.get("transcription") or {})
    file_key = bool(tr.pop("api_key", ""))
    use_keychain = keychain.available()
    tr["has_api_key"] = keychain.has_key() if use_keychain else file_key
    tr["key_storage"] = "keychain" if use_keychain else "file"
    s["transcription"] = tr
    return s


def write_settings(patch: dict) -> dict:
    """Merge `patch` into settings. API-key semantics:
      - api_key present + non-empty  → set it
      - clear_api_key: true          → wipe it
      - api_key absent/empty         → leave the existing key untouched
    Returns public_settings() (never echoes the key back)."""
    use_keychain = keychain.available()
    cur = read_settings(resolve_key=not use_keychain)
    tr = cur.get("transcription") or {}
    tr_patch = dict((patch or {}).get("transcription") or {})
    clear = bool(tr_patch.pop("clear_api_key", False))
    incoming_key = tr_patch.pop("api_key", None)
    for k in ("provider", "local_base_url", "openai_base_url", "model"):
        if k in tr_patch and isinstance(tr_patch[k], str):
            tr[k] = tr_patch[k].strip()
    for flag in ("save_in_cat_history", "auto_record_block"):
        if flag in tr_patch:
            tr[flag] = bool(tr_patch[flag])
    if tr.get("provider") not in ("local", "openai"):
        tr["provider"] = "local"

    # Key routing: prefer the Keychain. When it's available the key NEVER
    # lands in settings.json (avoids syncing it via iCloud Documents).
    if clear:
        if use_keychain:
            keychain.delete_key()
        tr["api_key"] = ""
    elif incoming_key:
        new_key = incoming_key.strip()
        if use_keychain and keychain.set_key(new_key):
            tr["api_key"] = ""  # stored in Keychain, not the file
        else:
            tr["api_key"] = new_key  # fallback: chmod-600 file
    elif use_keychain:
        tr["api_key"] = ""  # never persist a key to the file under Keychain mode

    cur["transcription"] = tr
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    atomic_write(SETTINGS_PATH, json.dumps(cur, indent=2))
    try:
        os.chmod(SETTINGS_PATH, 0o600)  # belt + braces even with Keychain on
    except Exception:
        pass
    return public_settings()


def test_transcription_connection() -> dict:
    """Probe the configured provider so the settings UI can show a live
    status. Local → GET /health (unauthenticated). Remote → GET /v1/models
    with the bearer key. stdlib-only (urllib), no multipart needed here."""
    import urllib.error
    import urllib.request

    s = read_settings().get("transcription", {})
    provider = s.get("provider")
    try:
        if provider == "openai":
            base = (s.get("openai_base_url") or "").rstrip("/")
            key = s.get("api_key") or ""
            if not key:
                return {"ok": False, "detail": "No API key set."}
            req = urllib.request.Request(
                f"{base}/v1/models", headers={"Authorization": f"Bearer {key}"}
            )
        else:
            base = (s.get("local_base_url") or "").rstrip("/")
            req = urllib.request.Request(f"{base}/health")
        with urllib.request.urlopen(req, timeout=5) as r:
            code = getattr(r, "status", r.getcode())
            return {"ok": 200 <= code < 300, "detail": f"HTTP {code}"}
    except urllib.error.HTTPError as e:
        hint = " (check the API key)" if provider == "openai" and e.code in (401, 403) else ""
        return {"ok": False, "detail": f"HTTP {e.code}{hint}"}
    except Exception as e:
        hint = "" if provider == "openai" else " — is Local AI Cat running?"
        return {"ok": False, "detail": f"{type(e).__name__}: {e}{hint}"}


# ---------- concierge chat history (durable JSONL) -------------------
# Single durable thread across the whole vault. Survives quit, relaunch,
# conference switch, drawer toggle. One JSON object per line:
#   {"ts": ISO8601, "role": "user|assistant", "text": "...", "scope": slug?}
# Lives at <CONF_NOTES_DIR>/.chat/concierge.jsonl. .chat/ is created on
# first append; the directory dot-prefix keeps it out of the conferences
# list (CONF_RE rejects names starting with `.`).

CHAT_HISTORY_DIR = BASE_DIR / ".chat"
CHAT_HISTORY_PATH = CHAT_HISTORY_DIR / "concierge.jsonl"
# Sidecar carrying the SDK session id for the ACTIVE thread, so a second
# turn can pass `resume=<id>` and skip cold-start + transcript re-feed.
# Cleared on archive / on resume — a new "active" thread always starts
# fresh from the SDK's perspective.
CHAT_SESSION_ID_PATH = CHAT_HISTORY_DIR / "concierge.session-id"


def read_active_session_id() -> str | None:
    if CHAT_SESSION_ID_PATH.is_file():
        sid = CHAT_SESSION_ID_PATH.read_text().strip()
        return sid or None
    return None


def write_active_session_id(sid: str) -> None:
    if not sid:
        return
    CHAT_HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    CHAT_SESSION_ID_PATH.write_text(sid)


def clear_active_session_id() -> None:
    if CHAT_SESSION_ID_PATH.is_file():
        CHAT_SESSION_ID_PATH.unlink()


def read_chat_history(limit: int | None = None) -> list[dict]:
    """Load chat history JSONL. `limit` returns only the last N entries."""
    if not CHAT_HISTORY_PATH.is_file():
        return []
    out: list[dict] = []
    for line in CHAT_HISTORY_PATH.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except Exception:
            continue  # tolerate a corrupt line — don't lose the rest
    if limit is not None and limit >= 0:
        return out[-limit:]
    return out


def append_chat_history(role: str, text: str, scope: str | None) -> None:
    """Append one turn to the concierge JSONL. Idempotent on dir creation."""
    text = (text or "").strip()
    if not text or role not in ("user", "assistant"):
        return
    CHAT_HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    rec = {
        "ts": datetime.now(UTC).isoformat(),
        "role": role,
        "text": text,
        "scope": scope or "",
    }
    with CHAT_HISTORY_PATH.open("a") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def recall_chat_history(query: str, limit: int = 8) -> list[dict]:
    """Grep the chat JSONL for case-insensitive matches. Returns up to
    `limit` matching turns, oldest first."""
    if not query or not query.strip():
        return []
    q = query.lower().strip()
    hits: list[dict] = []
    for rec in read_chat_history():
        if q in (rec.get("text") or "").lower():
            hits.append(rec)
    return hits[-limit:]


# ---------- chat thread archival ----------------------------------------
# Active thread lives at CHAT_HISTORY_PATH; archived threads live in
# .chat/archive/<timestamp>.jsonl. "New chat" archives the current file,
# "Resume" archives current + renames the chosen archive back to active.

CHAT_ARCHIVE_DIR = CHAT_HISTORY_DIR / "archive"
THREAD_ID_RE = re.compile(r"^[0-9A-Za-z_\-:T]+\.jsonl$")


def _thread_meta(path: Path) -> dict:
    """Derive {id, ts, title, turns, scope} for a thread file. Title is the
    first user message's first line, truncated; falls back to '(empty)'."""
    title = ""
    turns = 0
    last_scope = ""
    if path.is_file():
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            turns += 1
            last_scope = rec.get("scope") or last_scope
            if not title and rec.get("role") == "user":
                first = (rec.get("text") or "").strip().splitlines()
                if first:
                    title = first[0][:64]
    return {
        "id": path.name,
        "ts": path.stem,  # ISO-ish filename without extension
        "title": title or "(empty thread)",
        "turns": turns,
        "scope": last_scope,
    }


def list_chat_threads() -> dict:
    """Active thread + archived threads (newest archived first)."""
    active = _thread_meta(CHAT_HISTORY_PATH) if CHAT_HISTORY_PATH.is_file() else None
    archived: list[dict] = []
    if CHAT_ARCHIVE_DIR.is_dir():
        for p in sorted(CHAT_ARCHIVE_DIR.glob("*.jsonl"), reverse=True):
            archived.append(_thread_meta(p))
    return {"active": active, "archived": archived}


def archive_current_chat() -> dict | None:
    """Move the active thread to .chat/archive/<ts>.jsonl. No-op if the
    active thread is missing or empty. Returns the archived thread's meta.
    Also clears the active SDK session-id sidecar — a brand-new active
    thread starts a brand-new SDK session."""
    if not CHAT_HISTORY_PATH.is_file() or CHAT_HISTORY_PATH.stat().st_size == 0:
        clear_active_session_id()
        return None
    CHAT_ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(UTC).strftime("%Y-%m-%dT%H-%M-%SZ")
    target = CHAT_ARCHIVE_DIR / f"{ts}.jsonl"
    n = 0
    while target.exists():
        n += 1
        target = CHAT_ARCHIVE_DIR / f"{ts}-{n}.jsonl"
    CHAT_HISTORY_PATH.rename(target)
    clear_active_session_id()
    return _thread_meta(target)


def resume_chat(thread_id: str) -> dict | None:
    """Archive the current thread (if any), then restore the named archive
    as the active thread. Validated against THREAD_ID_RE to keep this from
    being a path-traversal foothold. The restored thread has no live SDK
    session associated with it, so we clear the session-id sidecar — the
    next chat turn will start a fresh SDK session that re-ingests the
    restored transcript (one cold turn; cheap thereafter)."""
    if not thread_id or not THREAD_ID_RE.match(thread_id):
        return None
    src = CHAT_ARCHIVE_DIR / thread_id
    if not src.is_file():
        return None
    if src.resolve().parent != CHAT_ARCHIVE_DIR.resolve():
        return None  # belt + braces vs symlink shenanigans
    archive_current_chat()
    src.rename(CHAT_HISTORY_PATH)
    clear_active_session_id()
    return _thread_meta(CHAT_HISTORY_PATH)


def read_conf_doc(slug: str, name: str) -> str | None:
    p = conf_doc_path(slug, name)
    if not p:
        return None
    return p.read_text() if p.exists() else ""


def module_state_path(name: str, slug: str) -> Path | None:
    """Path to a module's persisted JSON state. Validated; module-agnostic (the
    name comes from the URL). An empty slug (or the reserved "home") maps to a
    single vault-wide board at the vault root — the home-screen canvas that
    isn't tied to any one conference. None if name/slug is invalid."""
    if not _MODULE_NAME_RE.match(name):
        return None
    if not slug or slug == "home":
        return BASE_DIR / ".confnote" / "modules" / f"{name}.json"
    if not CONF_RE.match(slug):
        return None
    return BASE_DIR / slug / ".confnote" / "modules" / f"{name}.json"


def conf_doc_mtime(slug: str, name: str) -> float:
    """mtime of a conference doc, or 0.0 if it doesn't exist yet."""
    p = conf_doc_path(slug, name)
    return p.stat().st_mtime if (p and p.exists()) else 0.0


def write_conf_doc(slug: str, name: str, text: str) -> str:
    p = conf_doc_path(slug, name)
    if not p:
        raise ValueError("bad conference or document name")
    atomic_write(p, (text or "").rstrip() + "\n")
    return f"Wrote {name} for {slug}."


def session_digest(slug: str, limit_chars: int = 600) -> str:
    """A compact cross-session digest for the concierge: each notable session's
    title + short excerpts of its Human notes, Summary, and Actions. Actions are
    included so debriefs can roll up action items without opening every note."""
    data = load_agenda(slug)
    if not data:
        return ""
    out = []
    for e in data["events"]:
        if not notable(e):
            continue
        fn = note_file_for_event(e)
        p = BASE_DIR / slug / "notes" / fn
        line = f"- {effective_event(data, e)['start'][11:16]} {e['title']} [{fn}]"
        if p.exists():
            _, _, secs = parse_note(p.read_text())
            hn = (secs.get("Human notes") or "").strip()
            sm = (secs.get("Summary") or "").strip()
            ac = (secs.get("Actions") or "").strip()
            if hn:
                line += f"\n  notes: {hn[:limit_chars]}"
            if sm:
                line += f"\n  summary: {sm[:limit_chars]}"
            if ac:
                line += f"\n  actions: {ac[:limit_chars]}"
        out.append(line)
    return "\n".join(out)


def session_index(slug: str) -> str:
    """A lightweight per-turn index of a conference's notable sessions:
    time + title + the note filename to pass to read_note(). No file I/O and
    no excerpts — the agent calls read_notes()/read_note() on demand when a
    question actually needs note content. This is what rides in the live
    context envelope every turn; the heavy digest is fetched only when asked."""
    data = load_agenda(slug)
    if not data:
        return ""
    out = []
    for e in data["events"]:
        if not notable(e):
            continue
        fn = note_file_for_event(e)
        out.append(f"- {effective_event(data, e)['start'][11:16]} {e['title']} [{fn}]")
    return "\n".join(out)


def agenda_meta_text(data: dict) -> str:
    conf = data.get("conference", {})
    venue = conf.get("venue", {})
    return "\n".join(
        [
            f"{conf.get('name', '')} — {conf.get('tagline', '')}",
            f"Date: {conf.get('date', '')} ({conf.get('timezone', '')})",
            f"Venue: {venue.get('name', '')} {venue.get('address', '')}",
            f"Organiser: {conf.get('organiser', '')}",
            f"SCHEDULE_OFFSET_MINUTES: {data.get('schedule_offset_minutes', 0)}",
            f"SCHEDULE_REVISION: {data.get('schedule_revision', 0)}",
            *[
                f"{event['start']}–{event['end']} {event.get('title', '')}"
                for event in (effective_event(data, raw) for raw in data.get("events", []))
                if event.get("start") and event.get("end")
            ],
        ]
    )


def create_conference(agenda_obj: dict) -> str:
    """Validate an agenda dict minimally and write its folder via the same
    logic as tools/import_agenda.py. Returns a human result string."""
    result = validate_manifest(agenda_obj)
    if not result["ok"]:
        raise ValueError("; ".join(result["errors"]))
    agenda_obj = result["manifest"]
    conf = agenda_obj["conference"]
    events = agenda_obj["events"]

    # `tools/` holds import_agenda (folder/note generation). From source it's
    # at the repo root; in the frozen .app it's bundled via `--add-data
    # tools:tools`, so it lives under sys._MEIPASS — same pattern as the module
    # MCP loader. Without the frozen branch, `import import_agenda` raises a
    # ModuleNotFoundError inside the .app and add_conference fails.
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        tools_dir = Path(sys._MEIPASS) / "tools"
    else:
        tools_dir = Path(__file__).resolve().parent.parent.parent / "tools"
    sys.path.insert(0, str(tools_dir))
    import import_agenda  # local tool, reused for folder/note generation

    slug = conference_slug(agenda_obj)
    event_dir = BASE_DIR / slug
    notes_dir = event_dir / "notes"
    notes_dir.mkdir(parents=True, exist_ok=True)
    (notes_dir / "assets").mkdir(exist_ok=True)
    previous_path = event_dir / "agenda.json"
    paths = {}
    if previous_path.exists():
        previous = json.loads(previous_path.read_text())
        paths = {e["id"]: note_file_for_event(e) for e in previous.get("events", []) if notable(e)}
        for event in events:
            if event["id"] in paths:
                event["note_file"] = paths[event["id"]]
    validate_note_targets(events, paths)
    previous_path.write_text(json.dumps(agenda_obj, indent=2))
    import_agenda.write_readme(event_dir, agenda_obj)
    import_agenda.write_speakers(event_dir, agenda_obj)
    created = 0
    skipped = 0
    for e in events:
        if not notable(e):
            continue
        if import_agenda.write_note(notes_dir, e, agenda_obj):
            created += 1
        else:
            skipped += 1
        stem = Path(note_file_for_event(e)).stem
        adir = notes_dir / "assets" / stem
        adir.mkdir(parents=True, exist_ok=True)
        readme = adir / "README.txt"
        if not readme.exists():
            readme.write_text(
                f"Drop folder for: {e['title']}\n\n"
                "Put images, screenshots, PDFs, or notes for this talk here.\n"
                "The notes app's Files tab lists everything in this folder.\n"
                "Images pasted/dropped in the app also land here.\n"
            )
    return f"Imported '{conf['name']}' -> {slug}/ ({created} session notes, {skipped} preserved)."


def seed_starter_vault():
    enabled = os.environ.get("CONFNOTE_SEED_STARTER")
    if enabled == "1" or (enabled != "0" and getattr(sys, "frozen", False)):
        seed_first_run(BASE_DIR, create_conference)


def conference_preview(agenda_obj: dict) -> dict:
    result = validate_manifest(agenda_obj)
    manifest = result["manifest"]
    summary = dict(result["summary"])
    if manifest:
        summary["notable_count"] = len([e for e in manifest.get("events", []) if notable(e)])
    return {
        "ok": result["ok"],
        "schema_version": SCHEMA_VERSION,
        "manifest": manifest,
        "errors": result["errors"],
        "warnings": result["warnings"],
        "summary": summary,
    }


def parse_agenda_payload(body: dict) -> dict:
    """Accept either a manifest object or {agenda|manifest: object|string}."""
    raw = body
    if isinstance(body, dict) and ("agenda" in body or "manifest" in body):
        raw = body.get("agenda", body.get("manifest"))
    if isinstance(raw, str):
        return json.loads(raw)
    if isinstance(raw, dict):
        return raw
    raise ValueError("agenda must be a JSON object")


# ---------- slash commands (chat-level intents) ----------
# Users type `/brief`, `/debrief`, `/action <text>` into the Concierge
# chat to invoke explicit workflows. `/action` is handled directly here
# (1-line write, no LLM); `/brief` and `/debrief` are tagged and passed
# through to chat.global_reply, which injects a directive that bypasses
# the STATUS guardrail (so "conference already ended" doesn't refuse).
#
# Keeping the surface small on purpose — the user explicitly asked for
# just these three. Add cautiously.

_SLASH_RE = re.compile(r"^/(brief|debrief|action)\b\s*(.*)$", re.IGNORECASE)
# "Prepare a brief and research each speaker" asks for the /brief workflow in words: every session's
# Research, then BRIEF.md (the web Concierge's prepare_event_brief does the same). Asking for one of the
# two alone stays a normal turn.
_BRIEF_ASK_WORDS = (
    re.compile(r"\bbrief\b", re.IGNORECASE),
    re.compile(r"\bresearch", re.IGNORECASE),
    re.compile(r"\bspeakers?\b", re.IGNORECASE),
)


def _slash_command_in(messages):
    """Return {'name': 'brief'|'debrief'|'action', 'args': str} if the
    LAST user message is a slash command (or asks for a brief with speaker
    research in words); else None."""
    if not messages:
        return None
    last = messages[-1]
    if last.get("role") not in (None, "user"):
        return None
    text = (last.get("text") or "").strip()
    m = _SLASH_RE.match(text)
    if not m:
        if not text.startswith("/") and all(word.search(text) for word in _BRIEF_ASK_WORDS):
            return {"name": "brief", "args": ""}
        return None
    return {"name": m.group(1).lower(), "args": (m.group(2) or "").strip()}


def _slash_completion_message(name: str, slug: str):
    if name == "brief":
        return ("Brief ready", f"BRIEF.md updated for {slug}.")
    if name == "debrief":
        return ("Debrief ready", f"DEBRIEF.md updated for {slug}.")
    return ("Done", f"/{name} completed.")


def _emit_native_notification(title: str, body: str) -> None:
    """macOS desktop notification via osascript. Best-effort; silent on
    failure (Linux dev, sandboxed environments, etc). Skipped if the
    NOTIFY env knob is off."""
    if os.environ.get("CONF_NOTES_NO_NATIVE_NOTIFY"):
        return
    try:
        import subprocess

        # Title and body come from agenda text (an imported or shared agenda),
        # so they travel as arguments to a fixed script, never as AppleScript
        # source: an escaped quote there could reach `do shell script`.
        subprocess.run(
            [
                "osascript",
                "-e",
                "on run argv",
                "-e",
                'display notification (item 2 of argv) with title (item 1 of argv) sound name "Pop"',
                "-e",
                "end run",
                title,
                body,
            ],
            check=False,
            timeout=2,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        pass


# ---------- HTTP ----------


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _send(self, code, body, ctype="application/json", headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def _authorize_local_request(self, *, mutation=False):
        # Check Host before any route can read a vault or invoke a provider.
        host = self.headers.get("Host", "")
        if not re.fullmatch(r"(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?", host, re.I):
            self._send(403, {"error": "Loopback Host required."})
            return False
        try:
            parsed = urlparse("http://" + host)
            if parsed.port is not None and not 1 <= parsed.port <= 65535:
                raise ValueError("invalid port")
        except ValueError:
            self._send(403, {"error": "Invalid Host."})
            return False
        origin = self.headers.get("Origin")
        if (mutation or origin is not None) and origin != "http://" + host:
            self._send(403, {"error": "Requests must originate in confnote."})
            return False
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            self._send(403, {"error": "Cross-site requests are forbidden."})
            return False
        return True

    def _json_body(self):
        n = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(n) or b"{}")

    def _local_same_origin(self) -> bool:
        """A request from confnote's own page on a loopback host. The hostname
        check stops DNS rebinding, where Host and Origin are both the
        attacker's name resolved to 127.0.0.1."""
        expected = "http://" + self.headers.get("Host", "")
        return (
            self.headers.get("Origin") == expected
            and urlparse(expected).hostname in ("localhost", "127.0.0.1", "::1")
            and self.headers.get("X-Confnote-Request") == "1"
        )

    # --- GET ---
    def do_GET(self):
        if not self._authorize_local_request():
            return
        u = urlparse(self.path)
        q = parse_qs(u.query)
        path = u.path

        if path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return

        if path == "/api/catalogue":
            from catalogue import catalogue_payload

            return self._send(
                200,
                catalogue_payload(
                    STATIC_DIR / "catalogue/index.json", app_state_path().parent / "catalogue"
                ),
            )

        if path == "/api/conferences":
            return self._send(200, conferences_payload())

        if path == "/api/vault":
            return self._send(200, vault_payload())

        if path == "/api/conference":
            data = conference_payload(q.get("slug", [""])[0])
            return self._send(200, data) if data else self._send(404, {"error": "not found"})

        if path == "/api/actions":
            data = actions_payload(q.get("slug", [""])[0])
            return (
                self._send(200, data)
                if data is not None
                else self._send(404, {"error": "not found"})
            )

        if path == "/api/picks":
            slug = q.get("slug", [""])[0]
            notes = read_picks(slug)
            if notes is None:
                return self._send(404, {"error": "not found"})
            return self._send(200, {"slug": slug, "notes": notes})

        if path == "/api/note":
            p = note_path(q.get("slug", [""])[0], q.get("file", [""])[0])
            if not p:
                return self._send(404, {"error": "not found"})
            fm, title, secs = parse_note(p.read_text())
            agenda = load_agenda(q.get("slug", [""])[0])
            raw_event = _event_for_note(agenda, p.name) if agenda else None
            if raw_event and agenda.get("schedule_offset_minutes", 0):
                displayed = effective_event(agenda, raw_event)
                timezone = agenda.get("conference", {}).get("timezone", "")
                fm["time"] = (
                    f"{displayed['start'][:10]} {displayed['start'][11:16]}–{displayed['end'][11:16]} ({timezone})"
                )
            return self._send(
                200,
                {
                    "frontmatter": fm,
                    "title": title,
                    "sections": {k: secs.get(k, "") for k in CANON_SECTIONS},
                    "mtime": p.stat().st_mtime,
                },
            )

        if path == "/api/files":
            data = files_payload(q.get("slug", [""])[0], q.get("file", [""])[0])
            return self._send(200, data) if data else self._send(404, {"error": "not found"})

        if path == "/api/conf-doc":
            slug = q.get("slug", [""])[0]
            data = load_agenda(slug)
            if not data:
                return self._send(404, {"error": "not found"})
            return self._send(
                200,
                {
                    "status": conf_status(data),
                    "brief": read_conf_doc(slug, "BRIEF.md") or "",
                    "debrief": read_conf_doc(slug, "DEBRIEF.md") or "",
                    "brief_mtime": conf_doc_mtime(slug, "BRIEF.md"),
                    "debrief_mtime": conf_doc_mtime(slug, "DEBRIEF.md"),
                },
            )

        if path == "/api/chat/history":
            # Concierge JSONL — durable thread shared across conferences.
            # Optional ?limit=N returns the last N turns; default = all.
            limit_param = q.get("limit", [None])[0]
            try:
                lim = int(limit_param) if limit_param else None
            except ValueError:
                lim = None
            return self._send(200, {"history": read_chat_history(lim)})

        if path == "/api/settings":
            return self._send(200, public_settings())

        if path == "/api/chat/providers":
            try:
                auth_status = chatgpt_auth.status(app_channel())
            except Exception:
                auth_status = {
                    "available": False,
                    "signed_in": False,
                    "error": "Unable to read ChatGPT sign-in from macOS Keychain.",
                }
            return self._send(
                200,
                {
                    "claude": {"available": CHAT_OK},
                    "chatgpt": auth_status,
                },
            )
        if path == "/api/chat/chatgpt/models":
            try:
                return self._send(200, {"models": chatgpt_auth.list_models(app_channel())})
            except Exception:
                return self._send(
                    400,
                    {"error": "Could not load ChatGPT models. Check your connection and sign-in."},
                )

        if path == "/api/private":
            cfg = read_private_config()
            return self._send(200, {"configured": cfg is not None, "params": cfg})

        if path == "/api/recording/block":
            return self._send(200, block_status(q.get("slug", [""])[0]))

        if path == "/api/transcription/status":
            cfg = transcription.provider_cfg(read_settings())
            info = transcription.availability(cfg)
            return self._send(200, {"provider": cfg["provider"], **info})

        if path == "/api/chat/threads":
            # List the active thread + archived threads (newest first).
            return self._send(200, list_chat_threads())

        if path == "/assets":
            return self._serve_asset(q)

        # Module-bridge SSE: /api/module/<name>/events → live stream of
        # Python-side RPC commands the module's JS should execute.
        m = re.match(r"^/api/module/([a-z0-9][a-z0-9_-]{0,31})/events$", path)
        if m:
            return self._serve_module_events(m.group(1))

        # Generic per-module persisted state (module-agnostic): a module can
        # GET/PUT a JSON blob scoped to a conference — e.g. a canvas snapshot,
        # so its state survives an app restart. Core never names the module;
        # storage is <vault>/<slug>/.confnote/modules/<name>.json.
        m = re.match(r"^/api/module/([a-z0-9][a-z0-9_-]{0,31})/state$", path)
        if m:
            sp = module_state_path(m.group(1), q.get("slug", [""])[0])
            if sp is None:
                return self._send(404, {"error": "not found"})
            try:
                return self._send(200, json.loads(sp.read_text()) if sp.exists() else {})
            except Exception:
                return self._send(200, {})

        return self._serve_static(path)

    # --- PUT (save editable sections) ---
    def do_PUT(self):
        if not self._authorize_local_request(mutation=True):
            return
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/api/conf-doc":
            return self._put_conf_doc(q)
        if u.path == "/api/picks":
            try:
                result = set_picks(q.get("slug", [""])[0], (self._json_body() or {}).get("picks"))
            except (ValueError, AttributeError) as error:
                return self._send(400, {"error": str(error)})
            if result is None:
                return self._send(404, {"error": "not found"})
            return self._send(200, result)
        m = re.match(r"^/api/module/([a-z0-9][a-z0-9_-]{0,31})/state$", u.path)
        if m:
            sp = module_state_path(m.group(1), q.get("slug", [""])[0])
            if sp is None:
                return self._send(404, {"error": "not found"})
            sp.parent.mkdir(parents=True, exist_ok=True)
            atomic_write(sp, json.dumps(self._json_body()))
            return self._send(200, {"ok": True})
        if u.path != "/api/note":
            return self._send(404, {"error": "not found"})
        with _NOTE_WRITE_LOCK:
            return self._put_note(q)

    def _put_note(self, q):
        p = note_path(q.get("slug", [""])[0], q.get("file", [""])[0])
        if not p:
            return self._send(404, {"error": "not found"})
        body = self._json_body()
        current_mtime = p.stat().st_mtime
        if body.get("mtime") is not None:
            try:
                client_mtime = float(body["mtime"])
                if not math.isfinite(client_mtime):
                    raise ValueError("non-finite mtime")
            except (TypeError, ValueError):
                return self._send(400, {"error": "invalid mtime"})
            if abs(client_mtime - current_mtime) > 1e-6:
                fm, title, sections = parse_note(p.read_text())
                return self._send(
                    409,
                    {
                        "conflict": True,
                        "mtime": current_mtime,
                        "note": {
                            "frontmatter": fm,
                            "title": title,
                            "sections": sections,
                            "mtime": current_mtime,
                        },
                    },
                )
        payload = body.get("sections", {})
        fm, title, disk = parse_note(p.read_text())  # re-read: keep agent sections
        for name in CANON_SECTIONS:
            if name in EDITABLE and name in payload:
                disk[name] = payload[name]
        # Mirror any inline URL from Human notes into the Links section
        # (non-destructive, deduped) whenever Human notes is edited, so links
        # stop getting stranded in prose with `## Links` left empty.
        if "Human notes" in payload:
            disk["Links"] = merge_links_into_section(
                disk.get("Human notes", ""), disk.get("Links", "")
            )
        atomic_write(p, build_note(fm, title, disk))
        # Return the (possibly link-mirrored) Links body so the client reflects
        # newly-extracted URLs live, without needing a reload.
        return self._send(
            200, {"ok": True, "mtime": p.stat().st_mtime, "links": disk.get("Links", "")}
        )

    # PUT /api/conf-doc?slug=&name=BRIEF.md|DEBRIEF.md  — save an inline edit to
    # a conference-level doc. Optimistic concurrency: if the client sends an
    # `mtime` that no longer matches disk (e.g. the agent regenerated the doc
    # under the editor), reject with 409 + the current text so the UI can
    # reconcile instead of silently clobbering.
    def _put_conf_doc(self, q):
        slug = q.get("slug", [""])[0]
        name = q.get("name", [""])[0]
        if conf_doc_path(slug, name) is None:
            return self._send(404, {"error": "not found"})
        body = self._json_body()
        client_mtime = body.get("mtime")
        cur = conf_doc_mtime(slug, name)
        if client_mtime is not None and cur and abs(float(client_mtime) - cur) > 1e-6:
            return self._send(
                409,
                {"error": "stale", "mtime": cur, "text": read_conf_doc(slug, name) or ""},
            )
        write_conf_doc(slug, name, body.get("text", ""))
        return self._send(200, {"ok": True, "mtime": conf_doc_mtime(slug, name)})

    # --- POST (image upload / chat) ---
    def do_POST(self):
        if not self._authorize_local_request(mutation=True):
            return
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/api/conference/schedule":
            if not self._local_same_origin():
                return self._send(403, {"error": "Schedule requests must originate in confnote."})
            try:
                body = self._json_body()
                payload = set_conference_schedule(
                    body.get("slug", q.get("slug", [""])[0]),
                    body.get("offset_minutes"),
                    body.get("expected_offset"),
                    body.get("expected_revision"),
                )
            except ScheduleConflict as error:
                return self._send(409, {"error": str(error)})
            except FileNotFoundError as error:
                return self._send(404, {"error": str(error)})
            except (ValueError, TypeError, AttributeError) as error:
                return self._send(400, {"error": str(error)})
            return self._send(200, payload)
        if u.path in ("/api/chat/chatgpt/login", "/api/chat/chatgpt/logout"):
            if not self._local_same_origin():
                return self._send(403, {"error": "Sign-in requests must originate in confnote."})
            try:
                if u.path.endswith("/logout"):
                    result = chatgpt_auth.logout(app_channel())
                    return self._send(200, {"ok": True, **result})
                return self._send(200, chatgpt_auth.start_login(app_channel()))
            except Exception:
                return self._send(
                    400,
                    {
                        "error": "ChatGPT sign-in could not start. macOS Keychain and the OAuth dependencies must be available."
                    },
                )
        if u.path in ("/api/chat", "/api/chat/session"):
            return self._chat_session(q)
        if u.path == "/api/chat/global":
            return self._chat_global(q)
        if u.path == "/api/settings":
            try:
                body = self._json_body()
            except Exception:
                body = {}
            return self._send(200, write_settings(body))
        if u.path == "/api/settings/test":
            return self._send(200, test_transcription_connection())
        if u.path == "/api/private/setup":
            # One-time passphrase setup. Body carries the client-generated KDF
            # params + verifier (never the passphrase). Refuse to overwrite an
            # existing config — re-keying would orphan every encrypted note.
            if read_private_config() is not None:
                return self._send(409, {"ok": False, "error": "Private passphrase already set."})
            try:
                body = self._json_body()
            except Exception:
                body = {}
            if not PRIVATE_CONFIG_KEYS.issubset(body):
                return self._send(400, {"ok": False, "error": "Incomplete passphrase params."})
            cfg = {k: body[k] for k in PRIVATE_CONFIG_KEYS}
            write_private_config(cfg)
            return self._send(200, {"ok": True})
        if u.path == "/api/vault/switch":
            try:
                body = self._json_body()
            except Exception:
                body = {}
            raw = (body.get("path") or "").strip()
            if not raw:
                return self._send(400, {"ok": False, "error": "No folder path given."})
            try:
                target = Path(raw).expanduser().resolve()
            except Exception:
                return self._send(400, {"ok": False, "error": "Invalid folder path."})
            if target.exists() and not target.is_dir():
                return self._send(400, {"ok": False, "error": "That path is a file, not a folder."})
            if str(target) == str(BASE_DIR):
                # Already here — no relaunch, just confirm.
                return self._send(200, {"ok": True, "path": str(target), "relaunching": False})
            try:
                target.mkdir(parents=True, exist_ok=True)  # name a new vault → create it
            except Exception as e:
                return self._send(400, {"ok": False, "error": f"Could not create folder: {e}"})
            set_current_vault(str(target))
            # CONF_NOTES_DIR wins by contract: persist the selection (it takes
            # effect once the override is removed) but don't relaunch — a restart
            # would just resolve back to the env-pinned vault. Matches the
            # env_pinned warning the UI shows.
            if os.environ.get("CONF_NOTES_DIR"):
                return self._send(
                    200, {"ok": True, "path": str(target), "relaunching": False, "env_pinned": True}
                )
            self._send(200, {"ok": True, "path": str(target), "relaunching": True})
            request_vault_relaunch(self.server.server_address[1])
            return
        if u.path == "/api/import":
            return self._import_bundle()
        if u.path == "/api/conference/validate":
            try:
                manifest = parse_agenda_payload(self._json_body())
            except Exception as e:
                return self._send(
                    400,
                    {
                        "ok": False,
                        "schema_version": SCHEMA_VERSION,
                        "manifest": {},
                        "errors": [f"invalid agenda JSON: {e}"],
                        "warnings": [],
                        "summary": {},
                    },
                )
            preview = conference_preview(manifest)
            return self._send(200 if preview["ok"] else 422, preview)
        if u.path == "/api/catalogue/refresh":
            from catalogue import refresh_catalogue

            self._json_body()
            return self._send(
                200,
                refresh_catalogue(
                    STATIC_DIR / "catalogue/index.json", app_state_path().parent / "catalogue"
                ),
            )

        if u.path == "/api/conferences":
            try:
                manifest = parse_agenda_payload(self._json_body())
            except Exception as e:
                return self._send(400, {"ok": False, "error": f"invalid agenda JSON: {e}"})
            preview = conference_preview(manifest)
            if not preview["ok"]:
                return self._send(422, preview)
            try:
                message = create_conference(preview["manifest"])
            except ValueError as e:
                return self._send(422, {"ok": False, "error": str(e), **preview})
            summary = preview["summary"]
            return self._send(
                201,
                {
                    "ok": True,
                    "message": message,
                    "slug": summary.get("slug", ""),
                    "summary": summary,
                    "warnings": preview["warnings"],
                },
            )
        if u.path == "/api/transcription/file":
            return self._transcribe_file(q)
        if u.path == "/api/transcription/record/start":
            return self._record_start(q)
        if u.path == "/api/transcription/record/stop":
            return self._record_stop(q)
        if u.path.startswith("/api/recording/"):
            if not self._local_same_origin():
                return self._send(403, {"error": "Recording requests must originate in confnote."})
            return self._recording_block(u.path)
        if u.path == "/api/chat/archive":
            # Archive the current active thread → new empty active.
            archived = archive_current_chat()
            return self._send(200, {"archived": archived, "active": None})
        if u.path == "/api/chat/resume":
            # Archive current + restore the named archive as active.
            tid = q.get("id", [""])[0]
            now_active = resume_chat(tid)
            if not now_active:
                return self._send(404, {"error": "thread not found"})
            return self._send(200, {"active": now_active})

        # Module-bridge result POST: /api/module/<name>/result?id=<cmd_id>
        # Browser-side acks an apply_js / similar call with {"result": ...}
        # or {"error": "..."}.
        m = re.match(r"^/api/module/([a-z0-9][a-z0-9_-]{0,31})/result$", u.path)
        if m:
            return self._handle_module_result(m.group(1), q)
        if u.path != "/api/asset":
            return self._send(404, {"error": "not found"})
        slug = q.get("slug", [""])[0]
        fname = q.get("file", [""])[0]
        p = note_path(slug, fname)
        if not p:
            return self._send(404, {"error": "not found"})
        body = self._json_body()
        raw = body.get("data", "")
        if "," in raw and raw.startswith("data:"):
            raw = raw.split(",", 1)[1]
        import base64

        blob = base64.b64decode(raw)
        stem = p.stem
        adir = p.parent / "assets" / stem
        adir.mkdir(parents=True, exist_ok=True)
        name = re.sub(r"[^a-zA-Z0-9._-]", "-", body.get("filename", "") or "img.png")
        if "." not in name:
            name += ".png"
        target = adir / name
        n = 1
        while target.exists():
            target = adir / f"{Path(name).stem}-{n}{Path(name).suffix}"
            n += 1
        target.write_bytes(blob)
        rel = f"assets/{stem}/{target.name}"
        return self._send(
            200,
            {
                "markdown": f"![]({rel})",
                "url": f"/assets?slug={slug}&path={rel}",
            },
        )

    # --- chat (streaming NDJSON; the only optional-dep path) ---
    def _open_ndjson(self, provider="claude"):
        """Start an NDJSON response and return an `emit` callback, or None if
        chat is unavailable (in which case the error is already emitted)."""
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()

        def emit(obj):
            self.wfile.write((json.dumps(obj) + "\n").encode())
            self.wfile.flush()

        if provider not in ("claude", "chatgpt"):
            emit({"error": "Unknown agent provider."})
            emit({"done": True})
            return None
        if provider == "claude" and not (chatmod and CHAT_OK):
            emit(
                {
                    "error": "Chat needs the Claude CLI. "
                    "Install it: https://docs.claude.com/en/docs/agents-and-tools/claude-code/overview "
                    "(or `curl -fsSL claude.ai/install.sh | bash`), then relaunch."
                }
            )
            emit({"done": True})
            return None
        return emit

    def _request_messages(self):
        try:
            return self._json_body().get("messages", [])
        except Exception:
            return []

    # POST /api/chat/session?slug=&file=  (and the /api/chat alias)
    def _chat_session(self, q):
        provider = q.get("provider", ["claude"])[0]
        slug = q.get("slug", [""])[0]
        fname = q.get("file", [""])[0]
        p = note_path(slug, fname)
        # Drain the request before any early stream response; unread bytes can
        # cause a TCP reset that discards the final error/done events.
        messages = self._request_messages()
        emit = self._open_ndjson(provider)
        if emit is None:
            return
        if not p:
            emit({"error": "Unknown session."})
            return emit({"done": True})

        data = load_agenda(slug) or {}
        speakers = data.get("speakers", {})
        ev = _event_for_note(data, fname) or {}
        ev = effective_event(data, ev)
        meta = {
            "conference": data.get("conference", {}).get("name", ""),
            "title": ev.get("title", p.stem),
            "time": " ".join(
                filter(
                    None,
                    [ev.get("start", "")[:16].replace("T", " "), "→", ev.get("end", "")[11:16]],
                )
            ),
            "room": ev.get("room", ""),
            "speakers": ", ".join(speaker_label(i, speakers) for i in ev.get("speakers", [])),
            "tags": ", ".join(ev.get("tags", [])),
            "description": ev.get("description", ""),
        }

        def apply_section(name, text):
            return apply_note_section(p, name, text)

        with _AGENT_LOCK:
            try:
                backend = chatgpt_agent if provider == "chatgpt" else chatmod
                extra = (
                    {"channel": app_channel(), "model": q.get("model", [""])[0]}
                    if provider == "chatgpt"
                    else {}
                )
                backend.session_reply(
                    meta=meta,
                    note_text=p.read_text(),
                    messages=messages,
                    apply_section=apply_section,
                    emit=emit,
                    **extra,
                )
            except BrokenPipeError:
                pass
            except Exception as e:
                try:
                    emit({"error": f"{type(e).__name__}: {e}"})
                    emit({"done": True})
                except Exception:
                    pass

    # POST /api/chat/global?slug=&file=&thinking=   — conference-wide concierge.
    # `file` is what the user is CURRENTLY VIEWING on the screen (optional);
    # `thinking` is the user's chosen reasoning level: "off" | "auto" | "deep".
    def _chat_global(self, q):
        provider = q.get("provider", ["claude"])[0]
        slug = q.get("slug", [""])[0]
        file_viewing = q.get("file", [""])[0]
        thinking_level = q.get("thinking", ["off"])[0]
        if thinking_level not in ("off", "auto", "deep"):
            thinking_level = "off"
        model_level = q.get("model", ["haiku"])[0]
        if model_level not in ("haiku", "sonnet", "opus"):
            model_level = "haiku"
        # Drain the request before any early stream response; unread bytes can
        # cause a TCP reset that discards the final error/done events.
        messages = self._request_messages()
        emit = self._open_ndjson(provider)
        if emit is None:
            return
        data = load_agenda(slug)
        if not data:
            if slug:
                emit({"error": "Unknown conference."})
                return emit({"done": True})
            data = {
                "conference": {
                    "name": "Workspace",
                    "date": "",
                    "timezone": "",
                    "venue": {},
                },
                "events": [],
                "speakers": {},
            }

        # Slash-command interception. `/action` is handled directly (no LLM
        # round-trip — it's a 1-line file write). `/brief` and `/debrief`
        # are tagged so chat.global_reply can inject an override directive
        # that suppresses the STATUS guardrail ("conference already ended"
        # offers etc.) and tells the agent to execute the workflow now.
        slash = _slash_command_in(messages)
        if slash and slash["name"] == "action":
            return self._handle_action_command(slug, file_viewing, slash["args"], emit, messages)

        # Persist the user's latest turn to the durable JSONL immediately
        # (before the agent runs) so a mid-response crash doesn't lose it.
        if messages:
            last = messages[-1]
            if last.get("role") in (None, "user"):
                append_chat_history("user", last.get("text") or "", slug)

        # Wrap emit so we can capture the streamed assistant text and persist
        # it to the JSONL once the turn completes.
        assistant_buf: list[str] = []

        def emit_capture(obj):
            if "text" in obj:
                assistant_buf.append(obj["text"])
            elif obj.get("done"):
                append_chat_history("assistant", "".join(assistant_buf), slug)
            emit(obj)

        # Resolve "currently viewing" to a human-readable title if file given.
        viewing_title = ""
        if file_viewing:
            ev = _event_for_note(data, file_viewing) or {}
            viewing_title = ev.get("title", file_viewing)

        # Perf lever 2 plumbing: read the SDK session-id sidecar (None on
        # first turn / after archive / after resume), and persist the new
        # session-id back to disk when the SDK emits it during the run.
        resume_sid = read_active_session_id()

        def on_session_id(sid: str) -> None:
            # Only persist if it actually changed — saves a write per turn
            # in the steady state.
            try:
                if sid and sid != read_active_session_id():
                    write_active_session_id(sid)
            except Exception:
                pass

        # Bridges for any enabled module that ships a Python-side MCP server.
        # chat.discover_module_mcps reads modules.config.json and hands each
        # module the bridge keyed by its name. Bridges are process-wide
        # singletons (bridge.get_bridge), so the SSE/result endpoints land on
        # the same instance the MCP tool is using.
        bridges = (
            {n: get_bridge(n) for n in chatmod._enabled_module_names()}
            if provider == "claude" and chatmod
            else {}
        )

        with _AGENT_LOCK:
            try:
                backend = chatgpt_agent if provider == "chatgpt" else chatmod
                extra = (
                    {"channel": app_channel(), "model": q.get("model", [""])[0]}
                    if provider == "chatgpt"
                    else {}
                )
                backend.global_reply(
                    agenda_meta=agenda_meta_text(data)
                    + "\nCURRENT_CLOCK_UTC: "
                    + _now().isoformat()
                    + "\nUse this turn's clock and STATUS; earlier chat times may be stale. Lunch may overlap talks and does not mean talks have not started.",
                    notes_index=session_index(slug) if slug else "",
                    status=conf_status(data) if slug else "No active conference selected.",
                    messages=messages,
                    # The shared Concierge tools (packages/contracts/tools.json)
                    # over this vault, scoped to what the user has open.
                    tools=concierge_tools.LocalTools(
                        slug=slug, file=file_viewing, emit=emit_capture, host=f"local:{provider}"
                    ),
                    emit=emit_capture,
                    conf_slug=slug,
                    viewing_title=viewing_title,
                    durable_history=read_chat_history(limit=20),
                    resume_session_id=resume_sid,
                    on_session_id=on_session_id,
                    thinking_level=thinking_level,
                    model_level=model_level,
                    bridges=bridges,
                    **extra,
                    slash_command=(slash["name"] if slash else None),
                    slash_args=(slash["args"] if slash else ""),
                    # Current BRIEF/DEBRIEF text so the agent can refine in
                    # place (and knows the doc exists → don't clobber it).
                    slash_doc_text=(
                        read_conf_doc(
                            slug, "BRIEF.md" if slash["name"] == "brief" else "DEBRIEF.md"
                        )
                        or ""
                        if slash and slash["name"] in ("brief", "debrief") and slug
                        else ""
                    ),
                )
                # On clean completion of a slash command, surface a toast so
                # the user sees a result without having to scan the chat
                # transcript. The frontend renders these; the desktop layer
                # additionally fires a native macOS notification when in .app
                # mode (see _emit_native_notification).
                if slash:
                    # Debrief writes a `## Action Items` list into DEBRIEF.md;
                    # mirror those into INBOX.md so they show (and tick) in the
                    # ✔ Actions rollup instead of being stranded in the recap.
                    if slash["name"] == "debrief":
                        added = sync_debrief_actions_to_inbox(slug)
                        if added:
                            emit(
                                {
                                    "notice": f"Filed {added} debrief action "
                                    f"item{'' if added == 1 else 's'} into the Actions inbox."
                                }
                            )
                    title, body = _slash_completion_message(slash["name"], slug)
                    emit({"toast": {"title": title, "body": body, "kind": "ok"}})
                    _emit_native_notification(title, body)
            except BrokenPipeError:
                pass
            except Exception as e:
                try:
                    emit({"error": f"{type(e).__name__}: {e}"})
                    emit({"done": True})
                except Exception:
                    pass

    # --- static + assets ---
    def _serve_static(self, path):
        rel = "index.html" if path == "/" else path.lstrip("/")
        # Path-traversal guard BEFORE touching the filesystem. We don't
        # rely on `.resolve()` + `is_relative_to` because the macOS .app
        # bundle layout symlinks Frameworks/static/* → ../../Resources/
        # static/*. resolve() then walks the file symlink into Resources
        # while base stays in Frameworks, and the is_relative_to check
        # false-rejects every static asset. So: forbid `..` components
        # explicitly, then trust the joined path inside STATIC_DIR.
        parts = [p for p in rel.split("/") if p]
        if any(p == ".." or p.startswith("\x00") for p in parts):
            return self._send(404, "not found", "text/plain")
        f = STATIC_DIR.joinpath(*parts) if parts else STATIC_DIR / "index.html"
        if not f.is_file():
            return self._send(404, "not found", "text/plain")
        self._send(200, f.read_bytes(), MIME.get(f.suffix, "application/octet-stream"))

    def _serve_asset(self, q):
        slug = q.get("slug", [""])[0]
        rel = q.get("path", [""])[0]
        if not CONF_RE.match(slug) or ".." in rel:
            return self._send(404, "not found", "text/plain")
        nbase = (BASE_DIR / slug / "notes").resolve()
        f = (nbase / rel).resolve()
        if not f.is_file() or not f.is_relative_to(nbase):
            return self._send(404, "not found", "text/plain")
        ctype = MIME.get(f.suffix.lower(), "application/octet-stream")
        self._send(200, f.read_bytes(), ctype, asset_headers(ctype))

    # --- /action direct handler -----------------------------------------
    # Runs entirely server-side — no LLM round-trip. If a session is in
    # view (`file` param), the item attaches there; otherwise it lands in
    # the conference's INBOX.md. The chat transcript still records the
    # user's `/action` and our confirmation so the durable history shows
    # what happened.
    def _handle_action_command(self, slug, file_viewing, args, emit, messages):
        text = (args or "").strip()
        if not text:
            emit({"text": "/action needs the action text. Example: `/action follow up with Jane`."})
            emit({"done": True})
            return

        # Persist user turn + figure out where it lands.
        if messages:
            last = messages[-1]
            if last.get("role") in (None, "user"):
                append_chat_history("user", last.get("text") or "", slug)

        target_label = None
        target_path = None

        if file_viewing:
            p = append_session_action(slug, file_viewing, text)
            if p is not None:
                target_path = p
                # Friendly label: the session title if we can find it, else filename.
                ev = _event_for_note(load_agenda(slug) or {}, file_viewing) or {}
                target_label = ev.get("title") or file_viewing

        if target_path is None:
            # Either no session in view or the file_viewing wasn't valid —
            # fall back to the conf-level inbox.
            p = append_inbox_action(slug, text)
            if p is None:
                emit({"text": "Couldn't find that conference."})
                emit({"done": True})
                return
            target_path = p
            target_label = "Inbox"

        reply = f"✓ Action added to **{target_label}** — `- [ ] {text}`"
        emit({"text": reply})
        append_chat_history("assistant", reply, slug)
        emit({"toast": {"title": "Action added", "body": f"→ {target_label}", "kind": "ok"}})
        _emit_native_notification("Action added", f"{target_label}: {text}")
        emit({"done": True})

    # --- import a .confnote file (vault_transfer.py) ----------------------
    # Body: {"bundle": <confnote.vault.v1>, "mode": "check"|"new"|"merge"|"copy"}.
    # "check" only previews. "new" answers 409 + the preview when a conference
    # already exists, so the UI can offer merge or copy. Same-origin + custom
    # header only: another site must not be able to plant files in the vault.
    def _import_bundle(self):
        if not self._local_same_origin():
            return self._send(403, {"error": "Import requests must originate in confnote."})
        if int(self.headers.get("Content-Length", 0)) > IMPORT_BODY_LIMIT:
            return self._send(413, {"error": "This file is larger than confnote can import."})
        try:
            body = self._json_body()
            bundle = body.get("bundle")
            mode = body.get("mode") or "new"
            if mode == "check":
                vault_transfer.validate_bundle(bundle)
                return self._send(
                    200,
                    {"ok": True, "conferences": vault_transfer.preview_bundle(BASE_DIR, bundle)},
                )
            result = vault_transfer.import_bundle(
                BASE_DIR, bundle, mode, private_config=read_private_config()
            )
        except vault_transfer.ImportConflict as conflict:
            return self._send(
                409,
                {
                    "error": str(conflict),
                    "conflict": True,
                    "slugs": conflict.slugs,
                    "conferences": vault_transfer.preview_bundle(BASE_DIR, bundle),
                },
            )
        except (ValueError, AttributeError) as error:
            return self._send(400, {"error": str(error) or "Invalid confnote file"})
        if result["private_config"]:
            write_private_config(result["private_config"])
        return self._send(200, result)

    # --- transcription (Local AI Cat / remote OpenAI) -------------------
    # Shared file path works for both providers; recording is local-only.
    # The provider token stays server-side (read from settings here).
    def _transcribe_file(self, q):
        slug = q.get("slug", [""])[0]
        note_file = q.get("file", [""])[0]
        if not note_path(slug, note_file):
            return self._send(404, {"error": "unknown note"})
        body = self._json_body()
        raw = body.get("data", "")
        if "," in raw and raw.startswith("data:"):
            raw = raw.split(",", 1)[1]
        import base64

        try:
            audio = base64.b64decode(raw)
        except Exception:
            return self._send(400, {"error": "bad audio data"})
        if not audio:
            return self._send(400, {"error": "empty audio"})
        filename = (body.get("filename") or "audio.m4a").replace("/", "_")
        mime = body.get("mime") or MIME.get(Path(filename).suffix, "application/octet-stream")
        cfg = transcription.provider_cfg(read_settings())
        # Persist the dropped audio into the session asset folder so the
        # conference folder stays self-contained + portable.
        rel = ""
        try:
            np = note_path(slug, note_file)
            adir = np.parent / "assets" / np.stem
            adir.mkdir(parents=True, exist_ok=True)
            ts = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
            dest = adir / f"recording-{ts}{Path(filename).suffix or '.m4a'}"
            dest.write_bytes(audio)
            rel = f"notes/assets/{np.stem}/{dest.name}"
        except Exception:
            pass
        try:
            text = transcription.transcribe_bytes(cfg, audio, filename, mime)
        except RuntimeError as e:
            return self._send(502, {"error": str(e)})
        if not text:
            return self._send(200, {"text": "", "note": "transcription returned no text"})
        append_transcript(slug, note_file, text, recording=rel, source=cfg["provider"])
        return self._send(200, {"text": text, "recording": rel})

    def _record_start(self, q):
        cfg = transcription.provider_cfg(read_settings())
        if cfg["provider"] != "local":
            return self._send(
                400, {"error": "recording needs Local AI Cat (set provider to local)"}
            )
        try:
            job = transcription.start_recording(cfg)
        except Exception as e:
            return self._send(502, {"error": f"could not start recording: {e}"})
        return self._send(200, {"id": job.get("id"), "state": job.get("state")})

    def _record_stop(self, q):
        slug = q.get("slug", [""])[0]
        note_file = q.get("file", [""])[0]
        if not note_path(slug, note_file):
            return self._send(404, {"error": "unknown note"})
        rec_id = (self._json_body().get("id") or "").strip()
        if not rec_id:
            return self._send(400, {"error": "missing recording id"})
        cfg = transcription.provider_cfg(read_settings())
        try:
            job = transcription.stop_recording(cfg, rec_id)
        except Exception as e:
            return self._send(502, {"error": str(e)})
        text = (job.get("text") or "").strip()
        append_transcript(
            slug, note_file, text, recording=job.get("audioPath") or "", source="local-ai-cat"
        )
        return self._send(200, {"text": text})

    # --- block recording (record the block, then cut per session) -------
    def _recording_block(self, path: str):
        try:
            body = self._json_body()
        except Exception:
            body = {}
        slug = body.get("slug") or ""
        if not (CONF_RE.match(slug) and (BASE_DIR / slug).is_dir()):
            return self._send(404, {"error": "unknown conference"})
        notes = [n for n in body.get("notes") or [] if isinstance(n, str)]
        try:
            if path == "/api/recording/block/start":
                return self._send(200, start_block(slug, notes))
            if path == "/api/recording/block/stop":
                return self._send(200, stop_block(slug))
            if path == "/api/recording/split":
                segments = None
                seg_path = (body.get("segments_path") or "").strip()
                if seg_path:
                    raw = json.loads(Path(seg_path).expanduser().read_text())
                    segments = transcription.segments_from_payload(raw)
                started = body.get("started_at") or ""
                out = split_block(
                    slug,
                    body.get("audio_path") or "",
                    notes=notes or None,
                    room=body.get("room") or "",
                    segments=segments,
                    started_at=datetime.fromisoformat(started) if started else None,
                )
                return self._send(200, out)
            if path == "/api/recording/auto":
                set_auto_notes(slug, notes)
                return self._send(
                    200, {"ok": True, "enabled": auto_enabled(), **block_status(slug)}
                )
        except LookupError as e:
            return self._send(409, {"error": str(e)})
        except FileNotFoundError as e:
            return self._send(404, {"error": str(e)})
        except Exception as e:
            return self._send(502, {"error": str(e)})
        return self._send(404, {"error": "not found"})

    # --- module bridge (SSE out / result POST in) -----------------------
    # Per-module RPC channel used by an in-process MCP tool to talk to a
    # live JS island. Wired in bridge.py. The endpoint paths embed the
    # module name so any module can opt in without touching server.py.
    def _serve_module_events(self, name: str):
        if not _MODULE_NAME_RE.match(name):
            return self._send(404, {"error": "bad module name"})
        b = get_bridge(name)
        q = b.subscribe()
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            # Tell the client it's live so it can flip a "connected" flag.
            self.wfile.write(b"event: ready\ndata: {}\n\n")
            self.wfile.flush()
            last_ping = time.monotonic()
            while True:
                try:
                    payload = q.get(timeout=15)
                except queue.Empty:
                    # Heartbeat every ~15s so proxies / sleeping tabs don't
                    # silently drop the connection.
                    if time.monotonic() - last_ping > 14:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                        last_ping = time.monotonic()
                    continue
                line = b"data: " + json.dumps(payload).encode() + b"\n\n"
                self.wfile.write(line)
                self.wfile.flush()
                last_ping = time.monotonic()
        except (BrokenPipeError, ConnectionResetError, OSError):
            # Tab closed / navigated away.
            pass
        finally:
            b.unsubscribe(q)

    def _handle_module_result(self, name: str, q):
        if not _MODULE_NAME_RE.match(name):
            return self._send(404, {"error": "bad module name"})
        cmd_id = q.get("id", [""])[0]
        if not cmd_id:
            return self._send(400, {"error": "missing id"})
        try:
            body = self._json_body()
        except Exception:
            body = {}
        b = get_bridge(name)
        ok = b.resolve(cmd_id, result=body.get("result"), error=body.get("error"))
        return self._send(200 if ok else 404, {"ok": ok})


# Browsers open several parallel asset requests and long-lived module streams.
# The stdlib backlog of five can reset connections during a fresh page load.
class LocalHTTPServer(ThreadingHTTPServer):
    request_queue_size = 64

    def server_bind(self):
        # HTTPServer.server_bind sets server_name via socket.getfqdn, a reverse
        # DNS lookup nothing here reads; on GitHub's macOS runners it can stall
        # the start for longer than the e2e fixtures wait.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]

    def handle_error(self, request, client_address):
        # A page that navigates away mid-response closes its socket; that is
        # not a server fault, and a traceback per request buries real ones.
        if isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)


def main():
    from catalogue import start_background_refresh

    start_background_refresh(
        STATIC_DIR / "catalogue/index.json", app_state_path().parent / "catalogue"
    )
    seed_starter_vault()
    port = int(os.environ.get("CONF_NOTES_PORT", sys.argv[1] if len(sys.argv) > 1 else 8787))
    for p in range(port, port + 10):
        try:
            srv = LocalHTTPServer((HOST, p), Handler)
            break
        except OSError:
            continue
    else:
        print("No free port in range")
        sys.exit(1)
    url = f"http://localhost:{p}"
    print(f"confnote  →  {url}   (Ctrl+C to stop)", flush=True)
    # Skip auto-open in headless contexts (e2e, CI, ssh). The .app launcher
    # uses pywebview directly and doesn't go through this codepath.
    if not os.environ.get("CONF_NOTES_NOOPEN"):
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
