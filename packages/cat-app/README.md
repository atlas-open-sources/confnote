# confnote cat app

ConfNote as a [Local AI Cat](https://localaicat.com) app: the same interface as the macOS app
and the web target, running inside the Cat's main window. The Cat vendors the built folder
as a built-in app (`Packages/CatShell/Sources/CatShell/Resources/apps/confnote/` in the Cat
repo).

```bash
npm --prefix packages/cat-app install
npm --prefix packages/cat-app run check          # tests, then build to dist/confnote/
node packages/cat-app/build.mjs --out <dir>      # build somewhere else
```

## What the build changes

`packages/core-ui/static` is copied as it is. Only what the Cat's sandbox forces changes:

- **Inline scripts** in `index.html` move into `inline-N.js` files, in order (the page's
  CSP allows `script-src 'self'` only).
- **Root paths** (`/style.css`) become relative: the app lives under
  `/v1/local/apps/confnote/assets/`.
- **`cat-boot.js`** runs first: the page has an opaque origin, where `localStorage` throws,
  so it gets an in-memory stand-in; it also sets `window.confnote.webMode` / `catMode`.
- **`transport.js`** answers `fetch("/api/…")` in the page (there is no server and no
  network): `src/router.ts` runs the web app's own `lib/service.ts`, bundled by esbuild,
  over `src/cat-storage.ts`, a `StorageAdapter` on the Cat bridge (`file.read`,
  `file.write`, `file.list` inside ConfNote's folder grant). The grant is laid out like a
  vault: `<YYYY-MM-DD-slug>/agenda.json`, `<slug>/notes/HHMM-*.md`.
- **Left out:** the Concierge chat bundle and drawer modules, the macOS icons.
- **`../theme.css`** is linked last. The Cat serves it empty for ConfNote's original look,
  or its own theme tokens followed by `cat-theme.css` when ConfNote's settings in the Cat say
  "Cat theme".

`cat-app.json` is the Cat manifest; `confnote-build.json` records the source commit.

## Not in the Cat yet

The Concierge and agent sections, transcription and recording, attachments
(`/api/asset`), the vault switcher. Their routes answer 501 or a fixed payload, like the
web target's disabled features.

## Local Upcoming catalogue

The shared **Upcoming** button reads `events.catalogue.v2` without an account or
network fetch. Build with `CONFNOTE_CATALOGUE_DIR=/path/to/events-data/dist` to
embed that published index. The Cat can refresh it by copying the same `index.json`
into `catalogue/index.json` inside the app's granted project folder; that file
wins over the build snapshot. No change to the Cat repository is included here.
The host needs its existing `file.read` and `file.list` grant operations. If a
future Cat integration calls the Python server instead of this bridge, every
mutation must send `Origin: http://127.0.0.1:<actual-port>` matching its Host.

Snapshot builds include the source index's modification date for the Upcoming
age label. A host-refreshed grant index should include `catalogue_updated_at`.
Cat's current CSP has no network capability, so the host must own any future URL
refresh and ETag cache; opening Upcoming never expands that permission.
