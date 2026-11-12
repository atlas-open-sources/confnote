# README "Hackathon" section (draft)

Draft text to paste into `README.md` when the public export is prepared. `README.md` itself is not edited.
Replace `STAGING_URL` and `VIDEO_URL` before use, and the licence line once the licence is chosen.

---

## Hackathon: PayPal AI Hackathon 2026

confnote is our entry to the PayPal AI Hackathon on Devpost, with the AG Grid and Bryntum sponsor modules.

**The idea:** a conference notebook whose AI Concierge you pay for per agent step, with PayPal, and no subscription.

- **Try it:** `STAGING_URL` (staging, PayPal **sandbox** only: pay with PayPal's published sandbox test cards, never a
  real card). Step-by-step guide: [docs/hackathon/judging.md](docs/hackathon/judging.md).
- **Demo video (2:47):** `VIDEO_URL`.

### What happens

1. A new account gets USD 2 of trial credit.
2. Each Concierge step (Claude Sonnet 4.6) runs through Mochi Router, which reserves credit, calls the model and
   settles the real cost; every charge shows in the AI-usage grid.
3. Out of credit, the Router answers **402** and the Concierge offers a credit pack.
4. The pack is paid with **PayPal Orders v2** (JS SDK v6 buttons). The Router creates and captures the order; the
   first purchase adds a bonus.
5. Ticking "Save this card" uses **PayPal Card Fields** to save the card with the purchase, no PayPal login. When a
   later step needs more than the balance, the Router charges the saved card for a pack within a monthly cap, and
   the Concierge keeps answering.

### Where the code is

| Part | Path |
|---|---|
| Wallet and PayPal UI (buy-more card, PayPal buttons, Card Fields, auto top-up toggle) | `packages/core-ui/static/product-shell.js` |
| Concierge on the Router gateway (wallet user from the session, 402/503 mapping) | `packages/web-app/lib/chat.ts` |
| Checkout, capture, usage and auto top-up proxies to the Router | `packages/web-app/` |
| AG Grid module: Actions, Events and AI-usage grids | `packages/core-ui/static/modules/aggrid/` |
| Bryntum module: trip, conference day and calendar planner | `packages/core-ui/static/modules/bryntum/` (needs Bryntum's package and a licence key; see its README) |
| Metering, wallet, PayPal orders, vault and webhooks | Mochi Router, a separate service |

### Run the web app against a Router

```bash
CONFNOTE_WEB_AGENT_PROVIDER=mochi-router
CONFNOTE_ROUTER_URL=https://<router-host>
CONFNOTE_ROUTER_SERVICE_TOKEN=...          # wallet service credential
CONFNOTE_WEB_AGENT_MODEL=claude-sonnet-4-6
```

Full variable list: [packages/web-app/README.md](packages/web-app/README.md).

### Tests

```bash
make lint && make test && make test-web && make e2e
```

The end-to-end suite stubs the PayPal SDKs, so it needs no PayPal credentials.

### Honest status

Built and proven on staging with the PayPal sandbox on 2026-11-09. There is no live PayPal and no production wallet
yet. Not built yet: Concierge chat history on the web host, and handling of PayPal's delayed vault-token event.

### Licence

`<MIT or AGPL-3.0-only, once chosen>`. AG Grid Community is MIT. Bryntum is commercial software and is not included.
