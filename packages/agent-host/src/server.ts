import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { query, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AddressCap, bearerGate, clientAddress } from "./gate.js";
import { FrameError, parseStart, promptFor, routerRefusal, type ClientFrame, type HostFrame, type StartFrame } from "./protocol.js";

// One long-lived service for every confnote user. Each turn is one Agent SDK query() in a fresh temp cwd and HOME,
// with only confnote's tools (relayed to the caller) plus WebSearch. No Bash, no file tools, no
// settings or skills from disk; the model endpoint is fixed here, never taken from the caller.

const PORT = Number(process.env.PORT || 8080);
const ROUTER_BASE_URL = requiredEnv("AGENT_HOST_ROUTER_BASE_URL");
const MODEL = process.env.AGENT_HOST_MODEL || "claude-opus-5-5";
const SMALL_MODEL = process.env.AGENT_HOST_SMALL_MODEL || "claude-haiku-4-5";
const WALLET_HEADER = process.env.AGENT_HOST_WALLET_HEADER || "x-mochi-wallet-user";
const MAX_CONCURRENT = Number(process.env.AGENT_HOST_MAX_CONCURRENT || 8);
const MAX_TURNS = Number(process.env.AGENT_HOST_MAX_TURNS || 12);
const MAX_SOCKETS_PER_ADDRESS = Number(process.env.AGENT_HOST_MAX_SOCKETS_PER_ADDRESS || 4);
const TURN_TIMEOUT_MS = Number(process.env.AGENT_HOST_TURN_TIMEOUT_MS || 110_000);
const START_TIMEOUT_MS = 10_000;
const TOOL_TIMEOUT_MS = 60_000;
const MAX_FRAME_BYTES = 1_000_000;
// No WebFetch: a fetch from inside the Azure environment is an SSRF path; confnote's fetch_url is guarded.
const BUILT_IN_TOOLS = ["WebSearch"];
const MCP_NAME = "confnote";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value.replace(/\/+$/, "");
}

let running = 0;

function send(socket: WebSocket, frame: HostFrame): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
}

/** The confnote tools as an in-process MCP server whose every call is answered by the caller over the socket. */
function relayServer(start: StartFrame, callTool: (name: string, args: unknown) => Promise<Record<string, unknown>>): McpSdkServerConfigWithInstance {
  const mcp = new McpServer({ name: MCP_NAME, version: "1.0.0" }, { capabilities: { tools: {} } });
  const names = new Set(start.tools.map((tool) => tool.name));
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: start.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: "object" as const, ...tool.input_schema },
      _meta: { "anthropic/alwaysLoad": true },
    })),
  }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    if (!names.has(name)) return { content: [{ type: "text" as const, text: JSON.stringify({ error: `No such tool: ${name}` }) }], isError: true };
    const result = await callTool(name, request.params.arguments || {});
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: Boolean(result.error) };
  });
  return { type: "sdk", name: MCP_NAME, instance: mcp };
}

function cliEnv(start: StartFrame, home: string): Record<string, string> {
  return {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    TMPDIR: home,
    ANTHROPIC_BASE_URL: ROUTER_BASE_URL,
    // The Router reads Authorization: Bearer (an x-api-key alone is "missing bearer token").
    ANTHROPIC_AUTH_TOKEN: start.routerToken,
    ANTHROPIC_CUSTOM_HEADERS: `${WALLET_HEADER}: ${start.walletUser}`,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: SMALL_MODEL,
    ANTHROPIC_SMALL_FAST_MODEL: SMALL_MODEL,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    ENABLE_TOOL_SEARCH: "false",
    // The CLI retries refusals (a 401 for ~2 minutes by default); a web turn has one budget, so fail fast.
    CLAUDE_CODE_MAX_RETRIES: process.env.AGENT_HOST_MAX_RETRIES || "2",
    CLAUDE_AGENT_SDK_CLIENT_APP: "confnote-agent-host/0.1",
  };
}

async function runTurn(socket: WebSocket, start: StartFrame, pending: Map<string, (result: Record<string, unknown>) => void>): Promise<void> {
  // Listen for a disconnect before any await, so a caller that leaves early never starts a CLI.
  const abort = new AbortController();
  socket.once("close", () => abort.abort());
  if (socket.readyState !== socket.OPEN) return;
  const timer = setTimeout(() => abort.abort(), TURN_TIMEOUT_MS);
  const home = await mkdtemp(join(tmpdir(), "turn-"));

  const callTool = (name: string, args: unknown) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = randomUUID();
      const timeout = setTimeout(() => {
        pending.delete(id);
        resolve({ error: `${name} timed out` });
      }, TOOL_TIMEOUT_MS);
      pending.set(id, (result) => {
        clearTimeout(timeout);
        pending.delete(id);
        resolve(result);
      });
      send(socket, { type: "tool_call", id, name, args });
    });

  let wroteText = false;
  let newStep = false;
  let failed = false;
  try {
    if (abort.signal.aborted) throw new Error("caller left");
    const turn = query({
      prompt: promptFor(start.messages),
      options: {
        systemPrompt: start.system,
        model: MODEL,
        tools: BUILT_IN_TOOLS,
        allowedTools: [...BUILT_IN_TOOLS, ...start.tools.map((tool) => `mcp__${MCP_NAME}__${tool.name}`)],
        permissionMode: "dontAsk",
        mcpServers: { [MCP_NAME]: relayServer(start, callTool) },
        strictMcpConfig: true,
        settingSources: [],
        cwd: home,
        env: cliEnv(start, home),
        includePartialMessages: true,
        maxTurns: MAX_TURNS,
        abortController: abort,
      },
    });
    for await (const message of turn) {
      if (message.type === "stream_event") {
        const event = message.event;
        if (message.parent_tool_use_id) continue;
        if (event.type === "message_start") newStep = wroteText;
        if (event.type === "content_block_delta" && event.delta.type === "text_delta" && event.delta.text) {
          send(socket, { type: "text", text: newStep ? `\n\n${event.delta.text}` : event.delta.text });
          wroteText = true;
          newStep = false;
        }
      } else if (message.type === "assistant" && message.error) {
        const text = message.message.content.map((block) => ("text" in block ? block.text : "")).join(" ");
        const refusal = routerRefusal(text);
        console.warn("agent_api_error", { kind: message.error, status: refusal?.status });
        send(socket, { type: "error", error: message.error, status: refusal?.status, body: refusal?.body });
        failed = true;
      } else if (message.type === "result" && message.subtype !== "success" && !failed) {
        console.warn("agent_turn_failed", { subtype: message.subtype });
        send(socket, { type: "error", error: message.subtype });
        failed = true;
      } else if (message.type === "result" && message.subtype === "success" && message.is_error && !failed) {
        const refusal = routerRefusal(message.result);
        console.warn("agent_turn_error", { status: refusal?.status });
        send(socket, { type: "error", error: "model_error", status: refusal?.status, body: refusal?.body });
        failed = true;
      }
    }
  } catch (error) {
    if (!failed) {
      const aborted = abort.signal.aborted;
      console.warn("agent_turn_threw", { aborted, message: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
      send(socket, { type: "error", error: aborted ? "timeout" : "agent_failed" });
    }
  } finally {
    clearTimeout(timer);
    for (const resolve of pending.values()) resolve({ error: "turn ended" });
    await rm(home, { recursive: true, force: true }).catch((error) => console.warn("turn_home_cleanup_failed", { message: String(error).slice(0, 120) }));
  }
  send(socket, { type: "done" });
}

const http = createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, running, model: MODEL }));
    return;
  }
  response.writeHead(404).end();
});

const gate = bearerGate({ routerBase: ROUTER_BASE_URL });
const addresses = new AddressCap(MAX_SOCKETS_PER_ADDRESS);

const wss = new WebSocketServer({
  server: http,
  path: "/v1/turn",
  maxPayload: MAX_FRAME_BYTES,
  // A per-address cap before the upgrade: one client cannot hold every socket.
  verifyClient: (info, done) => {
    const address = clientAddress(info.req.headers["x-forwarded-for"], info.req.socket.remoteAddress);
    if (!addresses.take(address)) {
      done(false, 429, "too many connections");
      return;
    }
    (info.req as { clientAddress?: string }).clientAddress = address;
    done(true);
  },
});

wss.on("connection", (socket, request) => {
  const address = (request as { clientAddress?: string }).clientAddress || "unknown";
  socket.once("close", () => addresses.give(address));
  const pending = new Map<string, (result: Record<string, unknown>) => void>();
  let started = false;
  const startTimer = setTimeout(() => {
    if (!started) socket.close(1008, "no start");
  }, START_TIMEOUT_MS);

  socket.on("message", async (data) => {
    let frame: ClientFrame;
    try {
      frame = JSON.parse(String(data)) as ClientFrame;
    } catch {
      socket.close(1007, "bad frame");
      return;
    }
    if (started) {
      if (frame.type === "tool_result" && typeof frame.id === "string") {
        const result = frame.result && typeof frame.result === "object" ? frame.result : { error: "empty tool result" };
        pending.get(frame.id)?.(result);
      }
      return;
    }
    started = true;
    let start: StartFrame;
    try {
      start = parseStart(frame);
    } catch (error) {
      clearTimeout(startTimer);
      send(socket, { type: "error", error: error instanceof FrameError ? error.message : "bad start", status: 400 });
      socket.close(1008, "bad start");
      return;
    }
    // The bearer is checked before a turn slot is taken or anything is spawned; the start timer still bounds it.
    const allowed = await gate.allows(start.routerToken);
    clearTimeout(startTimer);
    if (socket.readyState !== socket.OPEN) return;
    if (!allowed) {
      send(socket, { type: "error", error: "unauthorized", status: 401 });
      socket.close(1008, "unauthorized");
      return;
    }
    if (running >= MAX_CONCURRENT) {
      send(socket, { type: "error", error: "busy", status: 503 });
      socket.close(1013, "busy");
      return;
    }
    running += 1;
    runTurn(socket, start, pending)
      .catch(() => undefined)
      .finally(() => {
        running -= 1;
        socket.close(1000, "done");
      });
  });
});

http.listen(PORT, () => console.log(`agent-host listening on ${PORT}, model ${MODEL}`));
