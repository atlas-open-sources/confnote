# OSS release readiness

Updated 2026-11-10. This is a preparation report, not a publication approval
or evidence that a downloadable release exists. The hackathon-specific export
plan is [docs/hackathon/oss-export-checklist.md](hackathon/oss-export-checklist.md);
the build and deploy steps are in the [release flow](release/README.md).

## Publication blockers

| Gate | Current evidence (2026-11-10) | Required before public release |
| --- | --- | --- |
| Project license | `LICENSE` is AGPL-3.0-only, `packages/events-model` is MIT, event data CC-BY-4.0. The owner has not confirmed AGPL over MIT (see the checklist's licence slot). | Owner confirms the licence. `NOTICE` still says AG Grid is excluded from the export, but `oss_export.py` now ships AG Grid Community (MIT) and our Bryntum module's own code: the owner updates `NOTICE` to match. |
| Third-party redistribution | The export drops the tldraw module; Bryntum's bundle is built locally from its npm trial package (`make bryntum`) and no longer committed. Vendor MIT notices are in `licenses/vendor/`. | Recover the exact Deep Chat version and finish the transitive bundled-notice audit (`licenses/VENDOR-NOTICES.md`). |
| Private material and secrets | Tracked tree: `detect-secrets` against `.secrets.baseline` finds nothing new. Full history: `gitleaks` finds 15 `generic-api-key` hits, none a credential (baseline hashes, minified Deep Chat and Bryntum bundles, a test fixture). History does contain Bryntum's trial bundle (added 037ff03, removed 6e39b73). No home-directory paths or personal email addresses in tracked files. | Publish a **clean export** (fresh history), never this repository's history. Rerun both scanners on the export folder. Decide whether kept files may name the owner and team: `musa` appears in `docs/release/README.md`, `scripts/publish_mac.py`, `tests/e2e/test_mac_bundle.py`, `tools/demo-video/README.md` and an enrichment test comment; `atlascodes` names the Vercel team in `scripts/deploy-web.sh`, `scripts/publish_mac.py`, `packages/cat-app/` and the release docs. |
| Export contents | `python3 scripts/oss_export.py --dry-run` at c3b29fc: 395 files kept, 40 dropped (24 docs under `docs/internal/` and two private data files, 13 tldraw module files, 1 env file). | Read every kept Markdown file once; `docs/hackathon/` and `docs/release/` ship as they stand. |
| OAuth acceptance | Provider integration prepared separately | Record real sign-in, generation, refresh/relaunch and sign-out in the signed packaged app; confirm current OpenAI eligibility. |
| Clean first launch | Default vault is user-owned Markdown; the DevDay starter agenda ships in the bundle | Verify on a fresh empty vault, preserve existing notes, confirm day-goal onboarding. |
| macOS release | `build-macos.sh` signs with Developer ID; notarization is opt-in (`make app-release`); `make app-smoke` checks the dist bundles | Test both bundles, notarize and staple the approved artifact, record version, architecture, minimum OS, checksum and a clean-Mac Gatekeeper result. The version is not chosen yet (it needs the owner). |
| Review and publishing | Repo rules require tests, the owner's manual review, then a tag | Manual review and explicit release and publication consent before tagging or uploading. |

## Website and domain evidence

The Git remote is the private `atlascodesai/conferences`. The hosted app is set
up for `confnote.si` (production) and `staging.confnote.si` (staging) in the
[release flow](release/README.md); `packages/web-app/vercel.json` redirects
`/download/confnote-mac.dmg` to the downloads project. Nothing has been
published to production by this preparation.

`website/` is a separate standalone landing page with no analytics, external
fonts, signup collection or download link; the hosted site's own pages
(`/download`, `/demo`, `/terms`) live in `packages/web-app/site/`.

## Release procedure

1. Finish the licence, notice and source-data review above. Publish from a
   clean export; do not rewrite or publish this repository's history.
2. Run `make release-check` (lint, e2e, web, contracts) and save the results
   with the exact revision; record packaged OAuth acceptance separately.
3. Build with `NO_INSTALL=1` to avoid replacing installed apps. Use the
   approved signing identity; notarize only after release authorization.
4. Complete the owner's manual review before creating a release tag.
5. Produce a named archive with a SHA-256 checksum and tested install steps.
6. After explicit publication approval, upload the approved source and binary
   and point the download page at that exact artifact with its version,
   architecture, minimum OS and checksum.
7. Verify the public page, download integrity and installation on another Mac.

No domain registration, deployment, GitHub visibility change or release upload
was performed by this work.
