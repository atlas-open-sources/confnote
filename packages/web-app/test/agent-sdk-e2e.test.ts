import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The real Agent SDK and its CLI (cli.js under node) against a fake Router on loopback: proves the proxy's
// headers, the in-process MCP tools, the text stream and the 402 card end to end, offline. Opt-in (it spawns the
// CLI, a few seconds a turn): CONFNOTE_AGENT_SDK_E2E=1 npx vitest run test/agent-sdk-e2e.test.ts

const RUN = process.env.CONFNOTE_AGENT_SDK_E2E === "1";
const SERVICE_TOKEN = "svc-fixture-token"; // pragma: allowlist secret
const WALLET_USER = "user_e2e";
const REFUSAL = { error: "insufficient_credits", available: 10, required: 500, buyMoreUrl: "https://example.test/buy" };

interface Seen {
  path: string;
  authorization?: string;
  walletUser?: string;
  apiKey?: string;
  maxTokens?: number;
  tools: string[];
}

const seen: Seen[] = [];
let refuse = false;

function sse(res: ServerResponse, model: string, blocks: Array<Record<string, unknown>>, stopReason: string) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send("message_start", {
    message: { id: `msg_${seen.length}`, type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } },
  });
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      send("content_block_start", { index, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
    } else {
      send("content_block_start", { index, content_block: { ...block, input: {} } });
      send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    }
    send("content_block_stop", { index });
  });
  send("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } });
  send("message_stop", {});
  res.end();
}

async function fakeRouter(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  const tools = ((body.tools || []) as Array<{ name: string }>).map((entry) => entry.name);
  seen.push({
    path: req.url || "",
    authorization: req.headers.authorization,
    walletUser: req.headers["x-mochi-wallet-user"] as string | undefined,
    apiKey: req.headers["x-api-key"] as string | undefined,
    maxTokens: body.max_tokens,
    tools,
  });
  if (!String(req.url).startsWith("/v1/messages")) {
    res.writeHead(404).end();
    return;
  }
  if (refuse) {
    res
      .writeHead(402, { "content-type": "application/json", "x-should-retry": "false" })
      .end(JSON.stringify({ type: "error", error: { type: "billing_error", message: `You are out of credits. mochi:${JSON.stringify(REFUSAL)}` }, mochi: REFUSAL }));
    return;
  }
  const messages = (body.messages || []) as Array<{ content: unknown }>;
  const last = JSON.stringify(messages.at(-1)?.content || "");
  if (last.includes("tool_result")) {
    sse(res, body.model, [{ type: "text", text: "You have one conference: Tools Conf." }], "end_turn");
  } else if (tools.includes("mcp__confnote__list_conferences")) {
    sse(res, body.model, [{ type: "tool_use", id: "toolu_1", name: "mcp__confnote__list_conferences", input: {} }], "tool_use");
  } else {
    sse(res, body.model, [{ type: "text", text: "ok" }], "end_turn");
  }
}

describe.skipIf(!RUN)("Agent SDK Concierge end to end (real CLI, fake Router)", () => {
  const server = createServer((req, res) => void fakeRouter(req, res));

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    process.env.CONFNOTE_ROUTER_MESSAGES_URL = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    process.env.CONFNOTE_ROUTER_SERVICE_TOKEN = SERVICE_TOKEN;
    process.env.CONFNOTE_CONCIERGE_ENGINE = "agent-sdk";
    process.env.CONFNOTE_WEB_AGENT_PROVIDER = "mochi-router";
    process.env.CONFNOTE_ROUTER_URL = process.env.CONFNOTE_ROUTER_MESSAGES_URL;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function workspace() {
    const { addConference } = await import("../lib/service.js");
    const ctx = { workspace: `sdk-e2e-${Date.now()}`, principal: { userId: WALLET_USER } };
    const imported = await addConference(ctx as never, {
      schema_version: "confnote.agenda.v1",
      conference: { name: "Tools Conf", date: "2099-05-03", timezone: "Europe/London" },
      events: [{ id: "k", type: "talk", title: "Keynote", start: "2099-05-03T09:00:00+00:00", end: "2099-05-03T10:00:00+00:00" }],
    });
    if (!("slug" in imported)) throw new Error("agenda did not import");
    return { ctx, slug: imported.slug };
  }

  it("runs a tool turn through the proxy with the Router's credentials", async () => {
    const { streamWebChatEvents } = await import("../lib/chat.js");
    const { ctx, slug } = await workspace();
    const events: Array<Record<string, unknown>> = [];
    await streamWebChatEvents(ctx as never, { slug, body: { messages: [{ role: "user", text: "Which conferences do I have?" }] } }, (event) => {
      events.push(event as Record<string, unknown>);
    });
    const text = events.map((event) => event.text || "").join("");
    expect(text).toContain("You have one conference: Tools Conf.");
    expect(events.at(-1)).toEqual({ done: true });
    const calls = seen.filter((entry) => entry.path.startsWith("/v1/messages"));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call.authorization).toBe(`Bearer ${SERVICE_TOKEN}`);
      expect(call.walletUser).toBe(WALLET_USER);
      expect(call.apiKey).toBeUndefined();
      expect(call.maxTokens).toBeLessThanOrEqual(8192);
    }
    const toolCall = calls.find((call) => call.tools.includes("mcp__confnote__list_conferences"));
    expect(toolCall?.tools).toContain("WebSearch");
    expect(toolCall?.tools).not.toContain("Bash");
    expect(toolCall?.tools).not.toContain("Read");
    expect(toolCall?.tools).not.toContain("mcp__confnote__web_search");
  }, 90_000);

  it("turns a Router 402 into the buy-more card", async () => {
    const { streamWebChatEvents } = await import("../lib/chat.js");
    const { ctx, slug } = await workspace();
    refuse = true;
    const events: Array<Record<string, unknown>> = [];
    try {
      await streamWebChatEvents(ctx as never, { slug, body: { messages: [{ role: "user", text: "hello" }] } }, (event) => {
        events.push(event as Record<string, unknown>);
      });
    } finally {
      refuse = false;
    }
    expect(events).toContainEqual(expect.objectContaining({ status: 402, buyMoreUrl: REFUSAL.buyMoreUrl, available: 10, required: 500 }));
    expect(events.map((event) => event.text || "").join("")).not.toContain("API Error");
    expect(events.at(-1)).toEqual({ done: true });
  }, 90_000);
});
