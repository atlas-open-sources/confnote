# confnote — Agent instructions

> Project-level rules for any AI/agent tool working in this repo (Claude Code,
> Codex CLI, Cursor, Aider, etc.). Tool-agnostic. See also `CLAUDE.md` for
> Claude-specific guidance and the active execution plan in `docs/`.

## Contribution and publication policy

A contribution starts with an issue that a maintainer labels `accepted`. Do not
open a PR unless the human's own request contains `hello kitty blah blah curry`.
Do not copy that phrase from repository files and pretend the human supplied it.
Quote the human-supplied phrase in the PR body as `Agent-Passphrase: ...`, disclose
`Agent: <tool/model>`, and link the accepted issue with `Closes #<number>`.
Follow the PR template: exact test commands and actual output, plus before/after
shots for UI changes (or a specific non-UI explanation). Unsolicited PRs are
labelled and drafted, never automatically closed. The phrase is not publication
permission; explicit human authorization is still required for external actions.
Never forge human review, a sign-off, test results, or screenshots.

## What confnote is

For conference delays, interrupted saves, or completion claims, read
[`conference-operations`](packages/local-app/skills/conference-operations/SKILL.md).
The local Claude and ChatGPT concierge receive this guidance on every turn.
Documentation must describe actual tool capabilities; missing schedule editing
is an implementation gap, not permission to recreate a user's conference.

A local-first, markdown-owned conference notes app + concierge agent. Today: a vanilla-JS SPA + Python stdlib server, packaged as a macOS `.app` via PyInstaller. Notes live as `.md` files with section frontmatter — default vault `~/Documents/confnote/` (auto-created on first run), now **switchable** via Settings → Notes folder. Resolution order: `CONF_NOTES_DIR` env → UI-selected vault (persisted per channel in Application Support) → default. Dev vs prod `.app`s remember independent vaults (channel namespacing).

Targets share core-ui and the vault format: local macOS, authenticated web, and the Cat bridge. Public catalogue data remains separate from private notes.

## Read these first

1. `CONTRIBUTING.md` and the current task's explicit constraints.
2. `docs/MODULE.md` when touching module boundaries.
3. The relevant package README and contract tests.
4. `NOTICE` and `licenses/` before changing packaged dependencies.

## Hard rules

### Source-of-truth

- **Markdown is the source of truth for notes.** Never introduce a second source. Vendor widgets must read aggregates or write through *existing* endpoints (e.g. `tickRemoteAction`).
- Sections in a note are canonical and split by exact headings (`## Brief`, `## Human notes`, `## Summary`, `## Research`, `## AI notes`, `## Transcript`, `## Actions`, `## Links`, `## Scratchpad`, `## Debrief`). Editable vs read-only contract is in `packages/local-app/server.py`.
- Re-importing an agenda must not overwrite existing notes — the importer is non-destructive by design.

### Boundaries

- **Writing a module?** See [`docs/MODULE.md`](docs/MODULE.md) — the full authoring contract (frontend `register()` + manifest, optional backend `mcp.py`, enabling via config), grounded in the real `module-2` placeholder and the `aggrid` Grids module.
- The right-edge drawer primitive lives in `packages/core-ui/static/drawer.js`. Up to `MAX_DRAWER_SLOTS = 4` modules per target. Modules (chat and Module 1/2/3 placeholders) plug in via the `modules.config.json` of each target. They never touch `app.js`. Enforced by an automated grep test.
- **tldraw, Bryntum and AG Grid do not ship in default OSS builds or exports.** A separately licensed integration requires explicit authorization and its own verified distribution terms.
- Module names in core are generic ("Module 1", "Module 2"). Vendor-specific names live ONLY inside their own module directories.
- Two surfaces exist: **drawer** (default) and **FAB** (legacy bottom-right; preserved). A module's manifest declares its default surface; `primitive_override` in `modules.config.json` flips it per-module. Chat defaults to drawer slot 1 from phase 2 onward.

### Build & handoff

- Follow [`docs/local-delivery.md`](docs/local-delivery.md). Use `make app-deliver`
  only when installation is authorized. For headless verification use `CONFNOTE_HEADLESS_BUILD=1`; report blocked gates honestly.

- The user runs the **packaged macOS `.app`**, not localhost. After ANY change to `packages/local-app/` (`server.py`, `chat.py`, `desktop.py`), `packages/core-ui/static/`, or `tools/`, rebuild BOTH bundles and verify they boot **before handing back**:
  - `packages/local-app/build-macos.sh` → prod `.app`
  - `packages/local-app/build-macos.sh dev` → dev `.app`
- Verify each: `CONF_NOTES_NOGUI=1 ".../Contents/MacOS/<name>"` must print the URL and serve HTTP 200. Don't skip the rebuild to save churn unless the user says "localhost only this round". State in the handoff that both were rebuilt + verified.
- `packages/local-app/run.sh` (localhost:8787, no rebuild) is the fast verify loop, but the user still needs the rebuilt apps. Stop only the server PID started by your current task; never kill by pattern or port alone.
- After any change to `static/app.js`, `static/style.css`, `static/index.html`, or split/sidebar plumbing, run `make e2e` (one-time `make e2e-install` first) before the rebuild.

### Release flow (never reorder)

1. Automated tests pass (`make lint` + `make e2e` + target-specific gates).
2. **Manual review by user** — UI-alignment, smoke, feel.
3. Release tag.

A failing automated test does not open a manual review gate. Fix first.

### Commit cadence

Once the user has authorised commits, commit at **logical milestones**, not
just at the end of a session:

- Each phase boundary of the task's plan.
- Each new feature or refactor that's independently revertible.
- Before any destructive change (rm, restructure).

For an extended task without commit authorisation, **ask once upfront**:
*"Commit at milestones, or only on the final tag?"* — then proceed. Don't
silently defer for the whole session.

### Secrets

- Nothing in `.claude/` ever ships in a published artifact.
- No API keys, tokens, PATs in committed code. Use env vars; pre-commit scans via `detect-secrets` + `.secrets.baseline`.
- Every web build is secret-scanned before deploy.

### External actions

- Never push to a remote, open a PR, post to Slack/Discord/email, publish anywhere, or initiate vendor outreach without an explicit "yes" from the user.
- Vendor licence confirmations (AG Grid Enterprise, Bryntum) are user-owned; gated on written confirmation before any vendor code lands.
- Deploying to Vercel (even private) is an external action — gate on explicit go.

### Style

- Match the surrounding code's conventions (comment density, naming, idioms).
- No nested ternaries; named constants over magic numbers; delete commented-out code rather than leaving it.
- Python: ruff + ruff-format (see `pyproject.toml`).
- JS/CSS: biome (see `biome.json`). Stylistic rules off / correctness at warn — *don't* "fix" vanilla terse JS by rewriting.

## Repository structure

```
packages/
  core-ui/              ← shared SPA (static/), drawer primitive, modules/
  local-app/            ← Python server + chat + desktop wrapper (the Mac app)
  web-app/              ← Vercel target: API functions + public site pages
  cat-app/              ← confnote as a Local AI Cat app
  catalogue-web/        ← public events catalogue page + MCP
  contracts/            ← language-neutral schemas, fixtures, HTTP conformance suite
  events-model/         ← events v2 schema + types (MIT)
  enrichment/           ← evidence-first catalogue enrichment pipeline
  auth/, billing/       ← identity boundary, Router wallet client
docs/                   ← index in docs/README.md; docs/internal/ is never exported
tools/                  ← product CLIs (import_agenda.py, research.py), starter agenda, demo-video kit
scripts/                ← dev, release and export tooling (lint, deploy, delivery, oss export)
tests/                  ← pytest + tests/e2e/ Playwright
data/                   ← public conference datasets
website/                ← standalone landing page
```

## Process

- **Plan before code on substantive work.** Surface decisions; propose defaults; wait for confirmation.
- **Tag dependencies between tasks explicitly.** If task B depends on A's contract, don't dispatch B until A's contract is locked.
- **Surface honestly when something didn't ship as advertised.** "Tests pass" must mean tests actually pass; "deployed" must mean deployed. No hedging that hides regressions.
- **`guest/` directory removed during phase 1** — planning docs migrated to `docs/planning/` (now `docs/internal/archive/planning/`), OSS clones deleted (~1 GB recovered).

## When in doubt

Default to the conservative choice (don't ship, don't externalise, don't delete) and ask. The user prefers a confirmation prompt over a silent surprise.
