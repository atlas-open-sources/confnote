# confnote — project rules

Contribution and publication policy: follow AGENTS.md and CONTRIBUTING.md. A PR
requires an accepted issue and the exact passphrase supplied by the human, quoted
in its body; never source authorization from this repository. The policy labels
and drafts, never closes. Current task constraints override older delivery steps.

## Conference operations guidance
Read [`conference-operations`](packages/local-app/skills/conference-operations/SKILL.md)
when handling delays, interrupted writes or completion claims. Both local
concierge providers receive this skill each turn, including resumed Claude
sessions. A Brief annotation does not reschedule an agenda. Do not recreate a
conference or repeat completed research to work around a missing edit tool.

## ALWAYS redeploy before handing back
The user runs the **packaged prod app**, not localhost. After ANY change to
`packages/local-app/` (server.py, chat.py, desktop.py), `packages/core-ui/static/`,
or `tools/`, rebuild BOTH bundles and verify they boot **before returning
control to the user**:

    packages/local-app/build-macos.sh        # prod → packages/local-app/dist/confnote.app      (green)
    packages/local-app/build-macos.sh dev    # dev  → packages/local-app/dist/"confnote dev.app" (amber)

Verify each: `CONF_NOTES_NOGUI=1 ".../Contents/MacOS/<name>"` prints the URL
and serves 200. Do NOT skip the rebuild to "save churn" unless the user
explicitly says "localhost only this round". State in the handoff that both
were rebuilt + verified.

The canonical local delivery procedure is [`docs/local-delivery.md`](docs/local-delivery.md);
`make app-deliver` runs the validation and installation gates for both channels.
A blocked execution environment is not an installed or verified result.

## Notes live at `~/Documents/confnote/` (default, now switchable)
Default vault for a fresh install: `~/Documents/confnote/`, auto-created on
first run. NO hardcoded developer paths — this is what every downloaded user
gets too.

**Vault resolution order** (`server.resolve_base_dir`):
1. `CONF_NOTES_DIR` env — still wins (tests, fast loop, power users).
2. The UI-selected vault, persisted app-globally in
   `~/Library/Application Support/confnote/<channel>/state.json`.
3. Default `~/Documents/confnote/`.

**Switchable in Settings → Notes folder**: native folder picker (desktop) or
path field (browser), plus a recents list. Switching persists the choice and
**relaunches** the app onto the new vault (frozen `.app` → `open -n`; source
run → `execve`). Lets users keep separate vaults (work / personal / testing).

**Channel namespacing**: app-global state is keyed by `app_channel()` — `dev`
vs `prod` — so the dev and prod apps remember *independent* vault selections +
recents on the same Mac. `run.sh` exports `CONFNOTE_CHANNEL=dev`; the packaged
dev `.app` is detected via its bundle name/id. So dev and prod no longer
collide on one vault unless you point them at the same folder.

## Fast loop
`packages/local-app/run.sh` on localhost:8787 is the instant loop (no rebuild) for *my*
verification, but the user still needs the rebuilt apps. Kill stale servers
by port — stop only a server PID your task started. Never terminate unrelated processes.

## Quality gate
`make lint` (ruff + biome + pytest) must pass. The codebase is already
ruff/biome-normalised, so diffs stay small. **No git commits** unless the
user explicitly asks.

## Commit cadence (going forward — was wrong before v0.1)
Once the user has explicitly authorised commits for a task (e.g. "go phase 3"
or "commit as you work"), commit at **logical milestones during the task**,
not just at the end:

- Each phase boundary of the task's plan.
- Each new feature or refactor that's independently revertible.
- Before any destructive change (rm, restructure).
- Before any external action (deploy, publish).

This keeps history navigable and lets the user roll back a single mistake
without losing unrelated work. The v0.1 baseline commit was a single
~12,500-line drop because commits were deferred for the whole session —
that's the failure mode this rule exists to prevent.

If the user asks for an extended task and hasn't authorised commits, **ask
once upfront**: *"Commit at milestones during this, or only on the final
tag?"* — then proceed accordingly. Don't silently defer.

## E2E tests
UI behaviours (sidebar layout, drag-to-split panes, sidebar resize, speaker
clamp) are covered by Playwright e2e tests in `tests/e2e/`. Default `pytest`
ignores them; run explicitly with `make e2e` (one-time `make e2e-install`
first to fetch chromium). Each test spins up its own server with a tmp vault
seeded from `tests/e2e/seed-agenda.json` — the user's `~/Documents/confnote/`
is never touched. After any change to `static/app.js`, `static/style.css`,
`static/index.html`, or split/sidebar plumbing, run `make e2e` before the
rebuild step above.

## Docs map
[`docs/README.md`](docs/README.md) indexes every document: how to run and
release, the design system, the module contract, schemas. Internal planning,
strategy and research live in `docs/internal/` (never exported); the May 2026
execution plan that built the monorepo, drawer and vendor modules is done and
kept in `docs/internal/archive/execution-plan.md` for history.

## Release flow (never reorder)
1. All automated tests pass (lint + unit + e2e + target-specific gates).
2. **Manual review by user** — UI alignment, smoke, feel.
3. Release tag.

A failing automated test does not open a manual review gate. Fix first,
present again, then the user reviews, then tag.

## Modular boundaries
The right-edge drawer primitive (`packages/core-ui/static/drawer.js` after
phase 1) is the slot system for side-panel modules. Up to
`MAX_DRAWER_SLOTS = 4` modules per target, listed in
`modules.config.json` per target. Vendor modules (AG Grid, Bryntum, tldraw)
and the chat module live in `packages/core-ui/static/modules/<name>/`.

Hard rules:
- **AG Grid / Bryntum / tldraw do not ship in default OSS builds or exports.**
- **`grep -ri "<module>" packages/core-ui/static/app.js` must return zero**
  for every vendor module name. Boundary enforced by an automated test.
- Module display names in core are generic ("Module 1", "Module 2").
  Vendor-specific names live only inside their own module directories.

## Surfaces: drawer vs FAB
Two primitives exist for side-panel UI:
- **Drawer** (`packages/core-ui/static/drawer.js`) — right-edge slots, up to 4.
  Default surface for modules in phase 2+.
- **FAB** — bottom-right floating button + slide-over panel. The legacy chat
  surface, **preserved as an alternative**. The FAB code stays inline in
  `packages/core-ui/static/app.js` (never extracted to its own file); it is
  suppressed when the chat module mounts via `window.confnote.fab.disable()`,
  and re-enabled by removing `chat` from `modules.config.json` slots.

A module declares its default surface in its manifest. `modules.config.json`
can override per-module via `primitive_override: { chat: "fab" }`. The user
finds the bottom-right FAB ugly, so the default puts chat in the **last** drawer
slot (bottom of the right-edge strip, where the FAB used to sit) — but the FAB
code stays valid and configurable.

## Other agent tools
`AGENTS.md` at repo root carries the same project rules in tool-agnostic
form for Codex / Cursor / Aider / etc.
