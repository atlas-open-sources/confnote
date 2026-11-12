# confnote

A fast, zero-dependency local notes tool for conferences. Python 3 stdlib
server + a vanilla no-build single-page UI. The markdown files in each
`<conf>/notes/` directory are the source of truth — the app is just a quick
editor over them, so an agent can read and write the same files.

## Run

```sh
packages/local-app/run.sh                            # recommended — chat enabled
packages/local-app/run.sh desktop                    # native window (pywebview)
python3 packages/local-app/server.py                 # core only, no chat
CONF_NOTES_PORT=9000 packages/local-app/run.sh
```

### Build a macOS .app (dev + prod)

```sh
packages/local-app/build-macos.sh            # PROD → "confnote.app"
packages/local-app/build-macos.sh dev        # DEV  → "confnote dev.app" with fresh bundle id
packages/local-app/build-macos.sh dev mic    # DEV  → pinned tag: com.atlas.confnote.dev.mic
make app-install                             # rebuild/sign/install prod + dev.local
make app-dev DEV_TAG=mic                     # pinned-tag shortcut
```

Prod uses the stable bundle id `com.atlas.confnote`. Dev uses
`com.atlas.confnote.dev.<tag>`; by default the tag includes branch, commit, and
timestamp so every direct dev script build gets a fresh macOS permission flow.
The Makefile in-place target pins dev to `local` unless `DEV_TAG` is provided,
so everyday local auth stays stable.

Dev and prod also have different names and **logos** (prod green / dev amber)
so you can install and run **both side by side** — test prod while iterating on
dev. Double-clickable, Developer ID signed when the Atlas Codes certificate is
available; the build refuses to silently fall back to ad-hoc signing because
that would not exercise real macOS auth/permission behaviour. Use
`ALLOW_ADHOC=1` only for throwaway local builds. Still shells your local
`claude` for chat/research — `desktop.py` widens `PATH` so a Finder-launched
bundle finds it. Point it at your notes with `CONF_NOTES_DIR`. Other Macs need
notarization; use `NOTARIZE=1` after storing the notarytool keychain profile.
First-run folder picker is the next refinement. See
`packages/local-app/build-macos.sh`.

### Theme & look

Crisp B&W "Vercel" system: high-contrast monochrome, boxy (4–6px radii),
1px borders, flat. Green (`--live`) is the only non-B&W token — used only for
functional status (live/has-notes node, open-action badge, "saved ✓"). The ◐
button (top-right) cycles **auto → light → dark** (auto follows macOS);
remembered across reloads.

### Home

Two tabs: **My Conf** — a vertical timeline of conferences anchored at a
`● TODAY` marker (history above, upcoming below) — and **Discover** (TBD
placeholder). Each conference node shows progress + the Debrief button.

### Quality gate

`make lint` (ruff + ruff-format + Biome + pytest) · `make fix` (auto-format)
· `make test`. A `pre-commit` hook (installed in `.git/hooks`) runs lint +
secret scan + tests on commit. See `CONTRIBUTING.md`.

`run.sh` bootstraps a local venv + `claude-agent-sdk` (uses your existing
`claude` login — no API key) and serves on http://localhost:8787. Plain
`python3 app/server.py` still works without the chat bubble. No npm, no build;
the only vendored front-end assets (EasyMDE, deep-chat) are local so it works
offline. Stop with Ctrl+C.

## How it works

- **Home** — every `YYYY-MM-DD-slug/` conference folder, newest first, with a
  notes-progress bar.
- **Conference** — the agenda as a timeline (talks AND breaks/networking/lunch
  are all note-able); the live talk is marked `●` with a working jump button.
- **Session** — tabbed editor. Editable tabs use **EasyMDE** (toolbar +
  shortcuts + side-by-side preview that uses the app's sanitized renderer);
  it falls back to a plain textarea if the bundle is missing. Paste or drag an
  image straight in to attach it.
- **💬 Chat bubble** — per-session agent (Agent SDK, local `claude` login)
  with the talk's full context. It can rewrite **only `## Summary`**, and only
  when you explicitly ask; you watch it land via the live refresh.

## Section contract (this is the agent-first part)

Each `notes/HHMM-<id>.md` file is frontmatter + fixed `##` sections:

| Section       | Owner        | In the app                              |
| ------------- | ------------ | --------------------------------------- |
| `Brief`       | **you**      | panel **above** the editor (pre-talk)   |
| `Human notes` | **you**      | EasyMDE editor — your primary notes     |
| `Summary`     | **agent**    | AI-driven, read-only, live-refreshed    |
| `Research`    | **agent**    | AI-driven dossier, read-only            |
| `AI notes`    | **agent**    | read-only, live-refreshed from disk     |
| `Transcript`  | system/you    | editable + record/drop-audio toolbar    |
| `Links`       | you          | EasyMDE editor                          |
| `Scratchpad`  | you          | EasyMDE editor                          |
| `Debrief`     | **you**      | panel **below** the editor; **actions** |

**Brief / Debrief** bracket the tabbed editor (collapsible panels, not tabs).
`Debrief` holds free text **plus action items** — markdown task lines
`- [ ] task` / `- [x] done`. The Debrief panel renders them as a checkbox
list (add/tick inline, or edit raw). Per conference, a **Debrief** button
(Home timeline + agenda view) shows the open-action count and opens a modal
of *all* open actions grouped by session — tick them off inline; counts and
the markdown update live. (`GET /api/actions?slug=` powers the counts.)

On save the server **re-reads the file and rewrites only the editable
sections**, so an agent writing `## Summary` / `## AI notes` during a live
talk is never clobbered, and vice versa. Agents own `## Summary` and
`## AI notes`. Only the exact canonical headings above act as section
delimiters, so you can freely use `##`/`###` headings inside your own notes
without breaking the structure.

## Files — two ways in, one folder

Every talk gets a seeded drop folder: `notes/assets/<HHMM-id>/`.

1. **You dump into it** — drop screenshots, PDFs, photos straight into that
   folder in Finder.
2. **The app dumps into it** — paste/drag images into a note, or drop them on
   the **📎 Files** tab.

Either way the **📎 Files** tab lists everything in that folder (images as
thumbnails, other files as links) and lets you insert any of them into your
notes. Folders are seeded by `tools/import_agenda.py` at import time, so
they exist before you ever open the app.

## Pre-conference research

Run **before** the event to fill every session's `## Research` dossier
(speaker + company, verified LinkedIn, recent work, questions to ask) via the
Agent SDK + web search:

```sh
packages/local-app/.venv/bin/python tools/research.py 2026-05-19-beyond-the-prompt
packages/local-app/.venv/bin/python tools/research.py <conf> --force
packages/local-app/.venv/bin/python tools/research.py <conf> codebase-design
```

Idempotent (skips already-researched sessions) and section-preserving.

## agenda.json is the contract

Everything derives from `<conf>/agenda.json` (Beyond-The-Prompt schema:
`conference`, `speakers{}`, `events[]`). This event shipped one; **future
conferences will not** — the plan is a `tools/agenda_from_url.py` that scrapes
a conference site into that same schema, then feeds `tools/import_agenda.py`.
Keep the schema stable; it is the single ingestion seam.

## Conference creation

New conferences are created from a versioned
`confnote.agenda.v1` manifest. The home-screen manual form, pasted JSON, and
concierge agent tools all validate the same JSON shape before calling the
same importer. See `docs/schema/confnote-agenda-v1.md`.

The Transcript tab supports manual paste, dropped audio files, and in-app
recording. Transcripts append to `## Transcript`; recordings are stored under
the session's `notes/assets/<HHMM-id>/` folder.

## Local HTTP clients

The server accepts only loopback Host names. Every POST or PUT, including calls
from non-browser clients, must send an `Origin` header equal to the server origin
(for example, `Origin: http://127.0.0.1:8000`). Use the actual host and port from
the request URL. This protects local state against cross-site requests and DNS
rebinding; do not disable it for scripts. Routes that require
`X-Confnote-Request` still require that marker too.
