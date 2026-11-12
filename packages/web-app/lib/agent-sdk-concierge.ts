import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createSdkMcpServer, query, tool, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { APICallError } from "ai";
import { z } from "zod/v4";
import { callTool, SERVED, toolSpec, type ToolEnv, type ToolResult } from "./concierge-tools.js";

// The web Concierge on the Claude Agent SDK (CONFNOTE_CONCIERGE_ENGINE=agent-sdk), like the Mac app's
// packages/local-app/chat.py on the Python claude_agent_sdk: Claude drives the turn, with the spec tools
// (packages/contracts/tools.json) as an in-process MCP server and Claude Code's built-in WebSearch.
//
// Hosting: the SDK is pinned at 0.2.112, the last release that ships the CLI as JavaScript (cli.js, run by node).
// Later releases spawn a ~340 MB native binary, over Vercel's 250 MB function limit.
//
// Model calls: the CLI talks to a loopback proxy started for this turn only. The proxy adds the Router's service
// bearer and the wallet user (so neither ever reaches the CLI's environment), caps max_tokens at what Router wallet
// mode accepts, and keeps the body of a refused call, so a 402 shows the same buy-more card as the current engine.

export const AGENT_SDK_ENGINE = "agent-sdk";
export const MCP_SERVER_NAME = "confnote";
/** Claude Code built-ins this host allows. WebFetch stays off: confnote's fetch_url carries the SSRF guard. */
export const BUILTIN_TOOLS = ["WebSearch"] as const;
// Claude's own WebSearch replaces the spec's operator-gated web_search on this engine.
const REPLACED_BY_BUILTIN = new Set(["web_search"]);
const CANVAS_TOOLS = new Set(["draw_conference_board", "draw_mind_map"]);
const MAX_TURNS = 14;
/** Router wallet mode refuses a reply cap above 8192. */
export const ROUTER_MAX_TOKENS = 8192;
const SMALL_MODEL = "claude-haiku-4-5";
const WALLET_USER_HEADER = "x-mochi-wallet-user";
// Header names the proxy never forwards: the CLI's own credential, and hop-by-hop headers.
const DROPPED_HEADERS = new Set(["authorization", "x-api-key", "host", "connection", "content-length", "accept-encoding"]);
const STDERR_TAIL_CHARS = 2_000;
// The Router marks its refusals x-should-retry: false (the CLI honours it); upstream 429/529 carry retry-after.
const PASSED_RESPONSE_HEADERS = ["content-type", "request-id", "x-should-retry", "retry-after"] as const;
// An MCP tool call (an import reads a whole website) may outlast the SDK's 60 s default.
const MCP_CALL_TIMEOUT_MS = 110_000;

// The newest Opus by default (musa, 2026-11-13). The 0.2.112 CLI sends no thinking, budget_tokens or tool_choice,
// which Opus 5.5 refuses (checked on a loopback capture of a turn with a WebSearch sub-call).
export const AGENT_SDK_DEFAULT_MODEL = "claude-opus-5-5";

/** CONFNOTE_AGENT_SDK_MODEL overrides; the Router's price book must carry the model. */
export function agentSdkModel(): string {
  return (process.env.CONFNOTE_AGENT_SDK_MODEL || "").trim() || AGENT_SDK_DEFAULT_MODEL;
}

export function agentSdkEngineSelected(): boolean {
  return (process.env.CONFNOTE_CONCIERGE_ENGINE || "").trim().toLowerCase() === AGENT_SDK_ENGINE;
}

/** mcp__confnote__<tool>: the name Claude Code gives an SDK MCP server's tool. */
export function mcpToolName(name: string): string {
  return `mcp__${MCP_SERVER_NAME}__${name}`;
}

/** The spec tools this engine serves: what the hosted loop serves, minus web_search (WebSearch replaces it). */
export function agentSdkToolNames(canvas: boolean): string[] {
  return SERVED.filter((name) => !REPLACED_BY_BUILTIN.has(name) && (canvas || !CANVAS_TOOLS.has(name)));
}

// ---------- the spec's JSON Schema subset as zod (the SDK's tool() takes a zod shape) ----------

type JsonSchema = Record<string, any>;

function zodFor(schema: JsonSchema): z.ZodType {
  let result: z.ZodType;
  if (Array.isArray(schema.enum) && schema.enum.every((value: unknown) => typeof value === "string")) {
    result = z.enum(schema.enum as [string, ...string[]]);
  } else if (schema.type === "string") {
    result = z.string();
  } else if (schema.type === "integer") {
    result = z.number().int();
  } else if (schema.type === "number") {
    result = z.number();
  } else if (schema.type === "boolean") {
    result = z.boolean();
  } else if (schema.type === "array") {
    result = z.array(schema.items ? zodFor(schema.items) : z.unknown());
  } else if (schema.type === "object") {
    result = z.object(zodShape(schema)).catchall(z.unknown());
  } else {
    result = z.unknown();
  }
  return typeof schema.description === "string" ? result.describe(schema.description) : result;
}

/** Bounds and patterns are left to concierge-tools' checkArgs, which every call goes through. */
export function zodShape(schema: JsonSchema): Record<string, z.ZodType> {
  const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
  const shape: Record<string, z.ZodType> = {};
  for (const [key, value] of Object.entries((schema.properties || {}) as Record<string, JsonSchema>)) {
    const field = zodFor(value);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return shape;
}

/** The spec tools as an in-process MCP server, every call scoped to this session's workspace through `env`. */
export function conciergeMcpServer(env: ToolEnv, canvas: boolean, onResult: (name: string, output: ToolResult) => Promise<void>) {
  const tools = agentSdkToolNames(canvas).map((name) => {
    const entry = toolSpec(name);
    return tool(name, entry.purpose, zodShape(entry.input_schema), async (args) => {
      const output = await callTool(name, args, env);
      await onResult(name, output);
      return { content: [{ type: "text" as const, text: JSON.stringify(output) }], isError: Boolean(output.error) };
    });
  });
  return createSdkMcpServer({ name: MCP_SERVER_NAME, version: "1.0.0", tools });
}

// ---------- the loopback proxy to the Router's Anthropic Messages passthrough ----------

export interface RouterUpstream {
  /** Base the CLI's paths (/v1/messages…) are appended to. */
  baseUrl: string;
  serviceToken: string;
  walletUser: string;
}

export interface UpstreamFailure {
  status: number;
  body: string;
}

export interface MessagesProxy {
  url: string;
  /** The per-turn key the CLI must present; nothing else may use the proxy. */
  key: string;
  lastFailure(): UpstreamFailure | undefined;
  close(): Promise<void>;
}

export function routerUpstream(walletUser: string | undefined): RouterUpstream {
  const base = process.env.CONFNOTE_ROUTER_MESSAGES_URL || process.env.CONFNOTE_ROUTER_URL;
  const token = process.env.CONFNOTE_ROUTER_SERVICE_TOKEN;
  if (!base || !token || !walletUser) throw new Error("Platform credits are unavailable. Add your own provider key.");
  return { baseUrl: base.replace(/\/+$/, ""), serviceToken: token, walletUser };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

// The 5.5 models refuse sampling parameters (400) and take the newer web search tool; the 0.2.112 CLI predates both.
const NO_SAMPLING_MODELS = /^claude-(opus|sonnet)-5-5/;
const SAMPLING_PARAMS = ["temperature", "top_p", "top_k"] as const;
const OLD_WEB_SEARCH = "web_search_20250305";
const NEW_WEB_SEARCH = "web_search_20260209";

/**
 * Fits the CLI's request to the Router and the model: caps max_tokens at the Router's limit, and for the 5.5 models
 * drops temperature/top_p/top_k and moves web_search_20250305 to web_search_20260209. Non-JSON passes unchanged.
 */
export function cappedBody(raw: Buffer): Buffer {
  let body: Record<string, any>;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return raw;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return raw;
  let changed = false;
  if (typeof body.max_tokens === "number" && body.max_tokens > ROUTER_MAX_TOKENS) {
    body.max_tokens = ROUTER_MAX_TOKENS;
    if (body.thinking?.budget_tokens >= ROUTER_MAX_TOKENS) delete body.thinking;
    changed = true;
  }
  if (typeof body.model === "string" && NO_SAMPLING_MODELS.test(body.model)) {
    for (const param of SAMPLING_PARAMS) {
      if (param in body) {
        delete body[param];
        changed = true;
      }
    }
    if (Array.isArray(body.tools)) {
      for (const entry of body.tools) {
        if (entry && typeof entry === "object" && entry.type === OLD_WEB_SEARCH) {
          entry.type = NEW_WEB_SEARCH;
          changed = true;
        }
      }
    }
  }
  return changed ? Buffer.from(JSON.stringify(body)) : raw;
}

export function upstreamHeaders(incoming: IncomingMessage["headers"], upstream: RouterUpstream): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || DROPPED_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  headers.authorization = `Bearer ${upstream.serviceToken}`;
  headers[WALLET_USER_HEADER] = upstream.walletUser;
  return headers;
}

function presentedKey(req: IncomingMessage): string {
  const presented = req.headers["x-api-key"];
  if (typeof presented === "string") return presented;
  const auth = req.headers.authorization || "";
  return auth.replace(/^Bearer\s+/i, "");
}

export async function startMessagesProxy(upstream: RouterUpstream, fetchImpl: typeof fetch = fetch): Promise<MessagesProxy> {
  const key = randomUUID();
  let failure: UpstreamFailure | undefined;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (presentedKey(req) !== key) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"type":"error","error":{"type":"authentication_error","message":"bad key"}}');
        return;
      }
      const raw = await readBody(req);
      const response = await fetchImpl(`${upstream.baseUrl}${req.url || ""}`, {
        method: req.method,
        headers: upstreamHeaders(req.headers, upstream),
        body: req.method === "GET" || req.method === "HEAD" ? undefined : new Uint8Array(cappedBody(raw)),
      });
      const headers: Record<string, string> = {};
      for (const name of PASSED_RESPONSE_HEADERS) {
        const value = response.headers.get(name);
        if (value) headers[name] = value;
      }
      if (!response.ok) {
        const body = await response.text();
        failure = { status: response.status, body };
        res.writeHead(response.status, headers).end(body);
        return;
      }
      res.writeHead(response.status, headers);
      if (!response.body) {
        res.end();
        return;
      }
      Readable.fromWeb(response.body as unknown as NodeReadableStream).pipe(res);
    })().catch((error: unknown) => {
      console.warn("agent_sdk_proxy_failed", { message: error instanceof Error ? error.name : "unknown" });
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end('{"type":"error","error":{"type":"api_error","message":"Router unreachable"}}');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    key,
    lastFailure: () => failure,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// ---------- one turn ----------

export interface AgentSdkTurn {
  system: string;
  /** The stored conversation (oldest first) ending with the user's new message. */
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  model: string;
  walletUser: string | undefined;
  env: ToolEnv;
  canvas: boolean;
  abortSignal?: AbortSignal;
  timeoutMs: number;
  write(text: string): Promise<void>;
  onToolResult(name: string, output: ToolResult): Promise<void>;
}

/** The SDK takes one prompt string: earlier turns go in as a labelled transcript, the new message last. */
export function promptFor(messages: AgentSdkTurn["messages"]): string {
  const latest = messages[messages.length - 1];
  const earlier = messages.slice(0, -1);
  const text = latest?.content || "";
  if (!earlier.length) return text;
  const transcript = earlier.map((message) => `${message.role === "assistant" ? "Concierge" : "User"}: ${message.content}`).join("\n\n");
  return [
    "<conversation_so_far>",
    transcript,
    "</conversation_so_far>",
    "",
    "The user's new message:",
    text,
  ].join("\n");
}

/** Every inherited variable is removed (the function's secrets stay out of the CLI); only what it needs is set. */
export function cliEnvironment(proxy: Pick<MessagesProxy, "url" | "key">, home: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const name of Object.keys(process.env)) env[name] = undefined;
  return {
    ...env,
    PATH: [dirname(process.execPath), process.env.PATH || ""].filter(Boolean).join(":"),
    HOME: home,
    TMPDIR: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    ANTHROPIC_BASE_URL: proxy.url,
    ANTHROPIC_API_KEY: proxy.key,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: SMALL_MODEL,
    ANTHROPIC_SMALL_FAST_MODEL: SMALL_MODEL,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(ROUTER_MAX_TOKENS),
    CLAUDE_CODE_MAX_RETRIES: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: String(MCP_CALL_TIMEOUT_MS),
    MAX_THINKING_TOKENS: "0",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: "confnote-web/agent-sdk",
  };
}

/**
 * The wallet detail of a Router refusal. /v1/messages answers Anthropic's envelope with it under `mochi`
 * ({type:"error", error:{type:"billing_error",…}, mochi:{error:"insufficient_credits", buyMoreUrl,…}}), while the
 * chat-completions gateway puts it at the top level, which is what chat.ts reads.
 */
export function walletDetail(body: string): string {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.mochi === "object" && parsed.mochi !== null) return JSON.stringify(parsed.mochi);
  } catch {
    // Not JSON: pass it on as is.
  }
  return body;
}

const ERROR_KIND_CHARS = 160;

/**
 * What a refused call said, for the log: the envelope's error type, the wallet's error code, and the start of the
 * message. These are the Router's own words, never a credential. A body that is not JSON is cut to a short prefix.
 */
export function upstreamErrorKind(body: string): string {
  try {
    const parsed = JSON.parse(body);
    const type = typeof parsed?.error === "object" ? parsed.error?.type : parsed?.error;
    const message = typeof parsed?.error === "object" ? parsed.error?.message : parsed?.message;
    const mochi = typeof parsed?.mochi === "object" ? parsed.mochi?.error : undefined;
    return [type, mochi, typeof message === "string" ? message : ""].filter(Boolean).join(" | ").slice(0, ERROR_KIND_CHARS);
  } catch {
    return body.slice(0, ERROR_KIND_CHARS);
  }
}

/** A refused model call as the AI SDK's APICallError, so chat.ts's 402 / 503 handling applies unchanged. */
export function upstreamError(failure: UpstreamFailure | undefined, fallback: string): Error {
  if (!failure) return new Error(fallback);
  return new APICallError({
    message: `Router answered ${failure.status}`,
    url: "router:/v1/messages",
    requestBodyValues: {},
    statusCode: failure.status,
    responseBody: walletDetail(failure.body),
    isRetryable: false,
  });
}

function textDelta(message: SDKMessage): { text?: string; newMessage?: boolean } {
  if (message.type !== "stream_event" || message.parent_tool_use_id) return {};
  const event = message.event as { type?: string; delta?: { type?: string; text?: string } };
  if (event.type === "message_start") return { newMessage: true };
  if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) return { text: event.delta.text };
  return {};
}

export async function runAgentSdkTurn(turn: AgentSdkTurn, fetchImpl: typeof fetch = fetch): Promise<void> {
  const upstream = routerUpstream(turn.walletUser);
  const home = join(tmpdir(), "confnote-agent-sdk");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const proxy = await startMessagesProxy(upstream, fetchImpl);
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  turn.abortSignal?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, turn.timeoutMs);
  let stderr = "";
  const allowed = [...BUILTIN_TOOLS, ...agentSdkToolNames(turn.canvas).map(mcpToolName)];
  const allowedSet = new Set(allowed);
  const options: Options = {
    model: turn.model,
    systemPrompt: turn.system,
    tools: [...BUILTIN_TOOLS],
    allowedTools: allowed,
    canUseTool: async (name, input) =>
      allowedSet.has(name) ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "That tool is not available here." },
    mcpServers: { [MCP_SERVER_NAME]: conciergeMcpServer(turn.env, turn.canvas, turn.onToolResult) },
    strictMcpConfig: true,
    settingSources: [],
    persistSession: false,
    includePartialMessages: true,
    thinking: { type: "disabled" },
    maxTurns: MAX_TURNS,
    cwd: home,
    env: cliEnvironment(proxy, home),
    executable: "node",
    abortController: abort,
    stderr: (data) => {
      stderr = `${stderr}${data}`.slice(-STDERR_TAIL_CHARS);
    },
  };
  let wroteText = false;
  let newStep = false;
  let failed: string | undefined;
  try {
    for await (const message of query({ prompt: promptFor(turn.messages), options })) {
      const delta = textDelta(message);
      if (delta.newMessage) newStep = wroteText;
      if (delta.text) {
        // Each model call's text starts a new paragraph, like the AI-SDK loop.
        await turn.write(newStep ? `\n\n${delta.text}` : delta.text);
        wroteText = true;
        newStep = false;
      }
      if (message.type === "assistant" && message.error) failed = message.error;
      if (message.type === "result" && message.is_error && message.subtype !== "error_max_turns") {
        failed ||= message.subtype;
      }
    }
  } catch (error) {
    if (timedOut) throw new Error("The Concierge ran out of time for this turn.");
    if (turn.abortSignal?.aborted) throw error;
    failed ||= error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
    turn.abortSignal?.removeEventListener("abort", onAbort);
    await proxy.close();
  }
  if (timedOut) throw new Error("The Concierge ran out of time for this turn.");
  if (failed) {
    const refusal = proxy.lastFailure();
    console.warn("agent_sdk_turn_failed", {
      reason: failed,
      upstream: refusal?.status,
      upstreamError: refusal ? upstreamErrorKind(refusal.body) : undefined,
      stderr: stderr.slice(-400),
    });
    throw upstreamError(proxy.lastFailure(), "The model request could not be completed.");
  }
}
