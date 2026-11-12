// Local smoke: a fake Router (/v1/messages SSE) + the host + a fake confnote client over the socket.
// Run: node test/smoke.mjs (after npm run build). Prints the frames confnote would see.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import WebSocket from "ws";

const ROUTER_PORT = 18931, HOST_PORT = 18932;
const seen = [];
const sse = (res, events) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
};
const msgStart = (id) => ["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }];
const router = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = body ? JSON.parse(body) : {};
    if (req.url === "/v1/wallet/packs") { res.writeHead(req.headers.authorization === "Bearer test-token" ? 200 : 401).end("{}"); return; }
    seen.push({ url: req.url, wallet: req.headers["x-mochi-wallet-user"], auth: req.headers.authorization ? "bearer" : "none", model: parsed.model, temperature: parsed.temperature, top_p: parsed.top_p, top_k: parsed.top_k, thinking: parsed.thinking, tools: (parsed.tools || []).map((t) => t.type || t.name) });
    if (!req.url.startsWith("/v1/messages") || req.url.includes("count_tokens")) { res.writeHead(404).end(); return; }
    if (process.env.SMOKE_402) { res.writeHead(402, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "insufficient_credits", buyMoreUrl: "https://example.test/buy", available: 0, required: 1000 })); return; }
    const last = parsed.messages?.[parsed.messages.length - 1];
    const hasResult = Array.isArray(last?.content) && last.content.some((b) => b.type === "tool_result");
    if (!parsed.stream) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "m0", type: "message", role: "assistant", model: parsed.model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } })); return; }
    const isSearchSubcall = (parsed.tools || []).some((t) => String(t.type || "").startsWith("web_search"));
    if (isSearchSubcall) {
      sse(res, [msgStart("ms"),
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "search result" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }],
        ["message_stop", { type: "message_stop" }]]);
      return;
    }
    const firstTool = process.env.SMOKE_SEARCH ? { name: "WebSearch", input: '{"query":"Beyond The Prompt 2026"}' } : { name: "mcp__confnote__list_conferences", input: "{}" };
    if (!hasResult) {
      sse(res, [msgStart("m1"),
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me look." } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: firstTool.name, input: {} } }],
        ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: firstTool.input } }],
        ["content_block_stop", { type: "content_block_stop", index: 1 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }],
        ["message_stop", { type: "message_stop" }]]);
    } else {
      const result = JSON.stringify(last.content.find((b) => b.type === "tool_result").content);
      sse(res, [msgStart("m2"),
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `Tool said ${result.slice(0, 80)}` } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }],
        ["message_stop", { type: "message_stop" }]]);
    }
  });
});
router.listen(ROUTER_PORT);
const host = spawn("node", ["dist/server.js"], { env: { ...process.env, PORT: String(HOST_PORT), AGENT_HOST_ROUTER_BASE_URL: `http://127.0.0.1:${ROUTER_PORT}` }, stdio: ["ignore", "inherit", "inherit"] });
await new Promise((r) => setTimeout(r, 1500));
const ws = new WebSocket(`ws://127.0.0.1:${HOST_PORT}/v1/turn`);
const frames = [];
ws.on("open", () => ws.send(JSON.stringify({ type: "start", routerToken: "test-token", walletUser: "user_123", system: "You are a test.", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }, { role: "user", content: "list my conferences" }], tools: [{ name: "list_conferences", description: "List conferences", input_schema: { type: "object", properties: {} } }] })));
ws.on("message", (d) => {
  const f = JSON.parse(String(d)); frames.push(f);
  if (f.type === "tool_call") ws.send(JSON.stringify({ type: "tool_result", id: f.id, result: { conferences: [{ slug: "btp" }] } }));
});
const done = await new Promise((r) => { ws.on("close", () => r(true)); setTimeout(() => r(false), 90_000); });
console.log(JSON.stringify({ closed: done, frames, routerCalls: seen }, null, 1));
host.kill(); router.close(); process.exit(0);
