import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { afterEach, expect, it, vi } from "vitest";
import { isPaypalApproveUrl, productRoute, type ProductRepository } from "../lib/product.js";
import type { RequestContext } from "../lib/types.js";
import { WorkspaceLimitError } from "../../auth/src/repository.js";
function response() {
  const result = { code: 0, body: undefined as unknown };
  const res = { status(code: number) { result.code = code; return res; }, json(body: unknown) { result.body = body; return res; }, setHeader() { return res; } };
  return { result, res: res as unknown as VercelResponse };
}
afterEach(() => vi.unstubAllEnvs());
it("going creates an owned notebook, persists tracking, and returns a workspace-scoped link", async () => {
  vi.stubEnv("CONFNOTE_CATALOGUE_DIR", path.resolve(import.meta.dirname, "../../catalogue-web/fixtures"));
  const id = randomUUID();
  const ctx: RequestContext = { workspace: "personal", principal: { userId: "app-user", workspaceId: "personal", role: "owner", email: "fixture@example.test", emailVerified: true, authMethod: "email_code", sessionId: "session" } };
  const repo: ProductRepository = { plan: vi.fn(async () => "free" as const), workspaces: vi.fn(async () => []), eventWorkspace: vi.fn(async () => ({ id, name: "Fixture", eventId: "evt-demo-1", role: "owner" as const })), tracking: vi.fn(async () => ({})), track: vi.fn(async () => {}) };
  const profile = response(); await productRoute({ method: "GET" } as VercelRequest, profile.res, "me", ctx, repo);
  expect(profile.result.code).toBe(200); expect(profile.result.body).not.toHaveProperty("sessionId");
  const req = { method: "POST", body: { eventId: "evt-demo-1" } } as VercelRequest;
  const { result, res } = response();
  try {
    expect(await productRoute(req, res, "going", ctx, repo)).toBe(true);
    expect(result.code).toBe(201);
    expect(result.body).toMatchObject({ workspace: { id }, url: expect.stringContaining(`workspace=${id}`), ok: true });
    expect(repo.eventWorkspace).toHaveBeenCalledWith("app-user", "evt-demo-1", "Builders by the river");
    expect(repo.track).toHaveBeenCalledWith("app-user", "evt-demo-1", "going");
    const agendaPath = path.resolve(import.meta.dirname, "../.data", id, `${(result.body as { slug: string }).slug}/agenda.json`);
    const agenda = JSON.parse(await fs.readFile(agendaPath, "utf8"));
    agenda.events = [{ id: "my-session", title: "My session", start: "2099-06-11T09:00:00Z", end: "2099-06-11T10:00:00Z", note_file: "session-my-session.md" }];
    await fs.writeFile(agendaPath, JSON.stringify(agenda));
    const again = response(); await productRoute(req, again.res, "going", ctx, repo);
    expect(again.result.code).toBe(201);
    expect(JSON.parse(await fs.readFile(agendaPath, "utf8")).events).toEqual(agenda.events);
    const exported = response(); await productRoute({ method: "GET" } as VercelRequest, exported.res, "vault/export", { ...ctx, workspace: id }, repo);
    expect(exported.result.code).toBe(200);
    expect(exported.result.body).toMatchObject({ schema_version: "confnote.vault.v1" });
    repo.eventWorkspace = vi.fn(async () => { throw new WorkspaceLimitError(); });
    const denied = response(); await productRoute(req, denied.res, "going", ctx, repo);
    expect(denied.result.code).toBe(402);
    expect(repo.track).toHaveBeenCalledTimes(2);
  } finally { await fs.rm(path.resolve(import.meta.dirname, "../.data", id), { recursive: true, force: true }); }
});
it("wallet checkout asks the Router for a priced pack order and capture forwards only the order id", async () => {
  vi.stubEnv("CONFNOTE_ROUTER_URL", "https://router.test");
  vi.stubEnv("CONFNOTE_ROUTER_SERVICE_TOKEN", "service-token");
  vi.stubEnv("CONFNOTE_PUBLIC_BASE_URL", "https://confnote.test");
  const dataDir = path.resolve(import.meta.dirname, "../.data", `consent-${randomUUID()}`);
  vi.stubEnv("CONFNOTE_STORAGE", "fs");
  vi.stubEnv("CONFNOTE_WEB_DATA_DIR", dataDir);
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const payload = url.endsWith("/checkout")
      ? { provider: "paypal", orderId: "ORDER1", approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1", sku: "pack-5", credits: "5000000", price: { amountMinor: "500", currency: "USD" } }
      : { status: "captured", paymentIds: ["pay-1"] };
    return new Response(JSON.stringify(payload), { status: 200 });
  }));
  const ctx: RequestContext = { workspace: "personal", principal: { userId: "app-user", workspaceId: "personal", role: "owner", email: "fixture@example.test", emailVerified: true, authMethod: "email_code", sessionId: "session" } };
  const repo = {} as ProductRepository;
  try {
    const refused = response();
    await productRoute({ method: "POST", body: { sku: "pack-5" } } as VercelRequest, refused.res, "wallet/checkout", ctx, repo);
    expect(refused.result.code).toBe(400);
    expect(calls).toHaveLength(0);
    const start = response();
    const consent = { accepted: true, at: "2026-11-09T01:00:00.000Z" };
    await productRoute({ method: "POST", body: { sku: "pack-5", price: 1, consent } } as VercelRequest, start.res, "wallet/checkout", ctx, repo);
    expect(start.result.code).toBe(200);
    const record = JSON.parse(await fs.readFile(path.join(dataDir, "wallet-consent", "app-user", "orders", "ORDER1.json"), "utf8"));
    expect(record).toMatchObject({ userId: "app-user", orderId: "ORDER1", sku: "pack-5", acceptedAt: consent.at });
    // The consent attempt was recorded first and its id is the Router idempotency key.
    expect(calls[0].body.idempotencyKey).toBe(record.attemptId);
    await fs.access(path.join(dataDir, "wallet-consent", "app-user", "attempts", `${record.attemptId}.json`));
    expect(record.consentText).toContain("lose my 14-day right to cancel");
    expect(start.result.body).toMatchObject({ orderId: "ORDER1", sku: "pack-5" });
    expect(calls[0].url).toBe("https://router.test/v1/wallet/checkout");
    expect(calls[0].body).toMatchObject({ userId: "app-user", sku: "pack-5", returnUrl: "https://confnote.test/?wallet=return", cancelUrl: "https://confnote.test/?wallet=cancel" });
    expect(calls[0].body).not.toHaveProperty("price");
    expect(calls[0].body).not.toHaveProperty("consent");
    const done = response();
    await productRoute({ method: "POST", body: { orderId: "ORDER1" } } as VercelRequest, done.res, "wallet/capture", ctx, repo);
    expect(done.result).toMatchObject({ code: 200, body: { status: "captured" } });
    expect(calls[1]).toMatchObject({ url: "https://router.test/v1/wallet/checkout/capture", body: { userId: "app-user", orderId: "ORDER1" } });
    const bad = response();
    await productRoute({ method: "POST", body: { orderId: "../x" } } as VercelRequest, bad.res, "wallet/capture", ctx, repo);
    expect(bad.result.code).toBe(400);
    expect(calls).toHaveLength(2);
  } finally {
    vi.unstubAllGlobals();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

it("wallet packs come from the Router catalog with the public sandbox PayPal client id", async () => {
  vi.stubEnv("CONFNOTE_ROUTER_URL", "https://router.test");
  vi.stubEnv("CONFNOTE_ROUTER_SERVICE_TOKEN", "service-token");
  vi.stubEnv("CONFNOTE_PAYPAL_CLIENT_ID", "sandbox-client");
  const packs = [{ sku: "pack-5", credits: "5000000", price: { amountMinor: "500", currency: "USD" } }];
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    urls.push(`${init.method} ${url}`);
    return new Response(JSON.stringify({ packs }), { status: 200 });
  }));
  const ctx: RequestContext = { workspace: "personal", principal: { userId: "app-user", workspaceId: "personal", role: "owner", email: "fixture@example.test", emailVerified: true, authMethod: "email_code", sessionId: "session" } };
  try {
    const listed = response();
    await productRoute({ method: "GET" } as VercelRequest, listed.res, "wallet/packs", ctx, {} as ProductRepository);
    expect(listed.result).toEqual({ code: 200, body: { packs, paypal: { clientId: "sandbox-client", environment: "sandbox" } } });
    expect(urls).toEqual(["GET https://router.test/v1/wallet/packs"]);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("wallet usage proxies the signed-in user's Router usage page", async () => {
  vi.stubEnv("CONFNOTE_ROUTER_URL", "https://router.test");
  vi.stubEnv("CONFNOTE_ROUTER_SERVICE_TOKEN", "service-token");
  const page = { items: [
    { at: "2026-11-09T01:00:00Z", kind: "charge", modelId: "claude-sonnet-4-6", amount: { usdMicros: -4200 }, balanceAfter: 1995800, ref: "led-2" },
    { at: "2026-11-09T00:59:00Z", kind: "promo", amount: { usdMicros: 2000000 }, balanceAfter: 2000000, ref: "led-1" },
  ], next: "c2" };
  const rows = { rows: [
    { at: "2026-11-09T01:00:00Z", model: "claude-sonnet-4-6", reason: "charge", inputTokens: null, outputTokens: null, charged: "-0.0042", unit: "USD", balanceAfter: "1.9958", provisional: false, ref: "led-2" },
    { at: "2026-11-09T00:59:00Z", model: null, reason: "promo", inputTokens: null, outputTokens: null, charged: "2.0000", unit: "USD", balanceAfter: "2.0000", provisional: false, ref: "led-1" },
  ], next: "c2" };
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(page), { status: 200 });
  }));
  const ctx: RequestContext = { workspace: "personal", principal: { userId: "app-user", workspaceId: "personal", role: "owner", email: "fixture@example.test", emailVerified: true, authMethod: "email_code", sessionId: "session" } };
  try {
    const listed = response();
    await productRoute({ method: "GET", query: { cursor: "c1" } } as unknown as VercelRequest, listed.res, "wallet/usage", ctx, {} as ProductRepository);
    expect(listed.result).toEqual({ code: 200, body: rows });
    expect(urls).toEqual(["https://router.test/v1/wallet/usage?userId=app-user&before=c1"]);
    const anonymous = response();
    await productRoute({ method: "GET", query: {} } as unknown as VercelRequest, anonymous.res, "wallet/usage", { workspace: "personal" } as RequestContext, {} as ProductRepository);
    expect(anonymous.result.code).toBe(401);
  } finally {
    vi.unstubAllGlobals();
  }
});

function walletEnv(dataDir: string): RequestContext {
  vi.stubEnv("CONFNOTE_ROUTER_URL", "https://router.test");
  vi.stubEnv("CONFNOTE_ROUTER_SERVICE_TOKEN", "service-token");
  vi.stubEnv("CONFNOTE_PUBLIC_BASE_URL", "https://confnote.test");
  vi.stubEnv("CONFNOTE_STORAGE", "fs");
  vi.stubEnv("CONFNOTE_WEB_DATA_DIR", dataDir);
  return { workspace: "personal", principal: { userId: "app-user", workspaceId: "personal", role: "owner", email: "fixture@example.test", emailVerified: true, authMethod: "email_code", sessionId: "session" } };
}

it("capture is refused without a consent record for this user and order, before any Router call", async () => {
  const dataDir = path.resolve(import.meta.dirname, "../.data", `consent-${randomUUID()}`);
  const ctx = walletEnv(dataDir);
  const router = vi.fn(async () => new Response(JSON.stringify({ status: "captured", paymentIds: [] }), { status: 200 }));
  vi.stubGlobal("fetch", router);
  try {
    const missing = response();
    await productRoute({ method: "POST", body: { orderId: "ORDER9" } } as VercelRequest, missing.res, "wallet/capture", ctx, {} as ProductRepository);
    expect(missing.result.code).toBe(403);
    // Another user's record for the same order does not count.
    const other = path.join(dataDir, "wallet-consent", "other-user", "orders");
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, "ORDER9.json"), JSON.stringify({ userId: "other-user", orderId: "ORDER9" }));
    const foreign = response();
    await productRoute({ method: "POST", body: { orderId: "ORDER9" } } as VercelRequest, foreign.res, "wallet/capture", ctx, {} as ProductRepository);
    expect(foreign.result.code).toBe(403);
    expect(router).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

it("checkout creates no order when the consent record cannot be written", async () => {
  const blocker = path.resolve(import.meta.dirname, "../.data", `consent-file-${randomUUID()}`);
  await fs.mkdir(path.dirname(blocker), { recursive: true });
  await fs.writeFile(blocker, "a file where the storage root should be");
  const ctx = walletEnv(blocker);
  const router = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", router);
  try {
    const start = response();
    await productRoute({ method: "POST", body: { sku: "pack-5", consent: { accepted: true, at: "2026-11-09T01:00:00.000Z" } } } as VercelRequest, start.res, "wallet/checkout", ctx, {} as ProductRepository);
    expect(start.result.code).toBeGreaterThanOrEqual(400);
    expect(router).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    await fs.rm(blocker, { force: true });
  }
});

it("checkout refuses a Router approve URL that is not the PayPal sandbox", async () => {
  expect(isPaypalApproveUrl("https://www.sandbox.paypal.com/checkoutnow?token=A1")).toBe(true);
  for (const bad of ["javascript:alert(1)", "https://evil.example/checkoutnow", "http://www.sandbox.paypal.com/x", "https://www.sandbox.paypal.com.evil.example/x", "https://user@www.sandbox.paypal.com/x", "https://www.paypal.com/checkoutnow"]) {
    expect(isPaypalApproveUrl(bad)).toBe(false);
  }
  const dataDir = path.resolve(import.meta.dirname, "../.data", `consent-${randomUUID()}`);
  const ctx = walletEnv(dataDir);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ provider: "paypal", orderId: "ORDER2", approveUrl: "javascript:alert(1)", sku: "pack-5", credits: "5000000", price: { amountMinor: "500", currency: "USD" } }), { status: 200 })));
  try {
    const start = response();
    await productRoute({ method: "POST", body: { sku: "pack-5", consent: { accepted: true, at: "2026-11-09T01:00:00.000Z" } } } as VercelRequest, start.res, "wallet/checkout", ctx, {} as ProductRepository);
    expect(start.result.code).toBe(502);
    expect(JSON.stringify(start.result.body)).not.toContain("javascript");
  } finally {
    vi.unstubAllGlobals();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

it("a card saved for auto top-up asks the Router for a card order, which has no approve page", async () => {
  const dataDir = path.resolve(import.meta.dirname, "../.data", `consent-${randomUUID()}`);
  const ctx = walletEnv(dataDir);
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ provider: "paypal", orderId: `ORDER${bodies.length}`, sku: "pack-5", credits: "5000000", price: { amountMinor: "500", currency: "USD" } }), { status: 200 });
  }));
  const consent = { accepted: true, at: "2026-11-09T01:00:00.000Z" };
  try {
    const card = response();
    await productRoute({ method: "POST", body: { sku: "pack-5", consent, saveForAutoTopUp: true, paymentSource: "card" } } as VercelRequest, card.res, "wallet/checkout", ctx, {} as ProductRepository);
    expect(card.result.code).toBe(200);
    expect(bodies[0]).toMatchObject({ saveForAutoTopUp: true, paymentSource: "card" });
    await expect(fs.stat(path.join(dataDir, "wallet-consent", "app-user", "orders", "ORDER1.json"))).resolves.toBeTruthy();
    // Card without saving is not a path: one-off purchases stay on the PayPal buttons, which need an approve page.
    const oneOff = response();
    await productRoute({ method: "POST", body: { sku: "pack-5", consent, paymentSource: "card" } } as VercelRequest, oneOff.res, "wallet/checkout", ctx, {} as ProductRepository);
    expect(bodies[1]).not.toHaveProperty("paymentSource");
    expect(oneOff.result.code).toBe(502);
  } finally {
    vi.unstubAllGlobals();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

it("auto top-up reads and sets the Router policy for the signed-in user only, with a fresh idempotency key", async () => {
  vi.stubEnv("CONFNOTE_ROUTER_URL", "https://router.test");
  vi.stubEnv("CONFNOTE_ROUTER_SERVICE_TOKEN", "service-token");
  const status = { enabled: true, sku: "pack_usd_5", monthlyCapUsdMicros: 25000000, savedMethod: { provider: "paypal", method: "card" } };
  const calls: { url: string; body?: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(status), { status: 200 });
  }));
  const ctx: RequestContext = { workspace: "personal", principal: { userId: "app-user", workspaceId: "personal", role: "owner", email: "fixture@example.test", emailVerified: true, authMethod: "email_code", sessionId: "session" } };
  try {
    const read = response();
    await productRoute({ method: "GET", query: {} } as unknown as VercelRequest, read.res, "wallet/autotopup", ctx, {} as ProductRepository);
    expect(read.result).toEqual({ code: 200, body: status });
    const set = response();
    await productRoute({ method: "POST", body: { enabled: true, sku: "pack_usd_5", monthlyCapUsdMicros: 25000000, userId: "someone-else" } } as unknown as VercelRequest, set.res, "wallet/autotopup", ctx, {} as ProductRepository);
    expect(set.result.code).toBe(200);
    expect(calls[0].url).toBe("https://router.test/v1/wallet/autotopup?userId=app-user");
    expect(calls[1].url).toBe("https://router.test/v1/wallet/autotopup/policy");
    expect(calls[1].body).toMatchObject({ userId: "app-user", enabled: true, sku: "pack_usd_5", monthlyCapUsdMicros: 25000000 });
    expect(calls[1].body?.idempotencyKey).toEqual(expect.any(String));
    const bad = response();
    await productRoute({ method: "POST", body: { enabled: true, sku: "pack_usd_5", monthlyCapUsdMicros: -1 } } as unknown as VercelRequest, bad.res, "wallet/autotopup", ctx, {} as ProductRepository);
    expect(bad.result.code).toBe(400);
    expect(calls).toHaveLength(2);
  } finally {
    vi.unstubAllGlobals();
  }
});
