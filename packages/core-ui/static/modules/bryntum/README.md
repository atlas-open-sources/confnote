# bryntum — the Planner drawer module (Module 2)

A drawer module per [`docs/MODULE.md`](../../../../../docs/MODULE.md), built on
Bryntum Scheduler and Calendar, from Bryntum's public npm trial package
(`@bryntum/calendar-trial` 7.3.8, installed as `@bryntum/calendar`, which
brings Scheduler).

| View | Component | What it does |
|---|---|---|
| Rooms (default for a multi-track day) | Scheduler, rooms (or, when the agenda names none, packed parallel tracks) as rows, time across | The day at a glance across tracks: talks are bars along each room's row, picks (the agenda's stars, same as Day) are inverted, and two picks at once mark their overlap with a red **Clash** band across every row (Scheduler time ranges). Breaks and lunch are grey bands labelled by their type (Break, Lunch), never bars. A "now" line runs while the day is on. The hour is sized so a typical talk shows two lines of title and its speakers; the drawer scrolls sideways. |
| Day (default for a single-track day) | Calendar day view, rooms as resources (`dayresource`; plain `day` with parallel sessions side by side when the agenda names no rooms) | The open conference's day, read like a printed programme. Click a session to pick or unpick it. Picks **are** the agenda's stars (`window.confnote.stars`, the `confnote-stars-changed` event): the sidebar, Schedule, My Agenda and the open note's Attend button follow at once, and a star set there fills in here. Two overlapping picks are a clash (red outline, and "Conflicts to decide" in My Agenda); a session overlapping a pick is dimmed, as in the sidebar. Breaks are shown, never picked. "Only my picks" filters the day. |
| Trip | Scheduler | "I'm in `<city>` `<from>`–`<to>`": the catalogue's events in that city, one lane each so clashes line up (red outline). Click an event to mark it going; signed in on the web target that also opens its workspace (`/api/tracking`, `/api/going`). "Plan my days" asks the Concierge for a My plan row; **Spend** adds the Credits row (AI charges, PayPal purchases) zoomed to its minutes. |
| Calendar | Calendar | Month/week of interested / going / attended events, application deadlines as red flags. |

Which opens first: until a tab is clicked (remembered in
`confnote-planner-view-v2`), a conference whose talks use two rooms or run
two at once opens on Rooms, any other on Day.

Why Calendar for Day, not Scheduler: the day of a conference is a column of
time per room, which is what Calendar's resource day view draws natively
(room headers, a time axis, overlapping sessions laid out side by side), on
the tall drawer, with the hour sized to the day's typical talk. Scheduler
with rooms as rows squeezes 40-minute talks into narrow horizontal bars whose
titles truncate, and its vertical mode needed a hand-made "My day" column
that moved a session out of its room.

Tracking without a sign-in uses the catalogue page's own localStorage keys
(`confnote-event-tracking`, `confnote-trip`), so the two agree.

## Open source, Bryntum is not

Bryntum is commercial; this module's own code is ours. Bryntum's bundle
(`vendor/`) is never committed: `make bryntum` builds it from the public
npm trial package (no login), whose `package.json` says `"license":
"Commercial"` and grants no redistribution. The OSS clean export
(`scripts/oss_export.py`) ships the module (`bryntum.js`, `bryntum.css`,
`build/`, the tests) with the slot on, but not `vendor/` or a licence key.
The web build (`packages/web-app/scripts/build-static.mjs`) builds the
bundle when it is missing and ships the module. The local `.app`
(`packages/local-app/build-macos.sh`) still leaves it out.

## Licence key

The key ships in browser JS by design but is never committed. At dev or build
time, write it into the gitignored `license.local.js` (0600):

    node build/write-license.mjs [target]

It reads `CONFNOTE_BRYNTUM_LICENSE_KEY` (the env the web build uses to decide
whether Bryntum ships at all) or, on macOS, the keychain item
`bryntum-trial-license` / `license_key`. The web build should run it with the
built `modules/bryntum/license.local.js` as the target. Without the file
Bryntum runs in trial mode with a watermark; nothing else changes.
`license.local.js.example` shows the shape.

## Untrusted data

Catalogue and agenda strings are scraped. Every Bryntum renderer gets encoded
text (`StringHelper.encodeHtml`), picks are stored as the agenda's own note
names (never scraped text), and only `http:`/`https:` workspace URLs are followed. Rooms' break and lunch bands are labelled by
type, never with the agenda's title: Bryntum draws a time range's name into
the DOM. The e2e suite feeds a hostile name, room, break, lunch and
`javascript:` URL through the views.

## Building the vendor bundle

    make bryntum        # or: cd build && npm ci --ignore-scripts && npm run build

`npm ci` installs exactly the committed `build/package-lock.json` (the trial
package's pinned version and integrity hash) with all install scripts off;
`npm run build` then writes `vendor/bryntum-island.bundle.{js,css}` plus the
Font Awesome fonts, lazy-loaded on the first open. It also stamps the per-install
id that Bryntum's own (skipped) install script would have written. `build/.npmrc` pins `@bryntum` to registry.npmjs.org, so a
global npmrc pointing at npm.bryntum.com does not get in the way. A licensed
build swaps only the `@bryntum/calendar` alias in `build/package.json`.

## Removing it

Swap `bryntum` back to `module-2` in `modules.config.json`, or delete this
directory and the slot string. Core never names the module.
