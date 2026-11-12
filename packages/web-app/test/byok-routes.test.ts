import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
const spies = vi.hoisted(() => ({ direct: vi.fn(), metered: vi.fn(() => { throw new Error("wallet must not be used"); }) }));
vi.mock("../lib/byok.js", async (original) => ({ ...await original<typeof import("../lib/byok.js")>(), directLanguageModel: spies.direct }));
vi.mock("../lib/wallet-model.js", async (original) => ({ ...await original<typeof import("../lib/wallet-model.js")>(), meteredModel: spies.metered }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it.each(["global", "session"])("real web /api/chat/%s sends BYOK directly and never creates a wallet model", async (route) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "confnote-byok-route-"));
  vi.stubEnv("CONFNOTE_STORAGE", "fs"); vi.stubEnv("CONFNOTE_WEB_DATA_DIR", root); vi.stubEnv("CONFNOTE_PUBLIC_DEMO", "0"); vi.stubEnv("CONFNOTE_PUBLIC_BASE_URL", "https://fixture.test"); vi.stubEnv("CONFNOTE_DATABASE_URL", ""); vi.stubEnv("CONFNOTE_WEB_AGENT_ENABLED", "1");
  vi.resetModules();
  try {
    const { createHandler } = await import("../api/index.js");
    const { addConference } = await import("../lib/service.js");
    const workspace = "byok-fixture";
    const imported = await addConference({ workspace }, { conference: { name: "Fixture", date: "2099-01-01" }, events: [] });
    if (!("slug" in imported)) throw new Error("fixture import failed");
    const model = new MockLanguageModelV3({ doStream: async () => ({ stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] }); controller.enqueue({ type: "text-start", id: "text" }); controller.enqueue({ type: "text-delta", id: "text", delta: "Direct fixture answer" }); controller.enqueue({ type: "text-end", id: "text" }); controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } }); controller.close();
    } }) }) });
    spies.direct.mockReturnValue(model);
    const handler = createHandler({ principal: async () => ({ userId: "internal-user", workspaceId: workspace, email: "fixture@example.test", emailVerified: true, role: "owner", authMethod: "email_code", sessionId: "fixture-session" }) });
    const byok = { provider: "openai", apiKey: "synthetic-fixture-key", model: "fixture-model" }; // pragma: allowlist secret
    const req = Object.assign(new EventEmitter(), { method: "POST", url: `/api/chat/${route}?slug=${imported.slug}`, query: { slug: imported.slug }, headers: { origin: "https://fixture.test", "content-type": "application/json" }, body: { byok, messages: [{ role: "user", text: "Say hello" }] } });
    let output = ""; let status = 200;
    const res = Object.assign(new EventEmitter(), { destroyed: false, status(code: number) { status = code; return this; }, setHeader() { return this; }, write(text: string) { output += text; return true; }, end() { return this; }, json(value: unknown) { output += JSON.stringify(value); return this; } });
    await handler(req as unknown as Parameters<typeof handler>[0], res as unknown as Parameters<typeof handler>[1]);
    expect(status).toBe(200); expect(output).toContain("Direct fixture answer"); expect(output).toContain('"done":true');
    expect(spies.direct).toHaveBeenCalledWith(byok); expect(spies.metered).not.toHaveBeenCalled(); expect(model.doStreamCalls).toHaveLength(1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {}); const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const privateError = Object.assign(new Error("private provider detail"), { statusCode: 401, requestBodyValues: { notes: "sensitive-note-fixture" }, responseBody: "masked-key-fixture" });
      spies.direct.mockReturnValue(new MockLanguageModelV3({ doStream: async () => ({ stream: new ReadableStream({ start(controller) { controller.enqueue({ type: "error", error: privateError }); controller.close(); } }) }) }));
      output = ""; await handler(req as unknown as Parameters<typeof handler>[0], res as unknown as Parameters<typeof handler>[1]);
      expect(errorLog).not.toHaveBeenCalled(); expect(warn).toHaveBeenCalledWith("model_request_failed", { status: 401 });
      expect(JSON.stringify(warn.mock.calls) + output).not.toContain("sensitive-note-fixture");
      expect(JSON.stringify(warn.mock.calls) + output).not.toContain("masked-key-fixture");
      expect(spies.metered).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); errorLog.mockRestore(); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
