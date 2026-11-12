# confnote web app

Private Vercel Functions target for confnote.

## Local commands

```bash
npm --prefix packages/web-app install
npm --prefix packages/web-app run check
npm --prefix packages/web-app run dev:vercel
```

Local dev defaults to filesystem storage in `packages/web-app/.data/default`.
Preview deployments use Vercel Blob when `BLOB_READ_WRITE_TOKEN` is present.
The web Concierge uses the Vercel AI SDK `ToolLoopAgent` on protected Vercel
preview/production deployments. Local dev stays deterministic unless provider
credentials are set or `CONFNOTE_WEB_AGENT_ENABLED=1`.

## Concierge providers and tools

Model routing defaults to Vercel AI Gateway:

```bash
CONFNOTE_WEB_AGENT_PROVIDER=gateway
CONFNOTE_WEB_AGENT_MODEL=openai/gpt-5.1-instant
```

To keep the Vercel AI SDK agent loop but send model calls through LiteLLM:

```bash
CONFNOTE_WEB_AGENT_PROVIDER=litellm
LITELLM_BASE_URL=https://litellm.example.com/v1
LITELLM_API_KEY=...
CONFNOTE_WEB_AGENT_MODEL=your-litellm-model-or-alias
```

For the paid hosted Concierge, send each agent step through the Mochi Router
gateway in wallet mode:

```bash
CONFNOTE_WEB_AGENT_PROVIDER=mochi-router
CONFNOTE_ROUTER_URL=https://meow.api.mochirouter.com
CONFNOTE_ROUTER_SERVICE_TOKEN=...   # wallet service credential (bearer)
CONFNOTE_WEB_AGENT_MODEL=claude-sonnet-4-6  # default; or claude-haiku-4-5
```

Each step is one `POST ${CONFNOTE_ROUTER_URL}/v1/chat/completions` (streaming,
tools, reply cap 1400 tokens) with `x-mochi-wallet-user` set from the signed-in
user, never from the request body. The Router reserves, calls Claude, settles,
and runs auto top-up; confnote does not call the wallet reserve/settle routes in
this mode. Model ids must be in the Router's confnote price book (migration
0065); anything else is refused before a call. A Router 402 becomes the buy-more
card, including why auto top-up did not run (`capped`, `declined`, `off`,
`in_flight`, `granted`). For `in_flight` (a top-up is still being charged) the
Concierge first says "Topping up…", polls the wallet for up to 20 s and runs the
refused step once more, if nothing of it has shown yet; only if the credits do
not land does the card appear. A 503 `provider_budget_exhausted` becomes a "try again
later" message. BYOK requests never reach the Router. The Router answers each
step in one burst once its provider call finishes, so this mode waits up to 45 s
for the first chunk (Router per-attempt timeout 30 s + 10 s, floored at 45 s),
50 s per step and 100 s per turn; `vercel.json` `maxDuration` is 120 s for it.

The Concierge tool suite can read conferences, notes, actions, and conference
docs; import pasted `confnote.agenda.v1`; write `Summary`, `Research`, `AI
notes`, `BRIEF.md`, and `DEBRIEF.md`; append/complete action items; search the
web; and fetch public URLs for research. Web search is explicit and provider
backed. Configure one of:

```bash
BRAVE_SEARCH_API_KEY=...
TAVILY_API_KEY=...
EXA_API_KEY=...
CONFNOTE_WEB_SEARCH_PROVIDER=auto # or brave|tavily|exa
```

## Vercel setup

1. Create or link a Vercel project rooted at `packages/web-app`.
2. Attach a **private** Vercel Blob store.
3. Ensure `BLOB_READ_WRITE_TOKEN` is available in preview deployments.
4. Configure model routing: Vercel AI Gateway, or LiteLLM via the env vars
   above. Gateway authenticates with Vercel OIDC on preview/production
   deployments, or with `AI_GATEWAY_API_KEY` when set.
5. Enable deployment protection in Vercel project settings. Use password
   protection or Vercel authentication for the private preview.
6. Run `npm --prefix packages/web-app run check`.
7. Migrate notes with `npm --prefix packages/web-app run migrate -- <vault> [workspace]`
   (`scripts/migrate-to-blob.ts`).
8. Deploy a preview from `packages/web-app` with `vercel deploy --yes`.

The web preview ships a **Concierge drawer** backed by the Vercel AI SDK
`streamText` tool loop (ten-step cap), with a redacted error callback. The agent
can read and change Blob-backed Markdown through typed tools. Paid search is
disabled unless an operator explicitly sets `CONFNOTE_PAID_SEARCH_ENABLED=1`;
that opt-in accepts platform search cost until tool-level billing exists.

Private web uses WorkOS plus app-owned PostgreSQL identities, memberships and
note revisions; apply both migrations in `packages/auth/migrations`. BYOK keys
are request-scoped and sent only to the selected provider. Platform model calls
require a Router service credential whose reservation response confirms
`expiryPolicy: "capture"`. Every accepted call settles actual reported usage or
a provisional held maximum on interruption, with same-key retries retained by
Vercel `waitUntil`. The 120-second function limit leaves room after the 25-second
agent timeout for settlement. Router captures abandoned holds and owns later
actual-usage adjustment/refund audit. No live identity or payment integration was
exercised during the local implementation.

Router wallet env (paid, non-BYOK Concierge; staging Router is meow):

```bash
CONFNOTE_ROUTER_URL=https://meow.api.mochirouter.com
CONFNOTE_ROUTER_SERVICE_TOKEN=...   # wallet service credential, capture policy
CONFNOTE_PUBLIC_BASE_URL=https://<preview origin>  # PayPal return/cancel URLs
```

`GET /api/wallet` returns the balance. `POST /api/wallet/checkout {sku}` asks
the Router for a PayPal order for one catalog pack and returns its `orderId`
and `approveUrl`; `POST /api/wallet/capture {orderId}` captures it after the
buyer approves. The browser never names a price and never sees the credential.

Local vault switching is intentionally disabled in web v0. Transcription is
locked on the hosted site (2026-11-11): the Transcript tab says it runs on
device in the confnote Mac app with Local AI Cat and takes pasted transcripts
through the notes API; no audio reaches this server or any provider (see
docs/integration/local-ai-cat-transcription.md).
The notes API, conference import, private encrypted section metadata,
brief/debrief docs, action aggregation, and Concierge preview are live.
