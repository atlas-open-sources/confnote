import { afterEach, describe, expect, it, vi } from "vitest";
import { streamText, wrapLanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider";
import { WalletError, type Wallet } from "../../billing/src/index.js";
import { walletMiddleware } from "../lib/wallet-model.js";
const usage: LanguageModelV3Usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "fixture" }] }];
function fixture() {
  let charged = 0;
  const background: Promise<unknown>[] = [];
  const reserve = vi.fn(async () => ({ holdId: "hold", reserved: 100, expiresAt: "2099-01-01", priceBookId: "book", priceBookVersion: 1, expiryPolicy: "capture" as const, unit: "usd_micros" as const }));
  const settle = vi.fn(async (input: Parameters<Wallet["settle"]>[0]) => {
    charged = input.settlementKind === "estimated" ? 100 : input.usage.inputTokens + input.usage.outputTokens;
    return { holdId: "hold", charged, released: 100 - charged, uncharged: 0, unit: "usd_micros" as const };
  });
  const release = vi.fn(async () => ({ holdId: "hold", released: 100, unit: "usd_micros" as const }));
  const wallet: Wallet = { reserve, settle, release, balance: vi.fn() };
  const options = { retain: (promise: Promise<unknown>) => background.push(promise), sleep: vi.fn(async () => {}), reportFailure: vi.fn(), timeoutMs: 1000 };
  let controller!: ReadableStreamDefaultController<LanguageModelV3StreamPart>;
  const source = new ReadableStream<LanguageModelV3StreamPart>({ start(value) { controller = value; value.enqueue({ type: "stream-start", warnings: [] }); } });
  const model = new MockLanguageModelV3({ doStream: vi.fn(async () => ({ stream: source })) });
  const wrapped = wrapLanguageModel({ model, middleware: walletMiddleware(wallet, "user", "fixture", options) });
  return { wallet, reserve, settle, release, options, background, model, wrapped, controller, charged: () => charged };
}
afterEach(() => vi.useRealTimers());
describe("accepted model-call termination", () => {
  it("captures the held maximum when the consumer cancels", async () => {
    const f = fixture(); const response = await f.wrapped.doStream({ prompt }); const reader = response.stream.getReader(); await reader.read();
    await reader.cancel("client closed"); await Promise.all(f.background);
    expect(f.charged()).toBe(100); expect(f.release).not.toHaveBeenCalled();
    expect(f.settle).toHaveBeenCalledWith(expect.objectContaining({ settlementKind: "estimated", reason: "cancel" }));
  });
  it("captures on upstream stream errors", async () => {
    const f = fixture(); const response = await f.wrapped.doStream({ prompt }); const reader = response.stream.getReader(); await reader.read();
    f.controller.error(new Error("provider interrupted")); await expect(reader.read()).rejects.toThrow("interrupted"); await Promise.all(f.background);
    expect(f.charged()).toBe(100); expect(f.release).not.toHaveBeenCalled();
  });
  it("captures an explicit provider error chunk and terminates without waiting for EOF", async () => {
    const f = fixture(); const response = await f.wrapped.doStream({ prompt }); const reader = response.stream.getReader(); await reader.read();
    f.controller.enqueue({ type: "error", error: new Error("provider failed") });
    expect((await reader.read()).value?.type).toBe("error"); expect((await reader.read()).done).toBe(true);
    expect(f.charged()).toBe(100);
  });
  it("charges reported usage on completion and does not charge twice on later cancellation", async () => {
    const f = fixture(); const response = await f.wrapped.doStream({ prompt }); const reader = response.stream.getReader(); await reader.read();
    f.controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage }); await reader.read(); await reader.cancel();
    expect(f.charged()).toBe(12); expect(f.settle).toHaveBeenCalledTimes(1);
    expect(f.settle).toHaveBeenCalledWith(expect.objectContaining({ settlementKind: "actual", reason: "finish" }));
  });
  it("captures a stalled provider on the independent deadline", async () => {
    vi.useFakeTimers(); const f = fixture(); const response = await f.wrapped.doStream({ prompt }); const reader = response.stream.getReader(); await reader.read();
    const rejected = expect(reader.read()).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(1000); await rejected; await Promise.all(f.background);
    expect(f.charged()).toBe(100); expect(f.settle).toHaveBeenCalledWith(expect.objectContaining({ reason: "timeout" }));
  });
  it("captures when the real AI SDK stream is aborted mid-answer", async () => {
    const f = fixture(); const abort = new AbortController();
    const result = streamText({ model: f.wrapped, prompt: "fixture", abortSignal: abort.signal, maxRetries: 0, onError: () => {} });
    const reading = (async () => { for await (const _chunk of result.fullStream) { /* drain the actual SDK */ } })();
    f.controller.enqueue({ type: "text-start", id: "text" }); f.controller.enqueue({ type: "text-delta", id: "text", delta: "partial" });
    await result.textStream.getReader().read(); abort.abort(new DOMException("Client disconnected", "AbortError"));
    await reading; await Promise.all(f.background);
    expect(f.charged()).toBe(100); expect(f.release).not.toHaveBeenCalled();
  });
  it("retains settlement in waitUntil and retries the exact idempotency payload", async () => {
    const f = fixture(); f.settle.mockRejectedValueOnce(new WalletError(503, { error: "unavailable" }));
    const response = await f.wrapped.doStream({ prompt }); const reader = response.stream.getReader(); await reader.read(); await reader.cancel();
    expect(f.background).toHaveLength(1); await Promise.all(f.background);
    expect(f.charged()).toBe(100); expect(f.settle).toHaveBeenCalledTimes(2);
    expect(f.settle.mock.calls[0][0]).toEqual(f.settle.mock.calls[1][0]);
  });
  it("bounds failed settlement retries while retaining a redacted failure receipt", async () => {
    const f = fixture(); const failure = new WalletError(503, { error: "unavailable" }); f.settle.mockRejectedValue(failure);
    const response = await f.wrapped.doStream({ prompt }); const reader = response.stream.getReader(); await reader.read();
    await expect(reader.cancel()).rejects.toBe(failure); await Promise.all(f.background);
    expect(f.settle).toHaveBeenCalledTimes(3); expect(f.release).not.toHaveBeenCalled();
    expect(f.options.reportFailure).toHaveBeenCalledWith(failure);
    expect(new Set(f.settle.mock.calls.map(([input]) => input.idempotencyKey)).size).toBe(1);
  });
  it("fails closed before provider execution when expiry capture is not confirmed", async () => {
    const f = fixture(); f.reserve.mockResolvedValueOnce({ holdId: "legacy", reserved: 100, expiresAt: "2099-01-01", priceBookId: "book", priceBookVersion: 1, expiryPolicy: undefined as unknown as "capture", unit: "usd_micros" });
    await expect(f.wrapped.doStream({ prompt })).rejects.toMatchObject({ status: 503 });
    expect(f.model.doStreamCalls).toHaveLength(0); expect(f.release).toHaveBeenCalledTimes(1); expect(f.charged()).toBe(0);
  });
  it("charges a complete partial-usage report accompanying an error", async () => {
    const f = fixture(); const response = await f.wrapped.doStream({ prompt }); const reader = response.stream.getReader(); await reader.read();
    const partial = { type: "error" as const, error: new Error("interrupted with usage"), usage };
    f.controller.enqueue(partial); await reader.read();
    expect(f.charged()).toBe(12); expect(f.settle).toHaveBeenCalledWith(expect.objectContaining({ settlementKind: "actual", reason: "error" }));
  });
  it("captures a truncated stream that closes without a usage record", async () => {
    const f = fixture(); const response = await f.wrapped.doStream({ prompt }); const reader = response.stream.getReader(); await reader.read(); f.controller.close();
    expect((await reader.read()).done).toBe(true); expect(f.charged()).toBe(100);
  });
  it("captures a provider handshake timeout even if the provider ignores abort", async () => {
    vi.useFakeTimers(); const f = fixture();
    let entered!: () => void; const called = new Promise<void>((resolve) => { entered = resolve; });
    const model = new MockLanguageModelV3({ doGenerate: async () => { entered(); return new Promise(() => {}); } });
    const wrapped = wrapLanguageModel({ model, middleware: walletMiddleware(f.wallet, "user", "fixture", f.options) });
    const rejected = expect(wrapped.doGenerate({ prompt })).rejects.toMatchObject({ name: "TimeoutError" });
    await called; await vi.advanceTimersByTimeAsync(1000); await rejected; await Promise.all(f.background);
    expect(f.charged()).toBe(100); expect(f.settle).toHaveBeenCalledWith(expect.objectContaining({ reason: "timeout" }));
  });
  it("releases only a positively rejected request; ambiguous transport failures capture", async () => {
    for (const rejected of [true, false]) {
      const f = fixture(); const error = rejected ? Object.assign(new Error("unauthorized"), { statusCode: 401 }) : new Error("connection lost after send");
      const model = new MockLanguageModelV3({ doStream: async () => { throw error; } });
      const wrapped = wrapLanguageModel({ model, middleware: walletMiddleware(f.wallet, "user", "fixture", f.options) });
      await expect(wrapped.doStream({ prompt })).rejects.toThrow();
      expect(f.charged()).toBe(rejected ? 0 : 100); expect(f.release).toHaveBeenCalledTimes(rejected ? 1 : 0);
    }
  });
  it("settles non-streaming results and captures ambiguous generate failures", async () => {
    for (const fails of [false, true]) {
      const f = fixture(); const model = new MockLanguageModelV3({ doGenerate: async () => { if (fails) throw new Error("timeout after send"); return { content: [{ type: "text", text: "answer" }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }; } });
      const wrapped = wrapLanguageModel({ model, middleware: walletMiddleware(f.wallet, "user", "fixture", f.options) });
      if (fails) await expect(wrapped.doGenerate({ prompt })).rejects.toThrow(); else await wrapped.doGenerate({ prompt });
      expect(f.charged()).toBe(fails ? 100 : 12);
    }
  });
});
