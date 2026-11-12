# Release flow

One page for every way confnote reaches people: the website, the two Mac apps, the
notarized download, the event catalogue and the Local AI Cat. Each step names its
command, the gate it must pass and who runs it. Versions are not chosen here: the
[versioning proposal](#versioning-proposal-pending-musa) waits for musa.

| Surface | Where it lands | Command | Gate before it |
| --- | --- | --- | --- |
| Any change | integration branch | `make release-check` | lint, unit, e2e, web, contracts |
| Web staging | staging.confnote.si (Vercel preview) | `make web-staging` | release-check on the merged tree |
| Web production | confnote.si, www.confnote.si | `make web-production CONFIRM_PRODUCTION=confnote.si` | staging serves the same commit, `make e2e-web` there, musa's go |
| Web, both at once | staging, then production | `make release-both CONFIRM_PRODUCTION=confnote.si` | release-check; a small last-minute fix ([below](#last-minute-fix-make-release-both)) |
| Mac dev + prod, this Mac | `/Applications/confnote dev.app`, `/Applications/confnote.app` | `make app-deliver` | release-check, both bundles smoke-tested |
| Mac public | confnote-downloads.vercel.app, `/download/confnote-mac.dmg` | `make app-release`, then `make app-publish` | musa reviewed the dist app, version agreed, explicit publish go |
| Catalogue | bundled into web, Mac and Cat builds | `CONFNOTE_CATALOGUE_DIR` at build time | a reviewed events-data dist snapshot |
| Local AI Cat | vendored into the Cat repo | the Cat's `scripts/support/sync-confnote-app.sh` | a confnote commit that passed release-check |

The repo-wide rule still holds: automated checks pass, then musa reviews, then a tag.
A failing check never opens the review.

## 1. Every change: `make release-check`

`make release-check` runs `make lint` (ruff, biome, pytest), `make e2e` (Playwright on
the local server), `make test-web` (web build, typecheck, vitest) and `make contracts`
(the shared HTTP contracts against Python, web and the Cat mock). Run it on the merged
integration branch, not only on the feature branch. One-time setup: the
`packages/local-app/.venv`, `npm ci` in each package with a lockfile, and
`make e2e-install`.

## 2. Website

```
feature branch ─merge→ integrate/<name> ─release-check→ make web-staging ─e2e-web + look→ make web-production
```

Both environments are the one Vercel project `atlascodes/confnote-web-app`:

| Environment | Vercel target | Hosts | Env values from |
| --- | --- | --- | --- |
| staging | Preview, aliased by the script | staging.confnote.si | the project's Preview env |
| production | Production | confnote.si, www.confnote.si, confnote-web-app.vercel.app | the project's Production env |

On 2026-11-10 production still serves the public-demo build deployed 2026-11-05
(`confnote-web-9v9j6xm33`); staging serves the signed-in hosted app. The first
production deploy through this flow replaces the demo with whatever the Production env
configures, so set that env first (below).

### `scripts/deploy-web.sh staging|production`

The script deploys the checkout it lives in, at `HEAD`:

1. Refuses a dirty tree (`--allow-dirty` exists for staging only), a missing
   `CONFNOTE_CATALOGUE_DIR` or `CONFNOTE_DEMO_MEDIA_DIR`, and for production: no `--yes-production`,
   a commit on no remote branch (after a fresh `git fetch --prune`), or a commit that
   staging.confnote.si does not serve from a clean tree.
2. `npm ci`, typecheck and vitest in `packages/web-app`.
3. `vercel pull` for the environment (the pulled secrets file is deleted on exit), then
   points this checkout's `.vercel/project.json` at `packages/web-app`. The project's own
   Root Directory stays `.`.
4. `vercel build` (prebuilt: the web app imports `../auth`, `../events-model` and
   `../catalogue-web`, so the build must see the whole repo). Checks that the catalogue and
   every `packages/auth/migrations/*.sql` are inside the function, tldraw and the freshly built
   Bryntum bundle are in (both hosts since 2026-11-13), and the demo media is there.
5. Writes `/release.json` into the output: commit, target, build time, catalogue snapshot
   name, event count and sha256, demo media folder name, tldraw and Bryntum on/off. No paths,
   no secrets.
6. Notes the deployment the host serves now (for rollback), uploads with up to three tries
   (Vercel's upload sometimes fails with a TLS "bad record mac"; the prebuilt output is
   reused; only a zero exit counts), then aliases staging.confnote.si (a production deploy takes its domains itself).
7. Smoke: the host's `/release.json` names this commit, and `/`, `/catalogue/`, `/download`,
   `/demo`, `/media/versions.json`, the vendor module manifests (AG Grid, Bryntum, tldraw) and
   `/llms.txt` (the function)
   answer 200. Prints the
   rollback line and the next step.

`--build-only` stops after step 5 and uploads nothing. Logs go to
`CONFNOTE_DEPLOY_LOG_DIR` (default `.vercel/deploy-logs/`).

Make targets: `make web-staging`, and `make web-production CONFIRM_PRODUCTION=confnote.si`,
which refuses with any other value.

### Build inputs (names only; values never live in the repo)

| Name | Staging | Production | What it is |
| --- | --- | --- | --- |
| `CONFNOTE_CATALOGUE_DIR` | required | required | the reviewed events-data dist snapshot holding `index.json` |
| `CONFNOTE_DEMO_MEDIA_DIR` | required | required | the `/demo` page's recorded video folder (`versions.json` + `v*/`); deploys without it shipped an empty /demo on 2026-11-13 |
| `CONFNOTE_BRYNTUM_LICENSE_KEY` | env, else keychain item `bryntum-trial-license` / `license_key` | same | the Planner's licence; trial mode without it |
| `CONFNOTE_BRYNTUM` | the script sets `1` | the script sets `1` | on both hosts for the PayPal AI Hackathon judging period (musa, 2026-11-13), with a licence note in the module |
| `CONFNOTE_TLDRAW` | the script sets `1` | the script sets `1` | same; no tldraw licence key, so its watermark shows |
| `CONFNOTE_PUBLIC_DEMO` | the script sets `0` | from the Production env | public read-only demo mode |
| `CONFNOTE_DEPLOY_LOG_DIR` | optional | optional | where the step logs go |

### Runtime env (Vercel project env, set per environment by an auth script)

Secrets go in through a script musa runs (skill `auth-script`), never from an agent shell.

- Storage and identity: `CONFNOTE_DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, `CONFNOTE_STORAGE`,
  `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD`, `WORKOS_WEBHOOK_SECRET`.
- Concierge and billing: `CONFNOTE_WEB_AGENT_ENABLED`, `CONFNOTE_WEB_AGENT_PROVIDER`,
  `CONFNOTE_WEB_AGENT_MODEL`, `CONFNOTE_WEB_AGENT_MODE`, `CONFNOTE_ROUTER_URL`,
  `CONFNOTE_ROUTER_SERVICE_TOKEN`, `CONFNOTE_PAYPAL_CLIENT_ID`, `CONFNOTE_PUBLIC_BASE_URL`,
  `AI_GATEWAY_API_KEY`, `LITELLM_BASE_URL`, `LITELLM_API_KEY`, `OPENAI_COMPATIBLE_BASE_URL`,
  `OPENAI_COMPATIBLE_API_KEY`.
- Search and mail: `CONFNOTE_WEB_SEARCH_PROVIDER`, `CONFNOTE_PAID_SEARCH_ENABLED`,
  `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`, `RESEND_API_KEY`,
  `CONFNOTE_EMAIL_MODE`, `SENDER_EMAIL_ADDRESS`, `CONFNOTE_WAITLIST_FROM`.
- Site: `CONFNOTE_PUBLIC_DEMO`, `CONFNOTE_APP_NAME`.

Before the first production deploy, the Production env needs its own values, which are
musa's calls: the production Router (staging uses meow), PayPal live or sandbox, the
production `CONFNOTE_PUBLIC_BASE_URL`, the database, and whether the Bryntum trial key
may be used on production.

### Staging checks, then production

After `make web-staging`:

```sh
WEB_BASE_URL=https://staging.confnote.si make e2e-web
```

then a look at staging (signed out and signed in, light and dark). Production deploys
only the commit staging serves, so a fix found here goes back through staging.

### Last-minute fix: `make release-both`

For a fix that already passed `make release-check` and has to reach both hosts now:

```sh
CONFNOTE_CATALOGUE_DIR=<events-data dist> CONFNOTE_DEMO_MEDIA_DIR=<demo site-media> \
  DEPLOY_BRANCH=<deploy branch on origin> \
  make release-both CONFIRM_PRODUCTION=confnote.si
```

[`scripts/release-both.sh`](../../scripts/release-both.sh) runs the same steps as above, in
order, and stops at the first failure with that host's rollback line:

1. `scripts/deploy-web.sh staging` (its guards and smoke; staging must serve HEAD).
2. Staging passes the host checks (`publicDemo = false`; `/release.json` says tldraw and
   Bryntum on; `/media/versions.json` answers and its latest video answers 206 to a range
   request), and `make e2e-web` passes against it.
3. Pushes HEAD to `origin/$DEPLOY_BRANCH` when it is set (never the integration branch);
   production refuses a commit on no remote branch.
4. `scripts/deploy-web.sh production --yes-production`, whose guards still refuse unless
   staging serves this clean commit.
5. Production passes the same host checks, and `make e2e-web` passes against it.
6. Aliases staging.confnote.si back to the staging deployment and waits until its
   `/release.json` says `"target": "staging"`. staging.confnote.si is a production domain of the
   Vercel project, so every production deploy takes it; as a branch domain (`gitBranch`) it would
   sit behind Vercel's preview protection instead (tried 2026-11-13: it answered 302 to Vercel SSO).
   Staging serves the Preview env (staging Router, database, PayPal sandbox); production the
   Production env.

It ends by printing both rollback lines. The deploy output is kept in
`$CONFNOTE_DEPLOY_LOG_DIR/release-both-{staging,production}-<commit>.txt`. It replaces the
look at staging before production, so it is for small fixes; anything larger goes through
the steps one by one.

### Rollback

The script prints the exact line before it exits (or, when `vercel inspect` found no
previous deployment, says so and how to list them):

- staging: `vercel alias set <previous deployment host> staging.confnote.si --scope atlascodes`
- production: `vercel rollback <previous deployment host> --scope atlascodes`

Vercel keeps every deployment, so any earlier one can be aliased or rolled back to.
Database migrations only add; a rollback does not undo them.

## 3. Mac app

Three channels from one build script, `packages/local-app/build-macos.sh`:

| Channel | Bundle | Bundle id | Signing | Who gets it |
| --- | --- | --- | --- | --- |
| dev | `confnote dev.app` (amber) | `com.atlas.confnote.dev.<tag>` | Developer ID, no timestamp | this Mac |
| prod | `confnote.app` (green) | `com.atlas.confnote` | Developer ID, no timestamp | this Mac |
| public | `confnote.app` inside a DMG | `com.atlas.confnote` | Developer ID, timestamped, notarized, stapled | anyone, by download |

### Local: `make app-deliver`

[`scripts/local-delivery.sh`](../../scripts/local-delivery.sh): lint, e2e, web checks,
builds both channels into `packages/local-app/dist/` with `NO_INSTALL=1`, runs `make app-smoke`
on both, then replaces the installed apps one at a time and smoke-tests them
again. `make app-smoke` runs the headless bundle smoke on its own (codesign, Info.plist,
first launch, Playwright on the bundle's server; no window, no install) against the dist
bundles. `make app-dev-then-prod` stops after dev for a manual look. Details:
[local delivery](../local-delivery.md). Agents build into `dist/` with `NO_INSTALL=1`;
the seat runs `make app-deliver`.

### Public: `make app-release`, `make app-publish`

1. `make release-check` and `make app-smoke` green, and musa has used the dist build.
2. The version is agreed (today every bundle says `0.0.0`, PyInstaller's default).
3. `make app-publish-dry-run` packages the existing dist app as a DMG and prints the
   `latest.json` and downloads-site config it would deploy.
4. `make app-publish` (only on musa's explicit go): notarized build, DMG signed,
   notarized and stapled, Gatekeeper must say "Notarized Developer ID", copied into the
   downloads site with `latest.json`, deployed to `confnote-downloads`, then downloaded
   from the stable URL with quarantine set and checked (sha256 + Gatekeeper).
   Notary credentials: `ASC_KEY_PATH`, `ASC_KEY_ID`, `ASC_ISSUER_ID` from the environment
   or `~/.config/confnote/release.env` (paths and ids only).

Published so far: `confnote-0.0.0-8c30146.dmg` on 2026-11-05 (arm64, macOS 27.0+).

### How an installed app gets updates today

It doesn't. Nothing in the app checks for a newer build; a user downloads the DMG again.
The downloads site already publishes `latest.json` (version, commit, sha256, size,
minimum macOS, architectures; CORS open, no-cache), which is what an update check would read.

### Update mechanism proposal (pending musa)

| | A. "Update available" notice | B. Sparkle 2 |
| --- | --- | --- |
| What | On launch (at most daily), the app reads `latest.json` and, when it is newer, shows a link to the download page | The Cat's mechanism: an EdDSA-signed appcast, download, verify, replace, relaunch |
| Work | Small: one request in `server.py`, one banner in core-ui, a Settings toggle | Larger: Sparkle.framework inside a PyInstaller bundle driven through PyObjC, an appcast generator in `publish_mac.py`, an EdDSA key through an auth script |
| Needs first | Real versions (commits alone can't order releases) | Same, plus key custody |
| Risk | One outbound request from a local-first app: needs a Settings switch and a line in the privacy copy | Self-replacing app: signing and key handling must be right |

Recommendation: A once a version is agreed, then B before a wider public launch. Neither
is built in this round: A adds an outbound call musa has not approved, and B is not small.

## 4. Catalogue

The event catalogue is data, not code. A reviewed events-data dist snapshot (a dated
folder holding `index.json`, `ATTRIBUTION.md` and the source licences) is named with
`CONFNOTE_CATALOGUE_DIR` when building:

- web: `build-static.mjs` bundles `index.json` into the function and copies the notices;
  `/release.json` records the snapshot name, event count and sha256;
- Mac: `build-macos.sh` copies it into the bundle's `static/catalogue/`;
- Cat: `packages/cat-app/build.mjs` embeds it; the Cat may later refresh it by writing
  `catalogue/index.json` into ConfNote's project folder (not built in the Cat yet).

A new snapshot ships with the next build of each surface. Proposal: the snapshot folder's
date is the catalogue's version (`2026-11-09`, `2026-11-09.2` for a second one that day);
`schema_version` (`events.catalogue.v2`) stays separate.

## 5. Local AI Cat

### Today (read from the Cat repo on 2026-11-10, Cat `origin/main` 9ddb690f8)

- ConfNote is one of three built-in apps (`review`, `scrapbook`, `confnote`), compiled into
  CatShell's resources at `Packages/CatShell/Sources/CatShell/Resources/apps/confnote/`.
- It gets there by hand: someone in the Cat repo runs
  `scripts/support/sync-confnote-app.sh <confnote checkout>` (npm ci, tests, `build.mjs --out`),
  runs `swift test --filter CatAppConfNoteTests`, and commits the folder.
- The vendored copy is confnote `1e80e45` (re-vendored 2026-10-23), 220+ commits behind the
  current integration branch. Its `confnote-build.json` records the commit; tests check the
  provenance shape, CSP and capabilities, not the bytes.
- The Cat itself updates through Sparkle (direct download, stable/beta/alpha on one feed)
  and the App Store. ConfNote reaches users only inside a Cat release.
- The Cat already loads user-installed apps from `~/Library/Application Support/Local AI Chat/Cat Apps/`
  (macOS, `FEATURE_CAT_APPS`), but refuses reserved ids, `confnote` among them. There is no
  download, signature check, version comparison or update UI for apps. Package 281
  ("Cat apps on nirvana", proposed) plans a versioned app library and leaves install-from-URL out of scope.
- The Cat once hand-edited its copy of `cat-app.json` (`theme.chrome`); confnote's own manifest
  now carries it, so a re-vendor no longer drops it.

### Options

| | 1. Bundled with each Cat release (today) | 2. Fetched module |
| --- | --- | --- |
| How | Re-vendor confnote into the Cat repo; ships with the next Cat build | The Cat downloads a signed confnote bundle into its apps library and loads it over the built-in copy when newer |
| Cadence | Cat's | confnote's own |
| Cat work | None beyond running the sync | Allow `confnote` to override the built-in, version compare, signature/hash check, data-folder binding, update UI, host-side fetch (the page has `connect-src 'none'`) |
| Compatibility | Tested together by construction | Needs a bridge/capability version in the manifest and a minimum Cat version |
| App Store | Fine | Downloaded code that changes an app's features is an App Review risk (4.7 / 2.5.2); App Store builds would stay bundled anyway |

Recommendation: stay bundled, and make it routine. confnote's release produces the Cat
build as an artifact (`node packages/cat-app/build.mjs --out <dir>`, with
`confnote-build.json` naming the commit), and the Cat's release checklist re-vendors the
newest confnote that passed release-check. Revisit option 2 when package 281's app library
lands, for direct-download Cat builds only. Catalogue refresh is a separate, smaller job:
the Cat host fetches `index.json` and writes it into ConfNote's project folder; the page
never gets network access.

## Versioning proposal (pending musa)

Nothing below is applied. Per the STRICT rule, musa agrees the exact versions first.

What exists:

- Tags `local-v0.1.0` (2026-05-20) and `local-v0.2.0` (2026-05-30) on the Mac app line.
- `package.json` `0.1.0` in web-app, cat-app, auth, billing and catalogue-web (never bumped,
  private packages); `events-model` `2.0.0` (the schema package); the Cat manifest `0.1.0`.
- Mac bundles carry no version, so `CFBundleShortVersionString` is PyInstaller's `0.0.0`,
  and the public DMG shipped as `0.0.0`.
- The web app has no visible version; `/release.json` now records the commit.

Proposal:

1. **One product version for confnote** across web, Mac and the Cat app, since they ship
   the same core-ui. One `VERSION` file at the root, read by `build-macos.sh`
   (`CFBundleShortVersionString`), the web build (`/release.json`) and the Cat build
   (`cat-app.json`, `confnote-build.json`).
2. **Format:** three-part `MAJOR.MINOR.PATCH`, because Apple bundle versions and npm need
   it, and because confnote already has `local-v0.1.0` and `local-v0.2.0` (the `0.01`
   default is for new projects; existing history stays). Tags `v<version>`; the
   `local-v*` tags stay as they are.
3. **Starting version:** `0.3.0` for the next release that reaches confnote.si or the
   download page, continuing after `local-v0.2.0`.
4. **Bump rules:** patch for fixes only; minor for a release with user-visible features;
   `1.0.0` for the public open-source launch. Staging deploys and local dev/prod builds do
   not bump; they are identified by commit.
5. **Build counter:** Mac `CFBundleVersion` = `git rev-list --count HEAD` on the release
   commit, set by the build automatically; separate from the product version.
6. **Catalogue:** dated snapshot names (section 4); `events.catalogue.v2` and other
   schema/protocol versions stay separate and never bump the product version.
7. **Approval scope to ask for:** once musa agrees 1–6, agents may apply patch bumps for
   fix-only releases; minor and major bumps still ask.
