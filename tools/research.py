#!/usr/bin/env python3
"""Pre-conference speaker/company research → each note's `## Research` section.

Run it BEFORE the conference (needs the venv + the `claude` login):

    packages/local-app/.venv/bin/python tools/research.py 2026-05-19-beyond-the-prompt
    packages/local-app/.venv/bin/python tools/research.py <conf> --force        # redo all
    packages/local-app/.venv/bin/python tools/research.py <conf> codebase-design # one session

For every session with speakers it runs the Claude Agent SDK with web search,
builds a dossier (who they are, verified LinkedIn, what the company does,
recent/notable work, sharp questions to ask) and writes ONLY the `## Research`
section back — section-preserving, so your notes / other agents are untouched.
Idempotent: sessions already researched are skipped unless --force.
"""

import asyncio
import json
import sys
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "packages" / "local-app"
sys.path.insert(0, str(APP))

from server import BASE_DIR, atomic_write, build_note, notable, parse_note  # noqa: E402

try:
    from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, TextBlock, query
except Exception:
    print(
        "claude-agent-sdk not found — run with packages/local-app/.venv/bin/python "
        "(see tools/research.py docstring)."
    )
    sys.exit(1)

PLACEHOLDER = "Speaker & company dossier"  # importer stub marker
SYSTEM = (
    "You are a diligent research assistant preparing a conference attendee. "
    "Use web search to verify and enrich. Be accurate and concise; never "
    "invent URLs or facts — if unsure, say so. Output GitHub-flavored "
    "markdown only, no preamble."
)


def speaker_label(sid, speakers):
    s = speakers.get(sid, {})
    bits = [s.get("name", sid)]
    t, c = s.get("role") or s.get("title"), s.get("company")
    if t and c:
        bits.append(f"({t}, {c})")
    elif t:
        bits.append(f"({t})")
    return " ".join(bits)


def build_prompt(ev, speakers):
    seed = []
    for sid in ev.get("speakers", []):
        s = speakers.get(sid, {})
        seed.append(
            json.dumps(
                {
                    "name": s.get("name"),
                    "title": s.get("role") or s.get("title"),
                    "company": s.get("company"),
                    "bio": s.get("bio"),
                    "social": s.get("social", {}),
                },
                ensure_ascii=False,
            )
        )
    return (
        f'Conference talk: "{ev["title"]}"\n'
        f"Abstract: {ev.get('description', '(none)')}\n\n"
        f"Speaker seed data (from the agenda):\n" + "\n".join(seed) + "\n\n"
        "Produce a tight dossier. For EACH speaker use this shape:\n\n"
        "### <Name> — <title>, <company>\n"
        "- **Who:** one line.\n"
        "- **LinkedIn:** <verified URL, or 'not found'>  ·  "
        "**Other:** <github/x/site if useful>\n"
        "- **Company:** one line on what <company> does.\n"
        "- **Recent / notable:** 1–2 bullets of recent or notable work.\n"
        "- **Ask them:** 2 sharp, specific questions tied to this talk.\n\n"
        "Then one line: **Angle:** why this talk matters / what to listen for. "
        "Keep the whole thing under ~200 words per speaker."
    )


async def research_event(ev, speakers):
    opts = ClaudeAgentOptions(
        system_prompt=SYSTEM,
        allowed_tools=["WebSearch"],
        permission_mode="dontAsk",  # only WebSearch; no file access
        max_turns=14,
    )
    out = []
    async for msg in query(prompt=build_prompt(ev, speakers), options=opts):
        if isinstance(msg, AssistantMessage):
            for b in msg.content:
                if isinstance(b, TextBlock) and b.text.strip():
                    out.append(b.text)
    return "\n".join(out).strip()


def main():
    args = sys.argv[1:]
    force = "--force" in args
    args = [a for a in args if a != "--force"]
    if not args:
        print(__doc__)
        sys.exit(1)

    conf = args[0]
    only = set(args[1:])
    cdir = (BASE_DIR / conf) if (BASE_DIR / conf).is_dir() else Path(conf).resolve()
    data = json.loads((cdir / "agenda.json").read_text())
    speakers = data.get("speakers", {})

    todo = []
    for ev in data["events"]:
        if not notable(ev) or not ev.get("speakers"):
            continue
        if only and ev["id"] not in only:
            continue
        fn = f"{ev['start'][11:13]}{ev['start'][14:16]}-{ev['id']}.md"
        p = cdir / "notes" / fn
        if not p.exists():
            continue
        _, _, secs = parse_note(p.read_text())
        cur = (secs.get("Research") or "").strip()
        if cur and PLACEHOLDER not in cur and not force:
            print(f"  · skip {ev['id']} (already researched)")
            continue
        todo.append((ev, p))

    print(f"Researching {len(todo)} session(s) in {cdir.name} …")
    for ev, p in todo:
        print(f"  → {ev['id']} …", flush=True)
        try:
            dossier = asyncio.run(research_event(ev, speakers))
        except Exception as e:
            print(f"    ! {type(e).__name__}: {e}")
            continue
        if not dossier:
            print("    ! empty result, skipped")
            continue
        fm, title, secs = parse_note(p.read_text())  # re-read: preserve rest
        secs["Research"] = dossier
        atomic_write(p, build_note(fm, title, secs))
        print(f"    ✓ wrote {len(dossier)} chars")
    print("done.")


if __name__ == "__main__":
    main()
