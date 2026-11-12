import { reserveModelCall, knownPreAcceptanceRejection } from "./model-call.js";
export interface Entitlements { plan: "free" | "pro"; workspaceLimit: number | null }
export function entitlements(plan: "free" | "pro"): Entitlements { return { plan, workspaceLimit: plan === "pro" ? null : 2 }; }
export interface Usage { inputTokens: number; outputTokens: number; cachedInputTokens?: number; cacheWriteTokens?: number }
export interface Balance { balance: number; reserved: number; available: number; buyMoreUrl: string; unit: "usd_micros" }
export interface Reservation { holdId: string; reserved: number; expiresAt: string; priceBookId: string; priceBookVersion: number; expiryPolicy?: "capture" | "release"; unit: "usd_micros" }
export interface Settlement { holdId: string; charged: number; released: number; uncharged: number; unit: "usd_micros" }
export interface InsufficientCredits { error: "insufficient_credits"; buyMoreUrl: string; available: number; required: number; unit: "usd_micros" }
export class WalletError extends Error { constructor(readonly status: number, readonly body: unknown) { super(status === 402 ? "Insufficient credits" : "Wallet request failed"); } }
export interface Wallet {
  balance(userId: string): Promise<Balance>;
  reserve(input: { userId: string; idempotencyKey: string; modelId: string; usage: Usage }): Promise<Reservation>;
  settle(input: { userId: string; idempotencyKey: string; holdId: string; usage: Usage; settlementKind?: "actual" | "estimated"; reason?: "finish" | "cancel" | "error" | "timeout" | "unknown" }): Promise<Settlement>;
  release(input: { userId: string; idempotencyKey: string; holdId: string }): Promise<{ holdId: string; released: number; unit: "usd_micros" }>;
}
/** Router credit-pack checkout (PayPal on the Router side). The amount always comes from the Router catalog. */
/** A card order (PayPal Card Fields) has no approve page: the browser confirms the card against the order id. */
export interface CheckoutStart { provider: string; orderId: string; approveUrl?: string; sku: string; credits: string; price: { amountMinor: string; currency: string } }
export interface CreditPack { sku: string; credits: string; price: { amountMinor: string; currency: string } }
export interface UsageItem { at: string; kind: string; modelId?: string; inputTokens?: number; outputTokens?: number; amount: { usdMicros: number }; balanceAfter?: number; ref: string }
export interface UsagePage { items: UsageItem[]; next?: string }
export interface CheckoutCapture { status: "captured" | "not_captured"; paymentIds: (string | undefined)[]; savedForAutoTopUp?: boolean }
/** What the Router shows about auto top-up; provider tokens and customer ids never leave the Router. */
export interface AutoTopUpStatus { enabled: boolean; sku: string | null; monthlyCapUsdMicros: number; savedMethod?: { provider: string; method: string } | null; month?: string; spentUsdMicros?: number }
export interface WalletCheckout {
  packs(): Promise<{ packs: CreditPack[] }>;
  usage(userId: string, cursor?: string): Promise<UsagePage>;
  checkout(input: { userId: string; idempotencyKey: string; sku: string; returnUrl: string; cancelUrl: string; saveForAutoTopUp?: boolean; paymentSource?: "card" }): Promise<CheckoutStart>;
  capture(input: { userId: string; idempotencyKey: string; orderId: string }): Promise<CheckoutCapture>;
  autoTopUp(userId: string): Promise<AutoTopUpStatus>;
  setAutoTopUp(input: { userId: string; idempotencyKey: string; enabled: boolean; sku: string; monthlyCapUsdMicros: number }): Promise<AutoTopUpStatus>;
}
export class RouterWallet implements Wallet, WalletCheckout {
  constructor(private readonly origin: string, private readonly credential: string, private readonly fetcher: typeof fetch = fetch) {
    const url = new URL(origin);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("Wallet must use HTTPS or local test HTTP");
    if (url.username || url.password || url.search || url.hash) throw new Error("Invalid wallet origin");
  }
  private async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await this.fetcher(`${this.origin.replace(/\/$/, "")}/v1/wallet/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${this.credential}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000), redirect: "error",
    });
    const payload: unknown = await response.json();
    if (!response.ok) throw new WalletError(response.status, payload);
    return payload as T;
  }
  balance(userId: string): Promise<Balance> { return this.request(`balance?userId=${encodeURIComponent(userId)}`); }
  reserve(input: Parameters<Wallet["reserve"]>[0]): Promise<Reservation> { return this.request("reserve", input); }
  settle(input: Parameters<Wallet["settle"]>[0]): Promise<Settlement> { return this.request("settle", input); }
  release(input: Parameters<Wallet["release"]>[0]): ReturnType<Wallet["release"]> { return this.request("release", input); }
  packs(): Promise<{ packs: CreditPack[] }> { return this.request("packs"); }
  usage(userId: string, cursor?: string): Promise<UsagePage> {
    // The Router pages with `before` (its opaque keyset cursor from `next`).
    const query = new URLSearchParams({ userId, ...(cursor ? { before: cursor } : {}) });
    return this.request(`usage?${query}`);
  }
  checkout(input: Parameters<WalletCheckout["checkout"]>[0]): Promise<CheckoutStart> { return this.request("checkout", input); }
  capture(input: Parameters<WalletCheckout["capture"]>[0]): Promise<CheckoutCapture> { return this.request("checkout/capture", input); }
  autoTopUp(userId: string): Promise<AutoTopUpStatus> { return this.request(`autotopup?userId=${encodeURIComponent(userId)}`); }
  setAutoTopUp(input: Parameters<WalletCheckout["setAutoTopUp"]>[0]): Promise<AutoTopUpStatus> { return this.request("autotopup/policy", input); }
}
/** Separate capture-policy reservation for each provider call; ambiguous failures capture. */
export async function walletStep<T>(wallet: Wallet, input: { userId: string; modelId: string; usage: Usage; idempotencyKey: string }, call: () => Promise<{ value: T; usage: Usage }>): Promise<T> {
  const reservation = await reserveModelCall(wallet, input);
  let usage: Usage | undefined;
  let rejected = false;
  try {
    const result = await call(); usage = result.usage; return result.value;
  } catch (error) {
    rejected = knownPreAcceptanceRejection(error); throw error;
  } finally {
    if (rejected) await reservation.release();
    else await reservation.settle(usage ? "finish" : "error", usage);
  }
}
