import { request } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatOwner, ChatRole, ChatThreadStore, ChatTurn } from "../lib/chat-threads.js";

// The web Concierge on the Claude Agent SDK (CONFNOTE_CONCIERGE_ENGINE=agent-sdk) with the SDK mocked: which tools it
// gets and how they are scoped, the stored history as context, the chips, and a Router 402 as the buy-more card.
// test/agent-sdk-e2e.test.ts runs the real CLI against a fake Router.

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
interface CapturedTool { name: string; handler: Handler }
type Script = (options: Record<string, any>, prompt: string) => AsyncGenerator<Record<string, unknown>>;

const sdk = vi.hoisted(() => ({
  servers: [] as Array<{ tools: CapturedTool[] }>,
  calls: [] as Array<{ prompt: string; options: Record<string, any> }>,
  script: null as unknown as Script,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: Handler) => ({ name, description, inputSchema, handler }),
  createSdkMcpServer: (options: { name: string; tools: CapturedTool[] }) => {
    sdk.servers.push({ tools: options.tools });
    return { type: "sdk", name: options.name, instance: { tools: options.tools } };
  },
  query: ({ prompt, options }: { prompt: string; options: Record<string, any> }) => {
    sdk.calls.push({ prompt, options });
    return sdk.script(options, prompt);
  },
}));

const { addConference } = await import("../lib/service.js");
const { routerFailureEvent, streamWebChatEvents, topUpInFlight } = await import("../lib/chat.js");
const { agentSdkToolNames, cappedBody, mcpToolName, upstreamError, upstreamErrorKind, upstreamHeaders, zodShape } = await import("../lib/agent-sdk-concierge.js");

const WALLET_USER = "user_sdk";
const ENV_KEYS = ["CONFNOTE_CONCIERGE_ENGINE", "CONFNOTE_ROUTER_URL", "CONFNOTE_ROUTER_SERVICE_TOKEN", "CONFNOTE_WEB_AGENT_PROVIDER", "CONFNOTE_ROUTER_MESSAGES_URL"];
const saved: Record<string, string | undefined> = {};

function textEvent(text: string) {
  return { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } };
}

function toolHandler(name: string): Handler {
  const server = sdk.servers.at(-1);
  const found = server?.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`tool ${name} not served`);
  return found.handler;
}

async function workspace(name: string) {
  const ctx = { workspace: `sdk-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`, principal: { userId: WALLET_USER } };
  const imported = await addConference(ctx as never, {
    schema_version: "confnote.agenda.v1",
    conference: { name, date: "2099-05-03", timezone: "Europe/London" },
    events: [{ id: "k", type: "talk", title: `${name} keynote`, start: "2099-05-03T09:00:00+00:00", end: "2099-05-03T10:00:00+00:00" }],
  });
  if (!("slug" in imported)) throw new Error("agenda did not import");
  return { ctx, slug: imported.slug };
}

async function turn(ctx: unknown, slug: string, text: string, history?: { store: ChatThreadStore; owner: ChatOwner }) {
  const events: Array<Record<string, unknown>> = [];
  await streamWebChatEvents(ctx as never, { slug, body: { messages: [{ role: "user", text }] }, history }, (event) => {
    events.push(event as Record<string, unknown>);
  });
  return events;
}

/** Posts to the turn's loopback proxy the way the CLI does, with the key the SDK was given. */
function cliPost(options: Record<string, any>): Promise<number> {
  const url = new URL(`${options.env.ANTHROPIC_BASE_URL}/v1/messages`);
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", headers: { "x-api-key": options.env.ANTHROPIC_API_KEY, "content-type": "application/json" } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode || 0));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 32000, messages: [] }));
  });
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.CONFNOTE_CONCIERGE_ENGINE = "agent-sdk";
  process.env.CONFNOTE_WEB_AGENT_PROVIDER = "mochi-router";
  process.env.CONFNOTE_ROUTER_URL = "https://router.example.test";
  process.env.CONFNOTE_ROUTER_SERVICE_TOKEN = "svc-fixture"; // pragma: allowlist secret
  delete process.env.CONFNOTE_ROUTER_MESSAGES_URL;
  sdk.servers.length = 0;
  sdk.calls.length = 0;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.unstubAllGlobals();
});

describe("Agent SDK Concierge: tools", () => {
  it("serves the spec tools minus web_search, canvas only with the canvas, and only WebSearch as a built-in", async () => {
    expect(agentSdkToolNames(false)).toContain("import_conference_from_url");
    expect(agentSdkToolNames(false)).toContain("fetch_url");
    expect(agentSdkToolNames(false)).not.toContain("web_search");
    expect(agentSdkToolNames(false)).not.toContain("draw_mind_map");
    expect(agentSdkToolNames(true)).toContain("draw_mind_map");
    expect(agentSdkToolNames(false)).not.toContain("recall_history");

    const { ctx, slug } = await workspace("Scoped Conf");
    sdk.script = async function* () {
      yield textEvent("Hi.");
    };
    await turn(ctx, slug, "hello");
    const { options } = sdk.calls[0];
    expect(options.model).toBe("claude-opus-5-5");
    expect(options.tools).toEqual(["WebSearch"]);
    expect(options.allowedTools).toContain(mcpToolName("list_conferences"));
    expect(options.allowedTools).not.toContain("Bash");
    expect(options.settingSources).toEqual([]);
    expect(options.persistSession).toBe(false);
    expect(await options.canUseTool("Bash", { command: "ls" }, {})).toMatchObject({ behavior: "deny" });
    expect(await options.canUseTool("WebSearch", { query: "x" }, {})).toMatchObject({ behavior: "allow" });
    // The CLI never sees the function's secrets: the Router token is not in its environment.
    expect(options.env.CONFNOTE_ROUTER_SERVICE_TOKEN).toBeUndefined();
    expect(Object.values(options.env)).not.toContain("svc-fixture");
    expect(options.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("runs each tool in the session's own workspace and conference", async () => {
    const mine = await workspace("Mine Conf");
    await workspace("Theirs Conf");
    let listed = "";
    let conference = "";
    sdk.script = async function* () {
      listed = (await toolHandler("list_conferences")({}, {})).content[0].text;
      conference = (await toolHandler("get_conference")({}, {})).content[0].text;
      yield textEvent("Done.");
    };
    await turn(mine.ctx, mine.slug, "what do I have?");
    expect(listed).toContain("Mine Conf");
    expect(listed).not.toContain("Theirs Conf");
    expect(JSON.parse(conference).conference?.name || conference).toContain("Mine Conf");
  });

  it("shows a chip for a change a tool made", async () => {
    const { ctx, slug } = await workspace("Chip Conf");
    sdk.script = async function* () {
      const added = JSON.parse((await toolHandler("append_action")({ file: "INBOX.md", text: "Email Ada" }, {})).content[0].text);
      expect(added).toMatchObject({ ok: true });
      yield textEvent("Added.");
    };
    const events = await turn(ctx, slug, "add an action to email Ada");
    const notices = events.filter((event) => "notice" in event).map((event) => event.notice);
    expect(notices.some((notice) => String(notice).startsWith("Added action"))).toBe(true);
    expect(events.at(-1)).toEqual({ done: true });
  });

  it("maps the spec's JSON Schema to a zod shape with required and optional fields", () => {
    const shape = zodShape({ type: "object", properties: { url: { type: "string" }, limit: { type: "integer" } }, required: ["url"] });
    expect(shape.url.safeParse(undefined).success).toBe(false);
    expect(shape.limit.safeParse(undefined).success).toBe(true);
  });
});

describe("Agent SDK Concierge: history", () => {
  it("saves the user turn first, gives the stored thread as context, and saves the reply", async () => {
    const { ctx, slug } = await workspace("History Conf");
    const turns: ChatTurn[] = [
      { ts: "", role: "user", text: "My name is Ada.", scope: slug },
      { ts: "", role: "assistant", text: "Nice to meet you, Ada.", scope: slug },
    ];
    const store = {
      append: vi.fn(async (_owner: ChatOwner, role: ChatRole, text: string, scope: string) => {
        turns.push({ ts: "", role, text, scope });
      }),
      history: vi.fn(async () => turns.slice(-20)),
      list: vi.fn(),
      archive: vi.fn(),
      resume: vi.fn(),
    } as unknown as ChatThreadStore;
    sdk.script = async function* () {
      yield textEvent("Your name is Ada.");
    };
    await turn(ctx, slug, "What is my name?", { store, owner: { workspaceId: "w", userId: WALLET_USER } });
    const prompt = sdk.calls[0].prompt;
    expect(prompt).toContain("User: My name is Ada.");
    expect(prompt).toContain("Concierge: Nice to meet you, Ada.");
    expect(prompt.trim().endsWith("What is my name?")).toBe(true);
    expect(turns.map((entry) => [entry.role, entry.text])).toEqual([
      ["user", "My name is Ada."],
      ["assistant", "Nice to meet you, Ada."],
      ["user", "What is my name?"],
      ["assistant", "Your name is Ada."],
    ]);
  });
});

describe("Agent SDK Concierge: the Router", () => {
  it("a 402 from the Router becomes the buy-more card, never the CLI's API Error text", async () => {
    const { ctx, slug } = await workspace("Broke Conf");
    // The Router's /v1/messages refusal (contract a134894): Anthropic's envelope, the wallet detail under mochi.
    const refusal = { error: "insufficient_credits", available: 3, required: 900, buyMoreUrl: "https://example.test/buy", unit: "usd_micros", autoTopUp: "declined" };
    const envelope = { type: "error", error: { type: "billing_error", message: `You are out of credits. Add credits to continue. mochi:${JSON.stringify(refusal)}` }, mochi: refusal };
    const upstream = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify(envelope), { status: 402, headers: { "content-type": "application/json", "x-should-retry": "false" } }));
    vi.stubGlobal("fetch", upstream);
    sdk.script = async function* (options) {
      expect(await cliPost(options)).toBe(402);
      yield { type: "assistant", error: "unknown", message: { content: [{ type: "text", text: "API Error: 402 {...}" }] }, parent_tool_use_id: null };
      yield { type: "result", subtype: "success", is_error: true, result: "API Error: 402 {...}" };
    };
    const events = await turn(ctx, slug, "hello");
    expect(events).toContainEqual(expect.objectContaining({ status: 402, buyMoreUrl: refusal.buyMoreUrl, available: 3, required: 900, autoTopUp: "declined" }));
    expect(events.map((event) => event.text || "").join("")).not.toContain("API Error");
    expect(events.at(-1)).toEqual({ done: true });
    // The proxy sent the Router's bearer and the wallet user, not the CLI's key, and capped max_tokens.
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe("https://router.example.test/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer svc-fixture");
    expect(headers["x-mochi-wallet-user"]).toBe(WALLET_USER);
    expect(headers["x-api-key"]).toBeUndefined();
    expect(JSON.parse(Buffer.from(init.body as Uint8Array).toString("utf8")).max_tokens).toBe(8192);
  });

  it("refuses a caller without the turn's key, and an in-flight top-up 402 is retryable like the loop's", async () => {
    const { ctx, slug } = await workspace("Key Conf");
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    let status = 0;
    sdk.script = async function* (options) {
      status = await cliPost({ env: { ...options.env, ANTHROPIC_API_KEY: "wrong" } }); // pragma: allowlist secret
      yield textEvent("ok");
    };
    await turn(ctx, slug, "hello");
    expect(status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
    const inFlight = { type: "error", error: { type: "billing_error", message: "out" }, mochi: { error: "insufficient_credits", autoTopUp: "in_flight" } };
    expect(topUpInFlight(upstreamError({ status: 402, body: JSON.stringify(inFlight) }, "x"))).toBe(true);
    const ceiling = { type: "error", error: { type: "provider_budget_exhausted", message: "used up" }, mochi: { error: "provider_budget_exhausted" } };
    expect(routerFailureEvent(upstreamError({ status: 503, body: JSON.stringify(ceiling) }, "x"))).toMatchObject({ status: 503 });
  });

  it("for the 5.5 models drops sampling params and moves web search to web_search_20260209", () => {
    const fit = (body: Record<string, unknown>) => JSON.parse(cappedBody(Buffer.from(JSON.stringify(body))).toString());
    const webSearch = { type: "web_search_20250305", name: "web_search", max_uses: 8 };
    const custom = { name: "mcp__confnote__list_conferences", input_schema: { type: "object" } };
    for (const model of ["claude-opus-5-5", "claude-sonnet-5-5"]) {
      const out = fit({ model, max_tokens: 8192, temperature: 1, top_p: 0.9, top_k: 5, tools: [webSearch, custom], stream: true });
      expect(out).not.toHaveProperty("temperature");
      expect(out).not.toHaveProperty("top_p");
      expect(out).not.toHaveProperty("top_k");
      expect(out.tools).toEqual([{ type: "web_search_20260209", name: "web_search", max_uses: 8 }, custom]);
      expect(out.stream).toBe(true);
    }
    // Older models keep their sampling params and the tool version they asked for.
    const older = fit({ model: "claude-sonnet-4-6", max_tokens: 1000, temperature: 1, tools: [webSearch] });
    expect(older.temperature).toBe(1);
    expect(older.tools[0].type).toBe("web_search_20250305");
  });

  it("names a refusal's kind for the log without the whole body", () => {
    expect(upstreamErrorKind(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }))).toBe("overloaded_error | Overloaded");
    expect(upstreamErrorKind(JSON.stringify({ type: "error", error: { type: "provider_budget_exhausted", message: "used up" }, mochi: { error: "provider_budget_exhausted" } }))).toBe(
      "provider_budget_exhausted | provider_budget_exhausted | used up",
    );
    expect(upstreamErrorKind("<html>upstream connect error</html>")).toBe("<html>upstream connect error</html>");
    expect(upstreamErrorKind("x".repeat(500))).toHaveLength(160);
  });

  it("caps max_tokens and swaps the credentials", () => {
    expect(JSON.parse(cappedBody(Buffer.from(JSON.stringify({ max_tokens: 32000 }))).toString()).max_tokens).toBe(8192);
    expect(JSON.parse(cappedBody(Buffer.from(JSON.stringify({ max_tokens: 1000 }))).toString()).max_tokens).toBe(1000);
    const headers = upstreamHeaders({ "x-api-key": "cli", authorization: "Bearer cli", "anthropic-version": "2023-06-01" }, { baseUrl: "", serviceToken: "svc", walletUser: "u" });
    expect(headers).toEqual({ "anthropic-version": "2023-06-01", authorization: "Bearer svc", "x-mochi-wallet-user": "u" });
  });

  it("stays on the AI-SDK loop when the flag is off", async () => {
    delete process.env.CONFNOTE_CONCIERGE_ENGINE;
    const { agentSdkEngineSelected } = await import("../lib/agent-sdk-concierge.js");
    expect(agentSdkEngineSelected()).toBe(false);
    process.env.CONFNOTE_CONCIERGE_ENGINE = "agent-sdk";
    expect(agentSdkEngineSelected()).toBe(true);
  });
});
