"""The Mac app's Concierge tools, built from the shared spec.

packages/contracts/tools.json names every Concierge tool once: purpose,
parameters and result shape. This module implements that spec over the local
vault; the hosted twin is packages/web-app/lib/concierge-tools.ts. Both
providers on the Mac serve the same registry: chat.py hands it to Claude as an
in-process MCP server, chatgpt_agent.py as ChatGPT function tools. The parity
test (tests/test_tool_contract.py) fails when this file and the spec drift.

Every handler takes the model's arguments as a dict (already checked against
the tool's input_schema by `check_args`) and returns a JSON-able dict; a
failure is {"error": "..."}. No SDK import here, so it is testable alone.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime
from pathlib import Path

import web_fetch

AGENT_SECTIONS = ("Summary", "Research", "AI notes")
CONF_DOCS = ("BRIEF.md", "DEBRIEF.md")
BOARD_MODULE = "tldraw-board"
BOARD_DRAWER = "tldraw"
MAX_THEMES = 6
MAX_SPEAKERS_SHOWN = 4
THEME_COLORS = ("blue", "orange", "green", "violet", "red", "light-blue")
REST_TYPES = {"break", "lunch", "logistics", "networking", "social"}
MAP_MAX_BRANCHES = 7
MAP_MAX_POINTS = 4
MAP_MAX_SPEAKERS = 3
MAP_POINT_CHARS = 90
MAP_TOPIC_CHARS = 40
MAP_TITLE_CHARS = 70
MAP_COLORS = ("blue", "orange", "green", "violet", "red", "light-blue", "light-green")
MAP_NOTE_SECTIONS = ("Human notes", "Summary", "Research")
# Tags that name a kind of session, not a topic: never a branch of their own.
GENERIC_TAGS = {"opening", "welcome", "closing", "panel", "keynote", "talk", "demo"}
RECALL_LIMIT = 8
ACTION_LINE_RE = re.compile(r"^(\s*[-*]\s+\[)([ xX])(\]\s+)(.*)$")
JSON_TYPES = {
    "string": str,
    "integer": int,
    "number": (int, float),
    "boolean": bool,
    "array": list,
    "object": dict,
}


def spec_path() -> Path:
    """tools.json from the repo, or from the bundle in the frozen .app."""
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS) / "contracts" / "tools.json"
    return Path(__file__).resolve().parent.parent / "contracts" / "tools.json"


_SPEC: dict | None = None


def spec() -> dict:
    global _SPEC
    if _SPEC is None:
        _SPEC = json.loads(spec_path().read_text())
    return _SPEC


def tool_spec(name: str) -> dict:
    return next(t for t in spec()["tools"] if t["name"] == name)


def host_entries(kind: str, host: str) -> dict:
    """{tool: entry} of the spec's not_on / native / conditional list that
    applies to `host` ("local:claude" also matches entries for "local")."""
    family = host.split(":", 1)[0]
    return {e["tool"]: e for e in spec().get(kind, []) if e["host"] in (host, family)}


# ---------- argument checking (the subset of JSON Schema the spec uses) ----------


def _check(schema: dict, value, where: str):
    expected = schema.get("type")
    py = JSON_TYPES.get(expected)
    if py is not None:
        wrong_bool = isinstance(value, bool) and expected in ("integer", "number")
        if not isinstance(value, py) or wrong_bool:
            raise ValueError(f"{where} must be {expected}")
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError(f"{where} must be one of {', '.join(map(str, schema['enum']))}")
    if expected == "string":
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            raise ValueError(f"{where} is longer than {schema['maxLength']}")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            raise ValueError(f"{where} has the wrong format")
    if expected == "integer":
        if "minimum" in schema and value < schema["minimum"]:
            raise ValueError(f"{where} must be at least {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            raise ValueError(f"{where} must be at most {schema['maximum']}")
    if expected == "array":
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            raise ValueError(f"{where} has more than {schema['maxItems']} items")
        return [_check(schema.get("items", {}), item, f"{where}[]") for item in value]
    if expected == "object":
        return check_args(schema, value, where)
    return value


def check_args(schema: dict, args, where: str = "arguments") -> dict:
    """`args` checked against an object schema: no unknown keys, required
    keys present, every value of its declared type. Raises ValueError."""
    if not isinstance(args, dict):
        raise ValueError(f"{where} must be an object")
    props = schema.get("properties", {})
    unknown = sorted(set(args) - set(props))
    if unknown and schema.get("additionalProperties") is False:
        raise ValueError(f"unknown {where}: {', '.join(unknown)}")
    missing = [k for k in schema.get("required", []) if k not in args]
    if missing:
        raise ValueError(f"missing {', '.join(missing)}")
    return {k: _check(props[k], v, k) for k, v in args.items() if k in props}


# ---------- shared helpers (also used by the hosted twin's tests) ----------


def overlapping_pairs(events: list[dict]) -> list[list[str]]:
    """[[file, file]] for every two picked sessions whose times overlap."""
    out = []
    timed = [e for e in events if e.get("start") and e.get("end")]
    for i, a in enumerate(timed):
        for b in timed[i + 1 :]:
            a0, a1 = datetime.fromisoformat(a["start"]), datetime.fromisoformat(a["end"])
            b0, b1 = datetime.fromisoformat(b["start"]), datetime.fromisoformat(b["end"])
            if a0 < b1 and b0 < a1:
                out.append([a["file"], b["file"]])
    return out


def _norm_action(text: str) -> str:
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", (text or "").lower())
    text = re.sub(r"\s+", " ", re.sub(r"[*`_]", "", text)).strip()
    return re.sub(r"[.!?,;: ]+$", "", text)


def _fallback_themes(talks: list[dict]) -> list[dict]:
    for field in ("track", "room"):
        groups: dict[str, list[str]] = {}
        for ev in talks:
            value = (ev.get(field) or "").strip()
            if value and ev.get("id"):
                groups.setdefault(value, []).append(ev["id"])
        if len(groups) >= 2:
            return [{"name": k, "sessions": v} for k, v in groups.items()]
    kinds: dict[str, list[str]] = {}
    for ev in talks:
        kind = (ev.get("type") or "talk").capitalize()
        kinds.setdefault(kind, []).append(ev["id"])
    return [{"name": k, "sessions": v} for k, v in kinds.items()]


def build_board_spec(slug, conference, events, day=None, themes=None, now=None) -> dict:
    """The canvas board for one day: the Python port of web-app/lib/board.ts
    buildBoardSpec, so the drawer draws the same board on both hosts."""
    dated = [e for e in events if e.get("id") and e.get("start")]
    days = sorted({e["start"][:10] for e in dated})
    if not days:
        return {"error": "This conference has no scheduled sessions to draw."}
    day = day if day in days else days[0]
    on_day = sorted((e for e in dated if e["start"][:10] == day), key=lambda e: e["start"])
    talks = [e for e in on_day if (e.get("type") or "") not in REST_TYPES]
    known = {e["id"] for e in talks}
    requested = []
    for theme in themes or []:
        name = str(theme.get("name") or "").strip()[:48]
        ids = [i for i in theme.get("sessions") or [] if i in known]
        if name and ids:
            requested.append({"name": name, "sessions": ids})
    chosen = (requested or _fallback_themes(talks))[:MAX_THEMES]
    theme_of: dict[str, int] = {}
    for index, theme in enumerate(chosen):
        for i in theme["sessions"]:
            theme_of.setdefault(i, index)
    out_themes = [
        {"name": t["name"], "color": THEME_COLORS[i % len(THEME_COLORS)]}
        for i, t in enumerate(chosen)
    ]
    if any(e["id"] not in theme_of for e in talks):
        out_themes.append({"name": "Other", "color": "grey"})
    other = len(out_themes) - 1
    slots = list(dict.fromkeys(e["start"][11:16] for e in on_day))
    sessions = []
    for e in on_day:
        rest = (e.get("type") or "") in REST_TYPES
        speakers = list(e.get("speakers") or [])
        shown = speakers[:MAX_SPEAKERS_SHOWN]
        if len(speakers) > len(shown):
            shown.append(f"+{len(speakers) - len(shown)} more")
        sessions.append(
            {
                "id": e["id"],
                "title": str(e.get("title") or "")[:140],
                "time": f"{e['start'][11:16]}–{(e.get('end') or '')[11:16]}",
                "slot": slots.index(e["start"][11:16]),
                "theme": -1 if rest else theme_of.get(e["id"], other),
                "speakers": [] if rest else shown,
                "rest": rest,
            }
        )
    stamp = int((now or datetime.now()).timestamp() * 1000)
    label = datetime.fromisoformat(day).strftime("%a %-d %b")
    return {
        "id": f"{day}-{stamp:x}",
        "slug": slug,
        "day": day,
        "title": f"{conference.get('name', '')} · {label}",
        "themes": out_themes,
        "slots": slots,
        "sessions": sessions,
    }


# ---------- the mind map (draw_mind_map) ----------
#
# The Python port of web-app/lib/mind-map.ts buildMindMapSpec; both are checked
# against packages/contracts/fixtures/mind-map.json. The drawer lays it out
# (modules/tldraw/mind-map.js): the event or session in the middle, a branch per
# topic, leaves for key points from the notes and for the speakers.

_MD_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_BULLET = re.compile(r"^(?:>\s*)?(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)?")
_SENTENCE_END = re.compile(r"(?<=[.!?])\s")


def clip_text(text: str, limit: int) -> str:
    """`text` cut to `limit` characters at a word boundary, with an ellipsis."""
    text = " ".join(str(text or "").split())
    if len(text) <= limit:
        return text
    cut = text[: limit - 1]
    if " " in cut:
        cut = cut[: cut.rfind(" ")]
    return cut.rstrip(" ,;:-") + "…"


def key_points(text: str, limit: int) -> list[str]:
    """The first `limit` lines of a note section as short points: bullets and
    markdown stripped, one sentence each, no headings, URLs or Sources list."""
    out: list[str] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if line.startswith("#"):
            if line.lstrip("#").strip().lower() == "sources":
                break
            continue
        line = _MD_LINK.sub(r"\1", _BULLET.sub("", line, count=1))
        line = re.sub(r"[*`]", "", line).strip()
        if not line or re.match(r"^https?://", line):
            continue
        line = _SENTENCE_END.split(line, maxsplit=1)[0].rstrip(".")
        out.append(clip_text(line, MAP_POINT_CHARS))
        if len(out) >= limit:
            break
    return out


def _speaker_name(label: str) -> str:
    return str(label or "").split(" (", 1)[0].strip()


def _topic_label(tag: str) -> str:
    return tag[:1].upper() + tag[1:]


def _tag_branches(talks: list[dict]) -> list[dict]:
    """Topics from the sessions' tags: each session joins its most common tag."""
    counts: dict[str, int] = {}
    order: dict[str, int] = {}
    label: dict[str, str] = {}
    for ev in talks:
        for tag in ev.get("tags") or []:
            key = str(tag).strip().lower()
            if not key or key in GENERIC_TAGS:
                continue
            counts[key] = counts.get(key, 0) + 1
            order.setdefault(key, len(order))
            label.setdefault(key, str(tag).strip())
    groups: dict[str, list[str]] = {}
    for ev in talks:
        best = None
        for tag in ev.get("tags") or []:
            key = str(tag).strip().lower()
            if key not in counts:
                continue
            if (
                best is None
                or counts[key] > counts[best]
                or (counts[key] == counts[best] and order[key] < order[best])
            ):
                best = key
        if best is not None:
            groups.setdefault(best, []).append(ev["id"])
    ranked = sorted(groups, key=lambda k: (-len(groups[k]), order[k]))
    return [{"topic": _topic_label(label[k]), "sessions": groups[k], "points": []} for k in ranked]


def _requested_branches(branches, known: set[str]) -> list[dict]:
    out = []
    for branch in branches or []:
        topic = clip_text(branch.get("topic") or "", MAP_TOPIC_CHARS)
        ids = [i for i in branch.get("sessions") or [] if i in known]
        points = [clip_text(p, MAP_POINT_CHARS) for p in branch.get("points") or []]
        points = [p for p in points if p][:MAP_MAX_POINTS]
        if topic and (ids or points):
            out.append({"topic": topic, "sessions": ids, "points": points})
    return out


def _speaker_leaves(sessions: list[dict]) -> list[dict]:
    names = list(
        dict.fromkeys(n for e in sessions for n in map(_speaker_name, e.get("speakers") or []) if n)
    )
    shown = names[:MAP_MAX_SPEAKERS]
    if len(names) > len(shown):
        shown.append(f"+{len(names) - len(shown)} more")
    return [{"text": name, "kind": "speaker"} for name in shown]


def _branch_leaves(branch: dict, sessions: list[dict], notes: dict) -> list[dict]:
    """The Concierge's key points; without them, the notes' points first and the
    titles of sessions without notes after; then the speakers."""
    leaves = [{"text": p, "kind": "point"} for p in branch["points"]]
    if not leaves and sessions:
        per_session = max(1, MAP_MAX_POINTS // len(sessions))
        titles = []
        for ev in sessions:
            sections = notes.get(ev.get("note") or "") or {}
            found = next(
                (
                    p
                    for p in (
                        key_points(sections.get(n, ""), per_session) for n in MAP_NOTE_SECTIONS
                    )
                    if p
                ),
                [],
            )
            leaves.extend({"text": p, "kind": "point"} for p in found)
            if not found:
                title = clip_text(ev.get("title") or "", MAP_TITLE_CHARS)
                titles.append({"text": title, "kind": "session"})
        leaves.extend(titles)
    return leaves[:MAP_MAX_POINTS] + _speaker_leaves(sessions)


def _session_branches(event: dict, notes: dict) -> list[dict]:
    """A session's own map when the Concierge names no topics: its notes, then its tags."""
    sections = notes.get(event.get("note") or "") or {}
    out = []
    for name, topic in (
        ("Human notes", "My notes"),
        ("Summary", "Summary"),
        ("Research", "Research"),
    ):
        points = key_points(sections.get(name, ""), MAP_MAX_POINTS)
        if points:
            out.append({"topic": topic, "leaves": [{"text": p, "kind": "point"} for p in points]})
    tags = [str(t).strip() for t in event.get("tags") or [] if str(t).strip()][:MAP_MAX_POINTS]
    if tags:
        out.append({"topic": "Topics", "leaves": [{"text": t, "kind": "tag"} for t in tags]})
    return out


def build_mind_map_spec(
    slug, conference, events, notes, *, day=None, file=None, branches=None, now=None
) -> dict:
    """The canvas mind map for a conference day (or one session, `file`).
    `notes` maps a session's note file to its sections ({"Human notes": …})."""
    dated = [e for e in events if e.get("id") and e.get("start")]
    days = sorted({e["start"][:10] for e in dated})
    if not days:
        return {"error": "This conference has no scheduled sessions to map."}
    today = (now or datetime.now()).strftime("%Y-%m-%d")
    if day not in days:
        day = today if today in days else days[0]
    by_id = {e["id"]: e for e in dated}
    out: list[dict] = []
    if file:
        event = next((e for e in dated if file in (e.get("note"), e["id"])), None)
        if event is None:
            return {
                "error": f"No session {file} in this conference. Use a note file from get_conference."
            }
        day = event["start"][:10]
        center = {
            "title": clip_text(event.get("title") or "", MAP_TITLE_CHARS),
            "subtitle": f"{event['start'][11:16]}–{(event.get('end') or '')[11:16]}",
        }
        requested = _requested_branches(branches, set())
        if requested:
            out = [
                {"topic": b["topic"], "leaves": [{"text": p, "kind": "point"} for p in b["points"]]}
                for b in requested
            ]
        else:
            out = _session_branches(event, notes)
        speakers = _speaker_leaves([event])
        if speakers:
            out.append({"topic": "Speakers", "leaves": speakers})
    else:
        on_day = sorted((e for e in dated if e["start"][:10] == day), key=lambda e: e["start"])
        talks = [e for e in on_day if (e.get("type") or "") not in REST_TYPES]
        known = {e["id"] for e in talks}
        chosen = _requested_branches(branches, known) or _tag_branches(talks)
        if not chosen:
            chosen = [
                {"topic": t["name"], "sessions": t["sessions"], "points": []}
                for t in _fallback_themes(talks)
            ]
        for branch in chosen[:MAP_MAX_BRANCHES]:
            sessions = sorted((by_id[i] for i in branch["sessions"]), key=lambda e: e["start"])
            out.append(
                {"topic": branch["topic"], "leaves": _branch_leaves(branch, sessions, notes)}
            )
        label = datetime.fromisoformat(day).strftime("%a %-d %b")
        center = {"title": conference.get("name", ""), "subtitle": label}
    out = [b for b in out if b["leaves"]][:MAP_MAX_BRANCHES]
    if not out:
        return {"error": "Nothing to map yet: this session has no notes, tags or speakers."}
    for index, branch in enumerate(out):
        branch["color"] = MAP_COLORS[index % len(MAP_COLORS)]
    stamp = int((now or datetime.now()).timestamp() * 1000)
    return {
        "id": f"map-{day}-{stamp:x}",
        "kind": "mindmap",
        "slug": slug,
        "day": day,
        "center": center,
        "branches": out,
    }


# ---------- the registry ----------


class LocalTools:
    """The spec's tools over the local vault, scoped to what the user has
    open (`slug`, `file`). `emit` streams chat events to the page."""

    def __init__(self, *, slug: str = "", file: str = "", emit=None, host: str = "local:claude"):
        import server  # the vault lives there; imported late (server imports chat)

        self.srv = server
        self.slug = slug or ""
        self.file = file or ""
        self.emit = emit or (lambda _event: None)
        self.host = host

    # Which spec tools this host serves itself: everything except not_on and
    # what the provider serves natively (e.g. Claude's own WebSearch).
    def served(self) -> list[str]:
        skip = set(host_entries("not_on", self.host)) | set(host_entries("native", self.host))
        return [t["name"] for t in spec()["tools"] if t["name"] not in skip]

    def handlers(self) -> dict:
        return {name: getattr(self, name) for name in self.served()}

    def call(self, name: str, args: dict) -> dict:
        """Check `args` against the spec, run the tool, never raise."""
        try:
            clean = check_args(tool_spec(name)["input_schema"], args or {})
        except (ValueError, StopIteration) as error:
            return {"error": f"Invalid arguments: {error}"}
        try:
            return getattr(self, name)(clean)
        except Exception as error:  # noqa: BLE001 — a tool failure is a result, not a crash
            return {"error": f"{name} failed: {type(error).__name__}: {error}"}

    # -- scope helpers --

    def _slug(self, args) -> str:
        return (args.get("slug") or self.slug or "").strip()

    def _agenda(self, slug):
        return self.srv.load_agenda(slug) if slug else None

    def _no_conf(self, slug) -> dict:
        if not slug:
            return {"error": "No conference is open. Call list_conferences and pass a slug."}
        return {"error": f"No such conference: {slug}. Call list_conferences for valid slugs."}

    def _note_file(self, slug, args, inbox_default=True) -> str | None:
        raw = (args.get("file") or "").strip()
        if not raw:
            raw = self.file if slug == self.slug else ""
        if not raw:
            return self.srv.INBOX_NAME if inbox_default else None
        if raw == self.srv.INBOX_NAME:
            return raw
        return self.srv.resolve_note_file(slug, raw)

    # -- read --

    def list_conferences(self, _args):
        rows = []
        for c in self.srv.conferences_payload():
            rows.append({**c, "status": self.srv.conf_status(self.srv.load_agenda(c["slug"]))})
        return {"conferences": rows}

    def get_conference(self, args):
        slug = self._slug(args)
        data = self.srv.conference_payload(slug) if slug else None
        if not data:
            return self._no_conf(slug)
        return {"slug": slug, **{k: data[k] for k in ("conference", "rooms", "tracks", "events")}}

    def get_conference_docs(self, args):
        slug = self._slug(args)
        data = self._agenda(slug)
        if not data:
            return self._no_conf(slug)
        return {
            "slug": slug,
            "status": self.srv.conf_status(data),
            "brief": self.srv.read_conf_doc(slug, "BRIEF.md") or "",
            "debrief": self.srv.read_conf_doc(slug, "DEBRIEF.md") or "",
        }

    def read_notes(self, args):
        slug = self._slug(args)
        if not self._agenda(slug):
            return self._no_conf(slug)
        return {"slug": slug, "digest": self.srv.session_digest(slug) or "(no notes yet)"}

    def read_note(self, args):
        slug = self._slug(args)
        if not self._agenda(slug):
            return self._no_conf(slug)
        file = self._note_file(slug, args)
        if file == self.srv.INBOX_NAME:
            p = self.srv.inbox_path(slug)
        else:
            p = self.srv.note_path(slug, file) if file else None
        if not p or not p.exists():
            return {"error": f"No such note: {args.get('file') or file}"}
        fm, title, sections = self.srv.parse_note(self.srv.strip_private(p.read_text()))
        sections.pop(self.srv.PRIVATE_SECTION, None)  # never shown to the agent
        return {
            "slug": slug,
            "file": p.name,
            "title": title,
            "frontmatter": fm,
            "sections": sections,
        }

    def get_my_agenda(self, args):
        slug = self._slug(args)
        data = self.srv.conference_payload(slug) if slug else None
        if not data:
            return self._no_conf(slug)
        picks = [
            {
                "file": e["note"],
                "id": e["id"],
                "title": e["title"],
                "start": e["start"],
                "end": e["end"],
                "room": e.get("room", ""),
                "speakers": e.get("speakers", []),
                "description": e.get("description", ""),
            }
            for e in data["events"]
            if e.get("note") and e.get("attending")
        ]
        picks.sort(key=lambda p: p["start"])
        return {"slug": slug, "picks": picks, "clashes": overlapping_pairs(picks)}

    def get_actions(self, args):
        slug = self._slug(args)
        data = self.srv.actions_payload(slug) if slug else None
        return data if data is not None else self._no_conf(slug)

    def research_speakers(self, args):
        slug = self._slug(args)
        data = self._agenda(slug)
        if not data:
            return self._no_conf(slug)
        file = self._note_file(slug, args, inbox_default=False)
        ev = self.srv._event_for_note(data, file) if file else None
        if not ev:
            return {"error": f"Unknown session: {args.get('file')}"}
        people = data.get("speakers", {})
        self.emit({"notice": f"⌕ researching speakers for {file}…"})
        return {
            "slug": slug,
            "file": file,
            "title": ev.get("title", ""),
            "abstract": ev.get("description", ""),
            "speakers": [
                {
                    "name": self.srv.speaker_label(i, people),
                    "bio": people.get(i, {}).get("bio", ""),
                }
                for i in ev.get("speakers", [])
            ],
        }

    def recall_history(self, args):
        hits = self.srv.recall_chat_history(args["query"].strip(), RECALL_LIMIT) or []
        return {
            "turns": [
                {"ts": (h.get("ts") or "")[:19], "role": h.get("role"), "text": h.get("text", "")}
                for h in hits
            ]
        }

    def validate_conference(self, args):
        try:
            obj = json.loads(args["agenda_json"])
        except ValueError as e:
            return {"ok": False, "errors": [f"invalid agenda JSON: {e}"], "warnings": []}
        preview = self.srv.conference_preview(obj)
        return {k: preview[k] for k in ("ok", "errors", "warnings", "summary")}

    def read_artifact(self, args):
        slug = (args.get("slug") or "").strip()
        p = self.srv.agent_artifact_path(args["name"], slug)
        if p is None or not p.exists():
            return {"error": f"No such artifact: {args['name']}"}
        return {"name": args["name"], "slug": slug, "content": p.read_text()}

    # -- network --

    def fetch_url(self, args):
        self.emit({"notice": "⌕ fetching a page…"})
        return web_fetch.fetch_url_text(args["url"])

    # -- write --

    def set_attending(self, args):
        slug = self._slug(args)
        if not self._agenda(slug):
            return self._no_conf(slug)
        file = self._note_file(slug, args, inbox_default=False)
        if not file or file == self.srv.INBOX_NAME:
            return {"error": f"Unknown session: {args.get('file')}"}
        result = self.srv.set_picks(slug, {file: args["attending"]})
        self.emit({"picks_changed": {"slug": slug}})
        return {
            "slug": slug,
            "file": file,
            "attending": args["attending"],
            "notes": result["notes"],
        }

    def append_action(self, args):
        slug = self._slug(args)
        if not self._agenda(slug):
            return self._no_conf(slug)
        file = self._note_file(slug, args)
        text = args["text"].strip()
        if not file or not text:
            return {"error": "A session note (or INBOX.md) and action text are required."}
        with self.srv._NOTE_WRITE_LOCK:
            if file == self.srv.INBOX_NAME:
                done = self.srv.append_inbox_action(slug, text)
            else:
                done = self.srv.append_session_action(slug, file, text)
        if not done:
            return {"error": f"Could not append the action to {slug}/{file}"}
        self.emit({"notice": f"Added action in {file}."})
        return {"ok": True, "slug": slug, "file": file, "action": text}

    def mark_action_done(self, args):
        slug = self._slug(args)
        if not self._agenda(slug):
            return self._no_conf(slug)
        file = self._note_file(slug, args)
        inbox = file == self.srv.INBOX_NAME
        p = self.srv.inbox_path(slug) if inbox else self.srv.note_path(slug, file or "")
        if not p or not p.exists():
            return {"error": f"No such note: {args.get('file') or file}"}
        done = args.get("done", True)
        wanted_index = args.get("index", 0) - 1
        wanted_text = _norm_action(args.get("text", ""))
        with self.srv._NOTE_WRITE_LOCK:
            fm, title, sections = self.srv.parse_note(p.read_text())
            seen, changed, lines = -1, False, []
            for line in (sections.get("Actions") or "").split("\n"):
                m = ACTION_LINE_RE.match(line)
                if m:
                    seen += 1
                    hit = seen == wanted_index or bool(
                        wanted_text and _norm_action(m.group(4)) == wanted_text
                    )
                    if hit:
                        line = f"{m.group(1)}{'x' if done else ' '}{m.group(3)}{m.group(4)}"
                        changed = True
                lines.append(line)
            if not changed:
                return {"error": "action not found"}
            if inbox:
                p.write_text(f"# Inbox\n\n## Actions\n\n{chr(10).join(lines).strip()}\n")
            else:
                self.srv.apply_note_section(p, "Actions", "\n".join(lines))
        self.emit({"notice": f"Updated action in {p.name}."})
        return {"ok": True, "slug": slug, "file": p.name, "done": done}

    def _write_section(self, args, section, text):
        slug = self._slug(args)
        if not self._agenda(slug):
            return self._no_conf(slug)
        file = self._note_file(slug, args, inbox_default=False)
        p = self.srv.note_path(slug, file) if file and file != self.srv.INBOX_NAME else None
        if not p:
            return {"error": "A session note file is required to write a section."}
        with self.srv._NOTE_WRITE_LOCK:
            self.srv.apply_note_section(p, section, text)
        self.emit({"notice": f"✎ {section} → {p.name}"})
        return {"ok": True, "slug": slug, "file": p.name, "section": section}

    def update_agent_section(self, args):
        return self._write_section(args, args["section"], args["text"])

    def save_research(self, args):
        sources = [s for s in args.get("sources") or [] if s.strip()]
        block = ("\n\n### Sources\n" + "\n".join(f"- {s}" for s in sources)) if sources else ""
        result = self._write_section(args, "Research", args["text"].strip() + block)
        return {**result, "sources": sources} if "error" not in result else result

    def write_conference_doc(self, args):
        slug = self._slug(args)
        if not self._agenda(slug):
            return self._no_conf(slug)
        name = args["name"]
        self.srv.write_conf_doc(slug, name, args["text"])
        self.emit({"notice": f"✎ Wrote conference {name}"})
        synced = 0
        if name == "DEBRIEF.md" and args.get("sync_debrief_actions", True):
            synced = self.srv.sync_debrief_actions_to_inbox(slug) or 0
            if synced:
                self.emit(
                    {
                        "notice": f"Filed {synced} action item{'' if synced == 1 else 's'} into the Actions inbox."
                    }
                )
        return {"ok": True, "slug": slug, "name": name, "synced_actions": synced}

    def add_conference(self, args):
        try:
            obj = json.loads(args["agenda_json"])
        except ValueError as e:
            return {"error": f"Invalid JSON: {e}"}
        return self._import(obj)

    def _import(self, obj, source: str = ""):
        preview = self.srv.conference_preview(obj)
        if not preview["ok"]:
            return {"ok": False, "errors": preview["errors"], "warnings": preview["warnings"]}
        try:
            message = self.srv.create_conference(preview["manifest"])
        except ValueError as e:
            return {"error": f"Rejected: {e}"}
        slug = preview["summary"].get("slug", "")
        self.emit({"conference_imported": {"slug": slug}})
        self.emit({"notice": "✎ Imported a new conference"})
        return {
            "ok": True,
            "slug": slug,
            "name": preview["summary"].get("name", ""),
            "message": message,
            "warnings": preview["warnings"],
            **({"source": source} if source else {}),
        }

    def import_conference_from_url(self, args):
        try:
            page = web_fetch.fetch_public(args["url"])
        except web_fetch.FetchError as e:
            return {"error": str(e)}
        try:
            obj = json.loads(page["raw"])
        except ValueError:
            obj = None
        if isinstance(obj, dict) and "conference" in obj and "events" in obj:
            return self._import(obj, "the agenda file")
        return {
            "error": "No agenda file at that link. Read the page with fetch_url, build a "
            "confnote.agenda.v1 manifest from what it states, check it with "
            "validate_conference and import it with add_conference.",
            "url": page["url"],
        }

    def prepare_event_brief(self, args):
        slug = self._slug(args)
        if not self._agenda(slug):
            return self._no_conf(slug)
        # The hosted server writes the brief after the reply; here the
        # Concierge has the turn budget to do it now, step by step.
        return {
            "ok": True,
            "slug": slug,
            "status": "run now",
            "steps": [
                "For each session in get_conference (skip ones whose Research is filled): "
                "research_speakers(file), then web_search / fetch_url, then save_research(file, text, sources).",
                "Then write_conference_doc(name='BRIEF.md') covering who is speaking, the agenda's "
                "shape, what to listen for and questions to ask.",
                "Report progress between sessions.",
            ],
        }

    def save_artifact(self, args):
        slug = (args.get("slug") or "").strip()
        p = self.srv.agent_artifact_path(args["name"], slug)
        if p is None:
            return {"error": "Rejected: invalid name (letters/digits/._-) or unknown conference."}
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(args["content"])
        self.emit({"notice": f"⬇ saved artifact {args['name']}"})
        return {"ok": True, "name": args["name"], "slug": slug}

    def move_artifact(self, args):
        src = self.srv.agent_artifact_path(args["name"], "")
        dst = self.srv.agent_artifact_path(args["name"], args["slug"].strip())
        if src is None or dst is None:
            return {"error": "Rejected: invalid name or unknown conference."}
        if not src.exists():
            return {"error": f"No workspace file named {args['name']} to move."}
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.replace(dst)
        self.emit({"notice": f"→ filing {args['name']} under {args['slug']}"})
        return {"ok": True, "name": args["name"], "slug": args["slug"]}

    def set_schedule_offset(self, args):
        if not self.slug:
            return {"error": "Open a conference to change its schedule."}
        try:
            payload = self.srv.set_conference_schedule(
                self.slug, args["offset_minutes"], args["expected_offset"]
            )
        except (ValueError, FileNotFoundError) as error:
            return {"error": str(error)}
        self.emit({"conference_rescheduled": {"slug": self.slug, "conference": payload}})
        return {
            "schedule_offset_minutes": payload.get("schedule_offset_minutes"),
            "schedule_revision": payload.get("schedule_revision"),
        }

    def draw_conference_board(self, args):
        slug = self._slug(args)
        data = self.srv.conference_payload(slug) if slug else None
        if not data:
            return self._no_conf(slug)
        board = build_board_spec(
            slug, data["conference"], data["events"], args.get("day"), args.get("themes")
        )
        if "error" in board:
            return board
        path = self.srv.module_state_path(BOARD_MODULE, slug)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.srv.atomic_write(path, json.dumps(board))
        themes = [t["name"] for t in board["themes"]]
        self.emit({"open_module": BOARD_DRAWER})
        self.emit(
            {
                "notice": f"Drew {board['day']} on the canvas: {len(board['sessions'])} sessions in {len(themes)} themes."
            }
        )
        return {
            "ok": True,
            "board": board["id"],
            "day": board["day"],
            "sessions": len(board["sessions"]),
            "themes": themes,
        }

    def _real_lines(self, name: str, body: str) -> str:
        """`body` without the importer's seed hints (and Summary's seeded abstract)."""
        lines = (body or "").splitlines()
        return "\n".join(line for line in lines if self.srv._section_has_real_content(name, line))

    def _map_notes(self, slug, events) -> dict:
        """{note file: sections} for the sessions that have notes (Private never included)."""
        out = {}
        for ev in events:
            if not (ev.get("has_notes") and ev.get("note")):
                continue
            p = self.srv.note_path(slug, ev["note"])
            if p is None or not p.exists():
                continue
            _fm, _title, sections = self.srv.parse_note(self.srv.strip_private(p.read_text()))
            out[ev["note"]] = {
                name: self._real_lines(name, sections.get(name, "")) for name in MAP_NOTE_SECTIONS
            }
        return out

    def draw_mind_map(self, args):
        slug = self._slug(args)
        data = self.srv.conference_payload(slug) if slug else None
        if not data:
            return self._no_conf(slug)
        mind_map = build_mind_map_spec(
            slug,
            data["conference"],
            data["events"],
            self._map_notes(slug, data["events"]),
            day=args.get("day"),
            file=(args.get("file") or "").strip() or None,
            branches=args.get("branches"),
        )
        if "error" in mind_map:
            return mind_map
        path = self.srv.module_state_path(BOARD_MODULE, slug)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.srv.atomic_write(path, json.dumps(mind_map))
        topics = [b["topic"] for b in mind_map["branches"]]
        leaves = sum(len(b["leaves"]) for b in mind_map["branches"])
        self.emit({"open_module": BOARD_DRAWER})
        self.emit(
            {"notice": f"Drew a mind map on the canvas: {len(topics)} topics, {leaves} notes."}
        )
        return {
            "ok": True,
            "map": mind_map["id"],
            "day": mind_map["day"],
            "center": mind_map["center"]["title"],
            "topics": topics,
            "leaves": leaves,
        }
