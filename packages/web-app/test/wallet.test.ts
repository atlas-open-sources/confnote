import { expect, it, vi } from "vitest";
import { RouterWallet, WalletError, walletStep, type Wallet } from "../../billing/src/index.js";
import { actualUsage } from "../lib/wallet-model.js";
it("reserves separately for every model step, settles actual cache usage, and stops before the next call on 402", async () => {
  const calls: string[] = [];
  const reserve = vi.fn(async () => { calls.push("reserve"); if (calls.filter((value) => value === "reserve").length > 1) throw new WalletError(402, { buyMoreUrl: "https://pay.example.test" }); return { holdId: "hold", reserved: 100, expiresAt: "2099-01-01", priceBookId: "book", priceBookVersion: 1, expiryPolicy: "capture" as const, unit: "usd_micros" as const }; });
  const settle = vi.fn(async () => { calls.push("settle"); return { holdId: "hold", charged: 40, released: 60, uncharged: 0, unit: "usd_micros" as const }; });
  const wallet: Wallet = { reserve, settle, balance: vi.fn(), release: vi.fn() };
  const provider = vi.fn(async () => { calls.push("provider"); return { value: "step", usage: { inputTokens: 100, outputTokens: 5, cachedInputTokens: 30, cacheWriteTokens: 20 } }; });
  const input = { userId: "internal", modelId: "fixture", usage: { inputTokens: 1000, outputTokens: 100 }, idempotencyKey: "first" };
  expect(await walletStep(wallet, input, provider)).toBe("step");
  await expect(walletStep(wallet, { ...input, idempotencyKey: "second" }, provider)).rejects.toMatchObject({ status: 402 });
  expect(provider).toHaveBeenCalledTimes(1); expect(calls).toEqual(["reserve", "provider", "settle", "reserve"]);
  expect(settle).toHaveBeenCalledWith(expect.objectContaining({ usage: { inputTokens: 100, outputTokens: 5, cachedInputTokens: 30, cacheWriteTokens: 20 } }));
});
it("sends only the backend product credential to Router and propagates 402", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: "insufficient_credits", buyMoreUrl: "https://pay.example.test" }), { status: 402 }));
  const wallet = new RouterWallet("https://router.example.test", "fixture-service-credential", fetcher);
  await expect(wallet.balance("internal/id")).rejects.toMatchObject({ status: 402 });
  expect(fetcher.mock.calls[0]).toEqual(["https://router.example.test/v1/wallet/balance?userId=internal%2Fid", expect.objectContaining({ redirect: "error", headers: { Authorization: "Bearer fixture-service-credential", "Content-Type": "application/json" } })]);
});
it("uses total input and separate cached read/write without double counting", () => {
  expect(actualUsage({ inputTokens: { total: 100, noCache: 50, cacheRead: 30, cacheWrite: 20 }, outputTokens: { total: 8, text: 8, reasoning: 0 } })).toEqual({ inputTokens: 100, outputTokens: 8, cachedInputTokens: 30, cacheWriteTokens: 20 });
});
it("AI SDK middleware settles streamed usage before finish and propagates 402 without calling the model", async () => {
  const { MockLanguageModelV3 } = await import("ai/test");
  const { streamText, wrapLanguageModel } = await import("ai");
  const { walletMiddleware } = await import("../lib/wallet-model.js");
  const settle = vi.fn(async () => ({ holdId: "hold", charged: 10, released: 90, uncharged: 0, unit: "usd_micros" as const }));
  const reserve = vi.fn(async () => ({ holdId: "hold", reserved: 100, expiresAt: "2099-01-01", priceBookId: "book", priceBookVersion: 1, expiryPolicy: "capture" as const, unit: "usd_micros" as const }));
  const wallet: Wallet = { reserve, settle, balance: vi.fn(), release: vi.fn() };
  const model = new MockLanguageModelV3({ doStream: async () => ({ stream: new ReadableStream({ start(controller) { controller.enqueue({ type: "stream-start", warnings: [] }); controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 10, noCache: 5, cacheRead: 3, cacheWrite: 2 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } }); controller.close(); } }) }) });
  const wrapped = wrapLanguageModel({ model, middleware: walletMiddleware(wallet, "user", "fixture") });
  for await (const chunk of streamText({ model: wrapped, prompt: "fixture", maxRetries: 0 }).fullStream) {
    if (chunk.type === "finish") expect(settle).toHaveBeenCalledTimes(1);
  }
  expect(settle).toHaveBeenCalledWith(expect.objectContaining({ usage: { inputTokens: 10, outputTokens: 1, cachedInputTokens: 3, cacheWriteTokens: 2 } }));
  reserve.mockRejectedValueOnce(new WalletError(402, { buyMoreUrl: "https://pay.example.test" }));
  const errors: unknown[] = [];
  for await (const chunk of streamText({ model: wrapped, prompt: "next", maxRetries: 0, onError: () => {} }).fullStream) if (chunk.type === "error") errors.push(chunk.error);
  expect(model.doStreamCalls).toHaveLength(1);
  expect(errors[0]).toMatchObject({ status: 402 });
});
