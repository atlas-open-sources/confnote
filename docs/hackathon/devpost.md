# Devpost entry: confnote (draft, not submitted)

Draft for the PayPal AI Hackathon on Devpost (deadline 2026-11-12 12:00 PT = 2026-11-13 04:00 UTC+8). Nothing here
has been submitted or published. Every claim below is true of branch `integrate/hackathon-20261109` at 5477f02
(served by https://staging.confnote.si) and the Mochi Router, proven against the Router and the **PayPal sandbox**.
Payments are sandbox only; there is no live PayPal yet. Refreshed 2026-11-12 for the v7 video.

Production (https://confnote.si) runs the same build and passed the full paid flow on 2026-11-13: trial, 402,
PayPal sandbox purchase with bonus, Card Fields save, auto top-up and the Ledger. **Fill in before submitting:** the
YouTube link (Media).

## Project name

confnote

## Tagline (≤ 200 characters)

> A conference notebook whose AI Concierge is metered per agent step and paid with PayPal: credit packs, a 402 when
> you run out, and auto top-up on a card saved with Card Fields.

(176 characters.)

## Inspiration

confnote began at **Beyond The Prompt**, the event AG Grid and Bryntum ran at IET London on 19 May 2026. I built
confnote during the conference: within an hour of the start I had the first version, and I used it for the rest of
the day. I wanted one place for the talks I planned to see, the notes I took and the follow-ups I owed, so the
notebook keeps every session as plain Markdown. An AI Concierge that reads those notes was the obvious next step, and the hard question became how
to charge for it fairly. A subscription is too much for someone who uses the Concierge twice per conference. We
wanted people to pay for exactly the AI they use, with no subscription, using a payment method they already trust.

## Try it

- **https://confnote.si**: sign up and get USD 2 of trial credit. Payments use the PayPal sandbox through judging
  (test cards only, no real money).
- Staging: https://staging.confnote.si (same build, where the demo video was recorded).

## What it does

- **Set up a conference.** Paste an agenda link or a conference website into the Concierge and it creates every
  session with times, rooms and speakers, then writes a brief and a note on each speaker with a question to ask (from the agenda and the model; no live web search on the web app yet).
- **Take notes.** Each session is a Markdown note with your notes, Research and a Transcript tab. On the web the
  Transcript tab is locked (many conferences do not allow recording); you can paste a transcript you are allowed to
  use, and the Mac app transcribes on your own machine.
- **See it.** A **tldraw** mind map lays out a conference's topics and the notes under each.
- **Plan.** An events catalogue in an **AG Grid** drawer: filter by city, dates, organiser and topic, and mark an event
  Going. confnote creates a workspace for it. **Bryntum** Rooms shows a conference day with rooms as columns, the
  Concierge's picks on your plan and a red band where two picks clash; Day, Trip and Calendar views sit beside it.
- **Ask.** The Concierge is an AI agent (Claude Sonnet 4.6) with 27 tools over your conferences, notes and actions.
  The tool list is one shared spec (`packages/contracts/tools.json`) used by both the Mac app and the web app, with a
  parity test so they cannot drift.
- **Meter.** Every agent step goes through Mochi Router, our own AI gateway. The Router's wallet **reserves** credit
  before the step, **settles** the real cost after it and releases the rest. A step in the demo costs about a cent.
  Each charge and top-up appears in the AG Grid **Ledger** straight from the Router ledger.
- **Pay with PayPal.** New accounts get USD 2 of trial credit. When the wallet cannot cover a step, the Router answers
  **HTTP 402** and the Concierge shows a buy-more card with the balance and what the step needs. Credit packs are
  priced by the Router's catalogue and paid through **PayPal Orders v2** (JS SDK v6 buttons, guest card in the
  sandbox). The Router creates and captures the order; card details never touch confnote. The first purchase adds a
  USD 2 bonus.
- **Auto top-up.** Tick "Save this card" and **PayPal Card Fields** take the card inside the page with no PayPal
  login. PayPal **vaults** it with the purchase. When a later step needs more than the balance, the Router charges the
  saved card for a pack on its own (merchant-initiated, no buyer present), within a monthly cap the user sets, and
  the Concierge keeps answering. The checkbox is the off switch.

## How we built it

- **confnote web app** (TypeScript, Vercel Functions): WorkOS sign-in, Postgres for identities and workspaces, the
  Vercel AI SDK `ToolLoopAgent` for the Concierge, and a static core UI with drawer modules. In paid mode each agent
  step is one `POST /v1/chat/completions` to the Router with the signed-in user's id in `x-mochi-wallet-user`, taken
  from the session and never from the request body. confnote does not meter by itself in this mode, so nothing is
  charged twice.
- **Mochi Router gateway** (TypeScript, Fastify, Drizzle, Postgres): an OpenAI-compatible chat endpoint with tools,
  routing Claude to AWS Bedrock (an Anthropic-direct route is built and can be preferred for promo-funded steps).
  Per-provider spend ceilings stop runaway cost with a 503 instead of a bill.
- **Router wallet**: a double-entry ledger in USD micros with reserve, settle and release, promo pools (trial and
  first-purchase bonus), refunds, disputes and reconciliation, and a 402 that tells the client why auto top-up did or
  did not run (`capped`, `declined`, `off`, `in_flight`, `granted`).
- **PayPal**: Orders v2 create and capture from the Router (pack price rechecked at capture), JS SDK v6 one-time
  payment buttons, JS SDK Card Fields (`payment_source.card` with `SCA_WHEN_REQUIRED` and
  `store_in_vault: ON_SUCCESS`), Vault payment tokens for merchant-initiated top-ups (`stored_credential`
  MERCHANT/UNSCHEDULED/SUBSEQUENT), and webhook normalization (`PAYMENT.CAPTURE.COMPLETED`, deduplicated by payment
  id) with a reconcile job over `webhooks-events`.
- **Consent before payment**: PayPal stays disabled until the buyer agrees that credits are delivered immediately and
  are non-refundable; the consent record is checked again at capture.
- **Tests**: Vitest and pytest unit suites, Playwright end-to-end tests (stubbed PayPal SDKs for CI), the Router's
  `pnpm verify` (1,642 tests), and recorded live runs against staging and the PayPal sandbox.

## Challenges we ran into

- **Saving a card without a PayPal account.** Vaulting through the PayPal-wallet popup made PayPal require a PayPal
  login, so a guest could not save a card. Switching the save path to Card Fields with a `payment_source.card` order
  solved it; the Router needed a new card payment source for that.
- **Two PayPal SDKs on one page.** Buttons use JS SDK v6 and Card Fields use the v5 SDK. Card Fields loads under its
  own namespace so it never replaces v6's `window.paypal`, and a late async mount can never leave both pay surfaces
  on screen.
- **Grants arrive after capture.** The capture answers before the Router posts the grant, so the balance re-checks a
  few seconds later instead of showing the old number.
- **When auto top-up fires.** It fires when a reservation needs more than is available, not when the balance hits
  zero. The demo and its captions show exactly that.
- **Untrusted catalogue data in two grid libraries.** Scraped event names and URLs are rendered as text and only
  `http(s)` links are followed, with hostile-data end-to-end tests for both the AG Grid and Bryntum modules.
- **Buffered gateway replies.** The gateway answers each step in one burst, so the Concierge's timeouts had to grow
  for router mode.

## Accomplishments that we're proud of

- The whole loop runs end to end on real infrastructure: sign-up trial, metered Concierge, 402, PayPal purchase with
  bonus, Card Fields save, and an automatic merchant-initiated top-up while the Concierge keeps working. Sandbox
  order ids are in the demo's evidence file.
- Payment logic lives in one place. confnote never sees a card number, a vault token or a price it could tamper
  with; the Router owns prices, orders, captures and the ledger.
- The Router's payment-path changes were reviewed independently, and no blocking finding remains open.

## What we learned

- PayPal's save-with-purchase flow differs by payment source, and the card source is the one that works for guests.
- Metering per agent step, rather than per conversation, keeps the price honest and makes a 402 a normal, recoverable
  moment instead of an error.
- Making the wallet's refusal explain itself (why auto top-up did not run) removes most support questions before they
  are asked.

## What's next

- Live PayPal, after a review of the sandbox runs.
- Handle PayPal's delayed vault token (`VAULT.PAYMENT-TOKEN.CREATED`) so a card is saved even when PayPal finishes
  vaulting after capture, and prove live webhook signature verification on staging.
- Show the PayPal order id and the trigger of each automatic top-up in the wallet API and the Ledger.
- Hosted transcription as a metered, paid service, for conferences that allow recording.
- Keep the Concierge's chat history on the web host (today a reopened drawer starts a fresh thread).

## Built with

TypeScript, Python, Node.js, Vercel Functions, Vercel AI SDK, Claude Sonnet 4.6, AWS Bedrock, Fastify,
Drizzle ORM, Zod, PostgreSQL (Neon), Vercel Blob, WorkOS, PayPal Orders v2, PayPal JS SDK (v6 buttons, Card Fields),
PayPal Vault, PayPal Webhooks, AG Grid Community 36.3.0, AG Charts Community 14.3.0, Bryntum Calendar and Scheduler 7.3.8 (trial), tldraw 3,
Playwright, Vitest, pytest, Azure Container Apps (Router).

## Sponsor prize notes

### AG Grid (Module 1: Grids drawer)

- Built on **AG Grid Community 36.3.0** (MIT), vendored unmodified with its hash checked against the npm registry,
  lazy-loaded the first time the drawer opens. No Enterprise features and no licence key.
- Three grids: **Actions** (every open follow-up across conferences; ticking Done writes `- [x]` back to the
  Markdown note, with a stale-row guard), **Events** (the catalogue with filter rows and an editable Tracking column
  that writes Going/Interested), and **Ledger** (the transaction log from the Router: each metered Concierge step,
  each PayPal purchase and each automatic top-up, with the balance after it).
- Above the Ledger grid, an **AG Charts Community 14.3.0** (MIT, vendored unmodified, hash pinned) line chart of the
  balance over time from the same rows: it falls with each metered step, and top-ups and purchases are green markers.
- Themed with `themeQuartz.withParams` from confnote's own CSS variables, so it follows light and dark.
- Scraped text and URLs render inertly (tested with hostile data); a failed Tracking save rolls back without
  re-posting.
- Code: `packages/core-ui/static/modules/aggrid/`, tests `tests/test_aggrid_module.py`,
  `tests/e2e/test_grids_drawer.py`.

### Bryntum (Module 2: Planner drawer)

- Built on **Bryntum Calendar 7.3.8** (with Scheduler), lazy-loaded in drawer slot 2, svalbard-dark theme on
  confnote's tokens.
- Four views: **Rooms** (a conference day with rooms as columns, the Concierge's picks on "My plan", breaks and lunch
  as bands, and a red Clash band where two picks overlap), **Day** (drag a session into "My day", which writes
  `## My day` into the conference's `BRIEF.md` with mtime concurrency), **Trip** (one lane per catalogue event in the
  trip's city and dates, clashes outlined, click to mark Going) and **Calendar** (tracked events with
  application-deadline flags).
- Untrusted strings are HTML-encoded in every renderer and tooltip; only `http(s)` workspace URLs are followed.
- Runs on a Bryntum **trial** licence on both staging and confnote.si for the hackathon's judging period, with a
  notice in the module asking Bryntum whether to remove it or align the licence. The key is never committed (it is
  written to a gitignored file at build time). The Bryntum bundle itself is not redistributable under our licence, so the
  public export carries our module code and build steps, not Bryntum's files (see `oss-export-checklist.md`).
- Code: `packages/core-ui/static/modules/bryntum/`, tests `tests/test_bryntum_registration.py`,
  `tests/e2e/test_bryntum_module.py`.

### tldraw (mind map)

- Built on **tldraw 3** (the vendored 3.x SDK), lazy-loaded as a drawer module: a conference's topics as nodes with the session notes under
  each, laid out small first and readable when widened. Code: `packages/core-ui/static/modules/tldraw/`
  (`mind-map.js`).
- Runs on both staging and confnote.si for the judging period with the "made with tldraw" watermark visible, and a
  notice asking tldraw whether to remove it or align the licence.

## Media

- Demo video: **v7**, 2:55, 1920x1080, voiced, with captions and music generated with ACE-Step 1.5. Watch it at
  https://staging.confnote.si/demo. YouTube link: (fill in after upload). The source is in the project's artifacts
  (`artifacts/2026-11-12/demo-video-v7/`).
- Screenshots for the gallery: `01-signup-trial.png`, `02-going-planner.png`, `03-concierge-metered.png`,
  `04a-402-card.png`, `04-purchase-credited.png`, `05a-card-fields.png`, `05b-card-saved.png`,
  `05-autotopup-ledger.png` in the same folder.

## Note on the submission period

confnote's notebook predates the hackathon: it was built at Beyond The Prompt in May 2026, and this repository's
history starts on 2026-05-20. Work in the submission period includes the
hosted web app, the Router gateway and wallet integration, PayPal checkout, Card Fields and vault, auto top-up, and
both sponsor modules. If the rules ask for it, the entry should say this plainly.
