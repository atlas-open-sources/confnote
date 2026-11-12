# confnote

A local-first conference companion: plan your day, take notes beside the
agenda, and turn conversations into follow-up actions. Your notes remain
Markdown files you own.

The macOS app, the hosted web app and the Local AI Cat app share one interface
(`packages/core-ui`). The Mac app runs a Python server inside a native window;
the hosted target runs on Vercel. The Concierge agent depends on the target and
the provider you pick.

## PayPal AI Hackathon entry

- **Try it:** https://confnote.si (sign up for USD 2 of trial credit; payments use the PayPal sandbox, test cards only).
- **Demo video and history:** https://confnote.si/demo
- **What it does:** an AI Concierge (Claude) for conferences. Every agent step is metered by a wallet and paid for
  with PayPal: a trial, an HTTP 402 when credit runs out, credit packs through PayPal Orders v2 (JS SDK v6 buttons),
  a card saved with PayPal Card Fields, and automatic top-up on the vaulted card within a monthly cap. AG Grid and
  AG Charts (Community) show the events catalogue, actions and the transaction Ledger; Bryntum shows the day room by
  room; tldraw draws the mind map.
- **Where the code is:** this repository is the whole confnote app: the web app and its PayPal checkout UI
  (`packages/web-app`, `packages/core-ui`), the Concierge and its shared tools (`packages/contracts`), the Mac app
  (`packages/local-app`), and the AG Grid, Bryntum and tldraw modules (`packages/core-ui/static/modules/`).
  Payments, prices, PayPal orders, captures, vaulting and the ledger are handled server-side by **Mochi Router**, our
  AI gateway, which confnote calls over HTTP (`ROUTER_URL`, default `https://api.mochirouter.com`). The Router is a
  separate hosted service and is not part of this repository; confnote never sees a card number, a vault token or a
  price it could tamper with.
- **How PayPal is used (sandbox):**
  - **Orders v2:** creates and captures the order for each credit pack; the gateway owns price and order.
  - **JS SDK v6 buttons:** one-click checkout when the Concierge runs out of credit (HTTP 402).
  - **Card Fields:** saves a card in the page with no PayPal login, vaulted on the first purchase (`store_in_vault: ON_SUCCESS`).
  - **Vault payment tokens:** automatic, merchant-initiated top-up when a step needs more credit, within the user's monthly cap.
  - **Webhooks:** `PAYMENT.CAPTURE.COMPLETED` is deduplicated and reconciled into the wallet ledger.
- **How AI is used:** the Concierge is Claude (Anthropic). The Mac app runs it on the Claude Agent SDK; the web app runs
  Claude in a Vercel AI SDK tool loop through Mochi Router, with an Agent SDK engine behind a flag. Both share the same
  27 tools (`packages/contracts/tools.json`, with a parity test): import a conference from a link, read and write notes,
  research speakers, pick sessions, draw a mind map. Every step is metered per step: reserve before, settle on real usage.
- **Sponsor and other tools:** AG Grid Community and AG Charts Community (events catalogue, actions, Ledger and balance
  chart), Bryntum Calendar/Scheduler (the day room by room, picks and clashes), tldraw (mind map), WorkOS (sign-in),
  Vercel (hosting), Neon Postgres, Vercel Blob.
- **Run it yourself:** see [Run it](#run-it) below and `docs/release/README.md`. Without a Router, the web app runs
  with your own AI key (bring your own key) and the paid features are off.

**Public release preparation is in progress.** No public download is advertised
yet. See [OSS release readiness](docs/oss-release-readiness.md) for the
remaining gates and the [release flow](docs/release/README.md) for how builds
reach staging and production.

## Repository map

| Path | What it is |
|---|---|
| [`packages/core-ui`](packages/core-ui/static) | The shared single-page app: agenda, editor, drawer and its modules, design system |
| [`packages/local-app`](packages/local-app/README.md) | Python server, Concierge and native window: the macOS app |
| [`packages/web-app`](packages/web-app/README.md) | Vercel functions and the public site pages (`/demo`, `/download`, `/terms`) |
| [`packages/cat-app`](packages/cat-app/README.md) | confnote as a [Local AI Cat](https://localaicat.com) app |
| [`packages/catalogue-web`](packages/catalogue-web) | The public events catalogue page and its MCP endpoint |
| [`packages/contracts`](packages/contracts/README.md) | Schemas, fixtures and the HTTP conformance suite every target passes |
| [`packages/events-model`](packages/events-model/README.md) | Events v2 schema and types (MIT) |
| [`packages/enrichment`](packages/enrichment/README.md) | Evidence-first pipeline that builds the events catalogue |
| [`packages/auth`](packages/auth/README.md), [`packages/billing`](packages/billing/README.md) | Identity boundary; wallet client for metered AI |
| [`tools`](tools) | Product CLIs (`import_agenda.py`, `research.py`), the starter agenda, the demo-video kit |
| [`scripts`](scripts) | Lint, delivery, deploy and clean-export tooling |
| [`tests`](tests) | pytest units and Playwright e2e (`tests/e2e`) |
| [`data`](data) | Public conference datasets |
| [`website`](website/README.md) | Standalone landing page |
| [`docs`](docs/README.md) | Every document, indexed |

## Run it

The Mac app, from source:

```sh
packages/local-app/run.sh            # server + browser at http://localhost:8787
packages/local-app/run.sh desktop    # native window (pywebview)
python3 packages/local-app/server.py # core only, no Concierge
```

Packaged builds and delivery (see the [local delivery runbook](docs/local-delivery.md)):

```sh
packages/local-app/build-macos.sh [dev]   # prod or dev .app into packages/local-app/dist/
make app-deliver                          # checks → builds → smoke → installs both channels
```

The web app (see [web target setup](packages/web-app/README.md)):

```sh
npm --prefix packages/web-app install
npm --prefix packages/web-app run dev:local    # local server on the demo storage
npm --prefix packages/web-app run dev:vercel   # vercel dev
```

The Cat app: `npm --prefix packages/cat-app run check` builds `dist/confnote/`
([cat app](packages/cat-app/README.md)). The catalogue pipeline: see
[enrichment](packages/enrichment/README.md).

## Test it

```sh
make lint        # ruff, biome, pytest
make e2e         # Playwright (one-time: make e2e-install)
make test-web    # web build, typecheck, vitest
make contracts   # the same HTTP contract against Python, web and the Cat
make help        # every target
```

## Notes on disk

The default vault is `~/Documents/confnote/` (switchable in Settings → Notes
folder). Each conference is a folder named `<YYYY-MM-DD>-<slug>/`, so `ls` is
chronological:

```
~/Documents/confnote/
└── 2026-05-19-beyond-the-prompt/
    ├── README.md                 # overview + formatted agenda
    ├── speakers.md               # speaker bios
    ├── agenda.json               # imported source
    └── notes/
        ├── 0940-opening-keynote.md
        └── …                     # one file per session, HHMM-prefixed
```

One Markdown file per session with frontmatter (session, speakers, time, room,
tags) and fixed `##` sections:

- **Brief / Debrief**: yours, bracketing the editor. Action items
  (`- [ ] task`) tick off inline; a per-conference modal gathers every open one.
- **Human notes**: what you write live.
- **Summary**, **Research**, **AI notes**: written by the Concierge, read-only
  in the app.
- **Transcript**: paste, drop an audio file, or record in the app.
- **Links** / **Scratchpad**: yours.

Only those exact headings delimit sections, so `##` headings inside your notes
are safe, and the app rewrites only the editable sections so you and an agent
can write the same file at once. Re-importing never overwrites a note.

## Add a conference

Conferences are created from the versioned
[`confnote.agenda.v1`](docs/schema/confnote-agenda-v1.md) manifest. The app's
New conference form, the Concierge, pasted JSON and the CLI all produce it:

```sh
python3 tools/import_agenda.py /path/to/agenda.json   # stdlib only
```

## Licence

Application code is AGPL-3.0-only ([`LICENSE`](LICENSE)); `packages/events-model`
is MIT; published event data is CC-BY-4.0. See [`NOTICE`](NOTICE) and
[`licenses/`](licenses) for third-party notices. The clean export
(`scripts/oss_export.py`) ships AG Grid Community under its MIT notice and our
Bryntum module's own code without Bryntum's bundle (you build it from Bryntum's
npm trial package with `make bryntum`); it leaves the tldraw module out.

## Sponsor modules in this export

This tree is a clean export of the confnote source (`OSS-EXPORT-MANIFEST.json` lists every file).

- **Grids (AG Grid, Module 1)** ships whole and is on by default: our module in
  `packages/core-ui/static/modules/aggrid/` and the unmodified AG Grid Community bundle (MIT) in its `vendor/`
  folder. `vendor/README.md` names the npm package version (`ag-grid-community`) and its hashes.
- **Planner (Bryntum, Module 2)** is on by default: our module ships in `packages/core-ui/static/modules/bryntum/`
  (`bryntum.js`, `bryntum.css`, the `build/` scripts) with its tests. Bryntum's own bundle is commercial, so it is not
  in this export: `make bryntum` builds it from Bryntum's public trial package (`@bryntum/calendar-trial` on npmjs, no
  login). It runs `npm ci --ignore-scripts` from the committed lockfile (exact version and integrity hash, no install
  scripts) in `packages/core-ui/static/modules/bryntum/build`, then `npm run build` there, which writes `vendor/`.
  The web build (`packages/web-app`, `npm run build`) does the same on its own.
  Without a licence key Bryntum runs in trial mode with a watermark. A key goes only in the gitignored
  `license.local.js` (see `license.local.js.example` and `build/write-license.mjs`), never in git.
- The Sketch module (tldraw) is not part of this export.
