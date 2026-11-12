import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import type { Principal } from "../../auth/src/index.js";
import type { ChatOwner, ChatRole, ChatThreadList, ChatThreadMeta, ChatThreadStore, ChatTurn } from "../lib/chat-threads.js";

const spies = vi.hoisted(() => ({ direct: vi.fn() }));
vi.mock("../lib/byok.js", async (original) => ({ ...await original<typeof import("../lib/byok.js")>(), directLanguageModel: spies.direct }));

interface Thread { id: string; owner: string; turns: ChatTurn[]; archivedAt: number | null }
/** The route contract over an in-memory store; the SQL store has its own tests (chat-threads.test.ts). */
class MemoryThreads implements ChatThreadStore {
  threads: Thread[] = [];
  private tick = 0;
  private key(owner: ChatOwner): string { return `${owner.workspaceId}|${owner.userId}`; }
  private active(owner: ChatOwner): Thread | undefined { return this.threads.find((t) => t.owner === this.key(owner) && t.archivedAt === null); }
  private meta(thread: Thread): ChatThreadMeta {
    return { id: thread.id, ts: String(thread.archivedAt ?? 0), title: thread.turns.find((t) => t.role === "user")?.text || "(empty thread)", turns: thread.turns.length, scope: thread.turns.at(-1)?.scope || "" };
  }
  async append(owner: ChatOwner, role: ChatRole, text: string, scope: string): Promise<void> {
    let thread = this.active(owner);
    if (!thread) { thread = { id: randomUUID(), owner: this.key(owner), turns: [], archivedAt: null }; this.threads.push(thread); }
    thread.turns.push({ ts: new Date().toISOString(), role, text: text.trim(), scope });
  }
  async history(owner: ChatOwner, limit = 500): Promise<ChatTurn[]> { return (this.active(owner)?.turns || []).slice(-limit); }
  async list(owner: ChatOwner): Promise<ChatThreadList> {
    const active = this.active(owner);
    const archived = this.threads.filter((t) => t.owner === this.key(owner) && t.archivedAt !== null).sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
    return { active: active ? this.meta(active) : null, archived: archived.map((t) => this.meta(t)) };
  }
  async archive(owner: ChatOwner): Promise<ChatThreadMeta | null> {
    const active = this.active(owner);
    if (!active) return null;
    active.archivedAt = ++this.tick;
    return this.meta(active);
  }
  async resume(owner: ChatOwner, id: string): Promise<ChatThreadMeta | null> {
    const target = this.threads.find((t) => t.id === id && t.owner === this.key(owner) && t.archivedAt !== null);
    if (!target) return null;
    await this.archive(owner);
    target.archivedAt = null;
    return this.meta(target);
  }
}

function principal(userId: string, workspaceId: string): Principal {
  return { userId, workspaceId, email: `${userId}@example.test`, emailVerified: true, role: "owner", authMethod: "email_code", sessionId: `session-${userId}` };
}

function replyModel(text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({ doStream: async () => ({ stream: new ReadableStream({ start(controller) {
    controller.enqueue({ type: "stream-start", warnings: [] }); controller.enqueue({ type: "text-start", id: "text" }); controller.enqueue({ type: "text-delta", id: "text", delta: text }); controller.enqueue({ type: "text-end", id: "text" }); controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } }); controller.close();
  } }) }) });
}

let root = "";
let store: MemoryThreads;
let who: Principal | null;
let call: (method: string, route: string, query?: Record<string, string>, body?: unknown) => Promise<{ status: number; output: string }>;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "confnote-chat-threads-"));
  vi.stubEnv("CONFNOTE_STORAGE", "fs"); vi.stubEnv("CONFNOTE_WEB_DATA_DIR", root); vi.stubEnv("CONFNOTE_PUBLIC_DEMO", "0"); vi.stubEnv("CONFNOTE_PUBLIC_BASE_URL", "https://fixture.test"); vi.stubEnv("CONFNOTE_DATABASE_URL", ""); vi.stubEnv("CONFNOTE_WEB_AGENT_ENABLED", "1");
  vi.resetModules();
  store = new MemoryThreads();
  who = principal("alice", "ws-alice");
  const { createHandler } = await import("../api/index.js");
  const handler = createHandler({ principal: async () => who, chatThreads: () => store });
  call = async (method, route, query = {}, body = undefined) => {
    const search = new URLSearchParams(query).toString();
    // A real IncomingMessage is async-iterable; an empty one stands for a POST with no body (chat.js "+" and resume).
    const req = Object.assign(new EventEmitter(), { method, url: `/api/${route}${search ? `?${search}` : ""}`, query, headers: { origin: "https://fixture.test", "content-type": "application/json" }, body, async *[Symbol.asyncIterator]() {} });
    let output = ""; let status = 200;
    const res = Object.assign(new EventEmitter(), { destroyed: false, status(code: number) { status = code; return this; }, setHeader() { return this; }, write(text: string) { output += text; return true; }, end() { return this; }, json(value: unknown) { output += JSON.stringify(value); return this; } });
    await handler(req as unknown as Parameters<typeof handler>[0], res as unknown as Parameters<typeof handler>[1]);
    return { status, output };
  };
});
afterEach(async () => { vi.unstubAllEnvs(); vi.clearAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

const byok = { provider: "openai", apiKey: "synthetic-fixture-key", model: "fixture-model" }; // pragma: allowlist secret

describe("web Concierge chat threads", () => {
  it("saves both turns of a chat, gives the model the stored thread, and lists, archives and resumes it", async () => {
    const first = replyModel("Day two has agent talks.");
    spies.direct.mockReturnValue(first);
    const sent = await call("POST", "chat/global", { slug: "conf-a" }, { byok, messages: [{ role: "user", text: "What is on day two?" }] });
    expect(sent.output).toContain("Day two has agent talks.");
    expect(JSON.parse((await call("GET", "chat/history", { limit: "200" })).output)).toMatchObject({ history: [
      { role: "user", text: "What is on day two?", scope: "conf-a" },
      { role: "assistant", text: "Day two has agent talks.", scope: "conf-a" },
    ] });

    // The reopened Concierge sends only its new message (or a hydrated transcript): the model gets the stored thread once.
    const second = replyModel("Yes, after lunch.");
    spies.direct.mockReturnValue(second);
    await call("POST", "chat/global", { slug: "conf-a" }, { byok, messages: [{ role: "user", text: "What is on day two?" }, { role: "ai", text: "Day two has agent talks." }, { role: "user", text: "Any after lunch?" }] });
    const prompt = second.doStreamCalls[0].prompt.filter((message) => message.role !== "system");
    expect(prompt.map((message) => [message.role, JSON.stringify(message.content)])).toEqual([
      ["user", expect.stringContaining("What is on day two?")],
      ["assistant", expect.stringContaining("Day two has agent talks.")],
      ["user", expect.stringContaining("Any after lunch?")],
    ]);

    const listed = JSON.parse((await call("GET", "chat/threads")).output);
    expect(listed).toMatchObject({ active: { title: "What is on day two?", turns: 4, scope: "conf-a" }, archived: [] });

    const archived = JSON.parse((await call("POST", "chat/archive")).output);
    expect(archived).toMatchObject({ archived: { id: listed.active.id, turns: 4 }, active: null });
    expect(JSON.parse((await call("GET", "chat/history")).output)).toEqual({ history: [] });

    spies.direct.mockReturnValue(replyModel("Fresh start."));
    await call("POST", "chat/global", {}, { byok, messages: [{ role: "user", text: "New topic" }] });
    const resumed = await call("POST", "chat/resume", { id: listed.active.id });
    expect(resumed.status).toBe(200);
    expect(JSON.parse(resumed.output)).toMatchObject({ active: { id: listed.active.id, turns: 4 } });
    const after = JSON.parse((await call("GET", "chat/threads")).output);
    expect(after.active.id).toBe(listed.active.id);
    expect(after.archived.map((thread: { title: string }) => thread.title)).toEqual(["New topic"]);
    expect((await call("POST", "chat/resume", { id: "missing" })).status).toBe(404);
  });

  it("scopes every route to the session's person and workspace, never another user's threads", async () => {
    spies.direct.mockReturnValue(replyModel("Private answer."));
    await call("POST", "chat/global", { slug: "conf-a" }, { byok, messages: [{ role: "user", text: "Alice secret" }] });
    const aliceThread = JSON.parse((await call("POST", "chat/archive")).output).archived;

    who = principal("bob", "ws-bob");
    expect(JSON.parse((await call("GET", "chat/threads")).output)).toEqual({ active: null, archived: [] });
    expect(JSON.parse((await call("GET", "chat/history")).output)).toEqual({ history: [] });
    expect((await call("POST", "chat/resume", { id: aliceThread.id })).status).toBe(404);

    // Same person, other workspace: also separate.
    who = principal("alice", "ws-team");
    expect(JSON.parse((await call("GET", "chat/threads")).output)).toEqual({ active: null, archived: [] });

    who = principal("alice", "ws-alice");
    expect(JSON.parse((await call("GET", "chat/threads")).output).archived.map((thread: { id: string }) => thread.id)).toEqual([aliceThread.id]);
  });

  it("keeps the client transcript as context and replies normally when the store fails", async () => {
    const broken = new MemoryThreads();
    broken.append = async () => { throw new Error("db down"); };
    store = broken;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const model = replyModel("Still here.");
      spies.direct.mockReturnValue(model);
      const sent = await call("POST", "chat/global", {}, { byok, messages: [{ role: "user", text: "Earlier" }, { role: "ai", text: "Answer" }, { role: "user", text: "Now" }] });
      expect(sent.output).toContain("Still here."); expect(sent.output).toContain('"done":true');
      expect(model.doStreamCalls[0].prompt.filter((message) => message.role !== "system")).toHaveLength(3);
      expect(warn).toHaveBeenCalledWith("chat_history_write_failed");
    } finally { warn.mockRestore(); }
  });

  it("keeps no server history for the public demo", async () => {
    vi.stubEnv("CONFNOTE_PUBLIC_DEMO", "1");
    vi.resetModules();
    const { createHandler } = await import("../api/index.js");
    const used = vi.fn(() => store);
    const handler = createHandler({ principal: async () => who, chatThreads: used });
    for (const [method, route] of [["GET", "chat/threads"], ["GET", "chat/history"], ["POST", "chat/archive"]]) {
      let output = "";
      const req = Object.assign(new EventEmitter(), { method, url: `/api/${route}`, query: {}, headers: { origin: "https://fixture.test" }, body: undefined, async *[Symbol.asyncIterator]() {} });
      const res = Object.assign(new EventEmitter(), { destroyed: false, status() { return this; }, setHeader() { return this; }, write(text: string) { output += text; return true; }, end() { return this; }, json(value: unknown) { output += JSON.stringify(value); return this; } });
      await handler(req as unknown as Parameters<typeof handler>[0], res as unknown as Parameters<typeof handler>[1]);
      expect(output).not.toContain("error");
    }
    expect(used).not.toHaveBeenCalled();
    expect(store.threads).toEqual([]);
  });
});
