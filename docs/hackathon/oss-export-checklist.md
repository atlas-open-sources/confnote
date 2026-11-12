# Clean public export for the hackathon entry: checklist (draft)

Prepared 2026-11-09 at `integrate/hackathon-20261109` 2f9c369; refreshed 2026-11-10 at `chore/tidy-20261110` c3b29fc
(scans rerun, internal docs moved under `docs/internal/`). Nothing has been published, no repository visibility has
changed, and no licence has been chosen. Every box below is for the owner to decide or run.

## Recommendation in one line

Publish a **clean export** (`scripts/oss_export.py`, fresh history) into a **new** public repository. Do not flip
`atlascodesai/conferences` to public: its history carries internal planning, a non-redistributable Bryntum bundle
and a personal address in a test (details below).

## Where things stand

| Item | State |
|---|---|
| Repository | `atlascodesai/conferences`, private. 228 commits across all refs (226 on this branch, first 2026-05-20). Commit author emails are `confnote.local` and GitHub `noreply` addresses only. |
| Licence files | `LICENSE` is AGPL-3.0-only and `NOTICE` describes it (added by the 2026-11-01 platform run). `packages/events-model` is MIT; event data is CC-BY-4.0. **The application licence is still the owner's choice** (see Licence below). |
| Export tool | `scripts/oss_export.py --dry-run` at c3b29fc (2026-11-10): **395 files kept, 40 dropped**, no publication. Drops: 26 internal (everything under `docs/internal/` plus the conference's `speakers.json` and `llms.md`), 9 tldraw module files, 4 private or generated paths (tldraw's island build), 1 env file. Bryntum's bundle is no
longer committed (`make bryntum` builds it), so there is nothing of Bryntum's to drop. Our own Bryntum module code and AG Grid Community now ship. |
| Router | `mochi-records/mochirouter`, private, `LICENSE` reads "License to be finalized before public release". |

## 1. Secret scan

Run on 2026-11-09 with values redacted, rerun 2026-11-10 with the same result (gitleaks: the same 15 history findings;
detect-secrets with the baseline over every tracked file: nothing new). Reports are kept outside the repo in the
session scratch.

**gitleaks, full history** (`gitleaks git --redact=100`, 199 commits, 27.7 MB): 15 findings, all rule
`generic-api-key`, none a real secret.

| File | Findings | Verdict |
|---|---|---|
| `.secrets.baseline` | 5 | detect-secrets' own baseline: SHA-1 hashes of already-reviewed test strings, not secrets. |
| `packages/core-ui/static/modules/bryntum/vendor/bryntum-island.bundle.js` | 5 | Minified vendor code (Bryntum). Dropped by the export anyway. |
| `packages/core-ui/static/vendor/deep-chat.bundle.js` | 2 | Minified vendor code (Deep Chat). |
| `packages/web-app/core-ui-static/vendor/deep-chat.bundle.js` (history only) | 2 | Same vendor bundle at an older path. |
| `tests/test_vault_transfer.py` | 1 | A test fixture: the `changed_notes` list of sample note filenames, not a credential. |

**gitleaks, working tree** (`gitleaks dir`): 54 findings, the same types. Beyond the tracked files above they are in
git-ignored output only: `packages/web-app/.data/waitlist-*/` (local test runs of the waitlist, 13 folders) and
`packages/web-app/public/` (a build copy of the vendor bundles). Neither is tracked or exported.

**detect-secrets 1.5.0, tracked files** (vendor folders excluded as in the pre-commit hook), compared with
`.secrets.baseline`: the six `Secret Keyword` hits in `tests/test_settings.py` are already in the baseline; the only
new hits are the baseline's own hashes (`Hex High Entropy String`, `Secret Keyword`) and four `Base64 High Entropy
String` hits in the tldraw vendor bundle, which the export drops. No new secret.

**Other checks on tracked files**

- No absolute home-directory paths.
- Email addresses: test fixtures (`example.com`, `example.test`, `example.invalid`) and public vendor and conference
  addresses. The personal address that sat in `tests/test_sections.py` on 2026-11-09 is gone from the tree (it stays
  in history since 5e7bff7, one more reason to export with fresh history).
- `docs/internal/strategy/monetisation.md` names a local folder path and `packages/local-app/server.py` mentions
  Tailscale in a comment. The first is dropped by the export; the second is harmless.
- Names: `musa` appears in kept files (`docs/release/README.md`, `scripts/publish_mac.py`,
  `tests/e2e/test_mac_bundle.py`, `tools/demo-video/README.md`, an enrichment test comment) and `atlascodes` names
  the Vercel team in the deploy scripts and the Cat app. Owner's call whether to neutralise them in the export.

**Before publishing, run again** on the export folder itself (not this repo): `gitleaks dir <export>` and
`detect-secrets scan` over it, plus a manual read of every kept Markdown file.

## 2. What must stay out

Already excluded by `oss_export.py`:

- Directories: `.git`, `.claude`, `.codex`, `.agents`, `.vercel`, `.repos`, `.venv`, `node_modules`, caches, `dist`,
  `build`, `artifacts`, `reports`, `reviews`, `feedback`, `personal`, `personal-notes`, `notes`, `vaults`.
- Internal docs: everything under `docs/internal/` (backlog, done, strategy, research, the archived plans and
  feedback), plus the conference's `speakers.json` and `llms.md`.
- Any path with `mochirouter`, `feedback-` or `personal-` in it.
- `.env*`, `auth.json`, `credentials*`, SSH keys, `*.pem`, `*.key`, `*.p12`, `*.pfx`.
- tldraw and Bryntum (every file, including our own module code and tests), and anything AG Grid outside the
  reviewed allowlist.

Still to decide or fix before exporting:

- [x] `tests/test_sections.py`: the personal address is gone from the tree (checked 2026-11-10).
- [ ] `NOTICE` says AG Grid and Bryntum are excluded from the export; the export now ships AG Grid Community and our
  Bryntum module code. Update `NOTICE` to match the export the owner approves.
- [ ] **Bryntum module code** (2026-11-10: the export now keeps our module files; Bryntum's own bundle is built at
  install time and never committed. Confirm this is the wanted shape). The export drops our own `bryntum.js`, `bryntum.css`, `manifest.json`, `README.md`,
  `build/esbuild.mjs`, `build/src/*`, `build/write-license.mjs`, `license.local.js.example` and both Bryntum tests,
  not only Bryntum's vendor bundle. For the Bryntum prize, judges will want to read our module. Option: an allowlist
  like the Grids one that ships our files and still drops `vendor/` (Bryntum's bundle and Font Awesome), with a README
  line on building it from Bryntum's own npm registry with a trial key. Without the bundle the module cannot run from
  the public repo; the hosted build and the video show it.
- [ ] `docs/hackathon/oss-export-checklist.md` (this file) ships unless added to `INTERNAL_FILES`. It holds no secret,
  but it is internal process.
- [ ] `docs/oss-release-readiness.md`, `CLAUDE.md`, `AGENTS.md` and `.github/copilot-instructions.md` ship. Read them
  once; they are agent instructions for this repo and name only `~/Documents/confnote/`-style app defaults.
- [ ] `packages/web-app/.env.example` is dropped by the env rule, but the web-app README lists every variable, so a
  reader can still configure it. Keep or ship a sanitized copy.
- [ ] Demo media (`artifacts/2026-11-09/demo-video/`) lives outside the repo. Link the uploaded video from the README
  rather than committing it.

## 3. Licence slot (the owner chooses; nothing is chosen here)

Both satisfy an "open-source licence on a public repo" rule. AG Grid Community (MIT) and the MIT `events-model` work
under either. Bryntum and tldraw stay outside the export under either.

- **MIT.** Anyone may use, change, host and sell confnote, including as a closed hosted service, as long as they keep
  the copyright notice. It is the easiest licence for judges, sponsors and other developers to adopt and to reuse in
  their own code. It gives no protection against a competitor running a modified confnote as a paid service without
  sharing changes. Moving from the current AGPL files means replacing `LICENSE`, `NOTICE` and the SPDX notes.
- **AGPL-3.0-only** (what `LICENSE` says today). Anyone may use and change confnote, but whoever runs a modified version
  as a network service must offer its users the complete source of that version under AGPL. This keeps hosted forks
  open and protects confnote's own hosted, paid service from closed clones. Some companies refuse AGPL code, so
  outside reuse and contributions will be lower. As the copyright holder we are not bound by it for our own hosted
  build, but outside contributions would be AGPL too unless contributors sign a licence agreement.

## 4. What the public README needs

- What confnote is, in two sentences, and the hackathon section (`docs/hackathon/README-section.md`).
- The demo video link and the hosted URL (`STAGING_URL` until it exists).
- Quick start for the local app and the web app, with environment variable names and no values.
- The architecture diagram and the fact that metering and PayPal run in Mochi Router, a separate service (see 5).
- Sponsor modules: where the AG Grid module lives; that the Bryntum module needs Bryntum's own package and a licence
  key, and how to build it.
- Licence (whichever is chosen), `NOTICE`, the vendor notices and the event-data attribution.
- Test commands (`make lint`, `make test`, `make test-web`, `make e2e`) and the PayPal sandbox note: no live payments.

## 5. Does the Router have to be public?

What the rules require: public listings of this hackathon say the project's code must be in a **public repository
with an open-source licence**, plus a demo video under three minutes and a working demo. These are third-party
summaries, not the official text. **Read the official Devpost rules before deciding.**

What lives where:

- confnote (this repo) holds the UI, the PayPal JS SDK v6 buttons and Card Fields in the browser, the checkout,
  capture and auto top-up proxies, the Concierge, and both sponsor modules.
- The Router holds the server side of the PayPal integration: Orders v2 create and capture, Card Fields
  `payment_source.card`, vaulting, merchant-initiated vault charges, webhook normalization and reconcile, plus the
  wallet, the 402 and the gateway. Its licence is not chosen ("to be finalized").

Minimum, by reading:

- **If the rules accept a hosted dependency** (a closed API the project calls), the confnote export alone is the
  minimum. The weakness: most of the PayPal code judges would look at is not in it.
- **If the rules want the judged work public** (the safer reading, since PayPal is the judged integration), the
  minimum is the confnote export **plus a public, licensed extract of the Router's payment path**: the PayPal adapter
  and orders/normalization code, the checkout routes, the wallet reserve/settle/auto top-up services and
  `docs/platform/wallet-api.md`. The rest of the Router (other products, infra, deploy) stays private. That extract
  needs its own secret scan and licence choice; it does not have to build on its own if the README says so.
- Publishing the whole Router is not required by either reading and is a larger review (other products' code, infra
  and history).
