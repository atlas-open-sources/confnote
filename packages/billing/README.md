# Shared wallet client

`RouterWallet` calls Router `/v1/wallet/{balance,reserve,settle,release}` with a backend tenant/product credential. Money is integer USD micro-units. Input totals include cache read/write; separate fields let Router apply its price book without double counting.

Set `CONFNOTE_ROUTER_URL` and `CONFNOTE_ROUTER_SERVICE_TOKEN` only on the backend. The web AI SDK middleware reserves separately before each provider call, settles the reported usage before forwarding its finish, and stops before the next provider call when Router returns 402. Retry is disabled on the agent. Every accepted stream exit settles: actual usage when complete counters are reported, otherwise a provisional maximum capture. Three same-key settlement attempts are retained by `waitUntil`; Router capture-on-expiry is required before invoking the provider and covers process termination. Only a request rejected before acceptance is released. Ambiguous transport failures capture conservatively. Unknown media pricing is rejected on credits; BYOK remains available. Router owns charge caps and platform-loss audit for usage above the reservation.

Direct BYOK is request-scoped, uses fixed provider endpoints and never falls back to Gateway or wallet credits. The browser holds a key in memory for the current tab only.

Live price books, payment checkout and provider usage were not tested. Use Router sandbox configuration and complete reconciliation validation before exposing paid calls publicly.
