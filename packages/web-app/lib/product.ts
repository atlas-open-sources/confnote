import { createHash, randomUUID } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { PostgresIdentityRepository } from "../../auth/src/repository.js";
import { WorkspaceLimitError } from "../../auth/src/repository.js";
import { WalletError, entitlements, type UsagePage } from "../../billing/src/index.js";
import { slugify } from "./agenda.js";
import { localDay } from "../../catalogue-web/src/catalogue.js";
import { readCatalogue } from "./catalogue.js";
import { json, method } from "./http.js";
import { publicOrigin } from "./public-origin.js";
import { addConference, conferencePayload } from "./service.js";
import { createStorage, storageKey } from "./storage.js";
import type { AgendaData, RequestContext } from "./types.js";
import { configuredWallet } from "./wallet-model.js";
import { exportVault, importVault, validateBundle } from "./vault-transfer.js";
const SKU_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const ORDER_RE = /^[A-Z0-9]{1,64}$/;
const CURSOR_RE = /^[A-Za-z0-9_.:=-]{1,200}$/;
// The exact consent wording shown beside the PayPal buttons; stored with each order.
export const CREDITS_CONSENT_TEXT = "I want my credits now. I understand that credits are delivered immediately, and I lose my 14-day right to cancel. Credits are non-refundable.";
// PayPal approve pages the browser may be sent to. Sandbox only for now; live adds "www.paypal.com".
const PAYPAL_APPROVE_HOSTS = ["www.sandbox.paypal.com"];
export function isPaypalApproveUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && PAYPAL_APPROVE_HOSTS.includes(url.hostname) && !url.port && !url.username && !url.password;
  } catch {
    return false;
  }
}
function consentKey(userId: string, kind: "attempts" | "orders", id: string): string {
  return storageKey("wallet-consent", userId, kind, `${id}.json`);
}
async function hasConsent(userId: string, orderId: string): Promise<boolean> {
  const stored = await createStorage().readText(consentKey(userId, "orders", orderId));
  if (!stored) return false;
  try {
    const record = JSON.parse(stored.text) as { userId?: unknown; orderId?: unknown };
    return record.userId === userId && record.orderId === orderId;
  } catch {
    return false;
  }
}
const USD_MICROS = 1_000_000;
/** Router ledger page → the usage rows (AG Grid and the Planner's Credits row): one per ledger entry, signed USD (charges are negative), with the Router's ref. */
export function usageRows(page: UsagePage): { rows: Record<string, unknown>[]; next?: string } {
  const rows = page.items.map((item) => ({
    at: item.at, model: item.modelId ?? null, reason: item.kind,
    inputTokens: item.inputTokens ?? null, outputTokens: item.outputTokens ?? null,
    charged: (item.amount.usdMicros / USD_MICROS).toFixed(4), unit: "USD",
    balanceAfter: item.balanceAfter === undefined ? null : (item.balanceAfter / USD_MICROS).toFixed(4),
    provisional: false, ref: item.ref,
  }));
  return page.next ? { rows, next: page.next } : { rows };
}
export type ProductRepository =Pick<PostgresIdentityRepository, "workspaces" | "eventWorkspace" | "plan" | "tracking" | "track">;
export async function productRoute(req: VercelRequest, res: VercelResponse, route: string, ctx: RequestContext, repo?: ProductRepository): Promise<boolean> {
  if (!["me", "workspaces", "tracking", "going", "wallet", "wallet/packs", "wallet/usage", "wallet/checkout", "wallet/capture", "wallet/autotopup", "vault/export", "vault/import"].includes(route)) return false;
  if (!ctx.principal || !repo) { json(res, 401, { error: "Sign in required." }); return true; }
  const userId = ctx.principal.userId;
  try {
    if (route === "me" && req.method === "GET") {
      const { sessionId: _sessionId, ...profile } = ctx.principal;
      json(res, 200, { ...profile, entitlements: entitlements(await repo.plan(userId)) });
    }
    else if (route === "workspaces" && req.method === "GET") json(res, 200, await repo.workspaces(userId));
    else if (route === "wallet" && req.method === "GET") {
      const wallet = configuredWallet();
      if (!wallet) json(res, 503, { error: "AI credits are not configured. Use your own provider key." });
      else json(res, 200, await wallet.balance(userId));
    } else if (route === "wallet/packs" && req.method === "GET") {
      const wallet = configuredWallet();
      if (!wallet) json(res, 503, { error: "Credit packs are not configured." });
      // Prices come from the Router catalog; the PayPal client id is public and sandbox-only here.
      else json(res, 200, { packs: (await wallet.packs()).packs, paypal: { clientId: process.env.CONFNOTE_PAYPAL_CLIENT_ID || null, environment: "sandbox" } });
    } else if (route === "wallet/usage" && req.method === "GET") {
      const wallet = configuredWallet();
      const cursor = typeof req.query?.cursor === "string" ? req.query.cursor : undefined;
      if (!wallet) json(res, 503, { error: "AI credits are not configured." });
      else if (cursor !== undefined && !CURSOR_RE.test(cursor)) json(res, 400, { error: "Invalid cursor." });
      else json(res, 200, usageRows(await wallet.usage(userId, cursor)));
    } else if (route === "wallet/checkout" && req.method === "POST") {
      const wallet = configuredWallet();
      const origin = publicOrigin();
      const sku = req.body?.sku;
      const consent = req.body?.consent;
      if (!wallet || !origin) json(res, 503, { error: "Credit packs are not configured." });
      else if (typeof sku !== "string" || !SKU_RE.test(sku)) json(res, 400, { error: "Choose a credit pack." });
      else if (consent?.accepted !== true || typeof consent.at !== "string" || Number.isNaN(Date.parse(consent.at))) json(res, 400, { error: "Confirm that credits are delivered now and are non-refundable." });
      else {
        // The Router's checkout schema is strict, so consent is recorded web-side, BEFORE any order exists:
        // a failed write throws here and no order is created. Capture later requires the order's record.
        const storage = createStorage();
        const attemptId = randomUUID();
        const record = { userId, attemptId, sku, consentText: CREDITS_CONSENT_TEXT, acceptedAt: new Date(consent.at).toISOString(), recordedAt: new Date().toISOString() };
        await storage.writeText(consentKey(userId, "attempts", attemptId), JSON.stringify(record));
        // The browser names only the pack; the Router prices it and owns the PayPal order. A card saved for
        // auto top-up goes through PayPal Card Fields: the order has no approve page, the browser confirms the card.
        const saveForAutoTopUp = req.body?.saveForAutoTopUp === true;
        const card = saveForAutoTopUp && req.body?.paymentSource === "card";
        const order = await wallet.checkout({ userId, idempotencyKey: attemptId, sku, returnUrl: `${origin}/?wallet=return`, cancelUrl: `${origin}/?wallet=cancel`, ...(saveForAutoTopUp ? { saveForAutoTopUp: true } : {}), ...(card ? { paymentSource: "card" as const } : {}) });
        const approveOk = card ? order.approveUrl === undefined || isPaypalApproveUrl(order.approveUrl) : isPaypalApproveUrl(order.approveUrl);
        if (!ORDER_RE.test(order.orderId) || !approveOk) throw new WalletError(502, { error: "invalid_order" });
        await storage.writeText(consentKey(userId, "orders", order.orderId), JSON.stringify({ ...record, orderId: order.orderId }));
        json(res, 200, order);
      }
    } else if (route === "wallet/autotopup") {
      const wallet = configuredWallet();
      const { enabled, sku, monthlyCapUsdMicros } = req.body || {};
      if (!wallet) json(res, 503, { error: "AI credits are not configured." });
      else if (req.method === "GET") json(res, 200, await wallet.autoTopUp(userId));
      else if (req.method !== "POST") method(res);
      else if (typeof enabled !== "boolean" || typeof sku !== "string" || !SKU_RE.test(sku) || !Number.isSafeInteger(monthlyCapUsdMicros) || monthlyCapUsdMicros < 0) json(res, 400, { error: "Choose a pack and a monthly limit." });
      else json(res, 200, await wallet.setAutoTopUp({ userId, idempotencyKey: randomUUID(), enabled, sku, monthlyCapUsdMicros }));
    } else if (route === "wallet/capture" && req.method === "POST") {
      const wallet = configuredWallet();
      const orderId = req.body?.orderId;
      if (!wallet) json(res, 503, { error: "Credit packs are not configured." });
      else if (typeof orderId !== "string" || !ORDER_RE.test(orderId)) json(res, 400, { error: "Invalid order." });
      else if (!(await hasConsent(userId, orderId))) json(res, 403, { error: "This order has no recorded purchase consent. Start the purchase again." });
      else json(res, 200, await wallet.capture({ userId, idempotencyKey: `capture-${orderId}`, orderId }));
    } else if (route === "tracking" && req.method === "GET") json(res, 200, await repo.tracking(userId));
    else if ((route === "tracking" || route === "going") && req.method === "POST") {
      const { eventId, status } = req.body || {};
      const event = (await readCatalogue()).events.find((item) => item.id === eventId);
      if (!event) { json(res, 404, { error: "Event not found." }); return true; }
      if (route === "going" || status === "going") {
        const workspace = await repo.eventWorkspace(userId, event.id, event.name);
        const agenda: AgendaData = { schema_version: "confnote.agenda.v2", conference: { name: event.name, date: localDay(event.start, event.timezone), timezone: event.timezone || undefined }, events: [] };
        const slug = `${agenda.conference.date}-${slugify(agenda.conference.name)}`;
        const owned = { ...ctx, workspace: workspace.id, allocateConference: undefined };
        const existing = await conferencePayload(owned, slug);
        const result = existing ? { ok: true, slug, created: 0, skipped: existing.events.length, workspaceId: workspace.id } : await addConference(owned, { agenda });
        await repo.track(userId, event.id, "going");
        json(res, 201, { workspace, ...result, url: `/?workspace=${workspace.id}#/${"slug" in result ? result.slug : ""}` });
      } else {
        if (status !== null && !["interested", "attended"].includes(status)) { json(res, 400, { error: "Invalid tracking status." }); return true; }
        await repo.track(userId, event.id, status); json(res, 200, { ok: true });
      }
    } else if (route === "vault/export" && req.method === "GET") {
      res.setHeader("Content-Disposition", 'attachment; filename="confnote-vault.json"');
      json(res, 200, await exportVault(createStorage(), ctx.workspace));
    } else if (route === "vault/import" && req.method === "POST") {
      const bundle = validateBundle(req.body);
      const agendas = Object.keys(bundle.files).filter((name) => name.endsWith("/agenda.json"));
      if (agendas.length !== 1) throw new Error("Import one conference per workspace");
      const eventId = `vault-${createHash("sha256").update(JSON.stringify(bundle)).digest("hex").slice(0, 32)}`;
      const agenda = JSON.parse(bundle.files[agendas[0]]) as AgendaData;
      const workspace = await repo.eventWorkspace(userId, eventId, agenda.conference.name);
      const count = await importVault(createStorage(), workspace.id, bundle);
      json(res, 201, { workspace, files: count, url: `/?workspace=${workspace.id}` });
    } else method(res);
  } catch (error) {
    if (error instanceof WalletError && (route.startsWith("wallet/"))) json(res, error.status === 409 ? 409 : 502, { error: "The payment could not be completed. Try again." });
    else if (error instanceof WorkspaceLimitError) json(res, 402, { error: error.message, upgradeRequired: true });
    else json(res, 400, { error: "Unable to complete this action. Check the input and try again." });
  }
  return true;
}
