import { APICallError, type ModelMessage } from "ai";
import { SERVED, callTool, toolSpec, type ToolEnv, type ToolResult } from "./concierge-tools.js";

// CONFNOTE_CONCIERGE_ENGINE=agent-host: the Concierge turn runs on the current Claude Agent SDK in the agent host
// (packages/agent-host, an Azure Container App). agent-sdk (agent-sdk-concierge.ts) runs a pinned JS-CLI SDK inside
// the Vercel Function instead; this engine is for SDK releases whose native CLI no longer fits a function. One WebSocket per turn:
// this server sends the turn, the host streams text and asks this server to run each confnote tool, which runs here
// with this request's ctx. The host never sees storage; the wallet id it bills comes from this server's principal.

export const AGENT_HOST_ENGINE = "agent-host";
// The host's WebSearch replaces confnote's web_search; fetch_url stays here, behind its SSRF guard.
const HOST_WEB_TOOLS = new Set(["web_search"]);
const CANVAS_TOOLS = new Set(["draw_conference_board", "draw_mind_map"]);
const CONNECT_TIMEOUT_MS = 10_000;
// The host ends a turn at 110 s; this backstop ends it here even if the host or a tool stalls (maxDuration 120).
const TURN_TIMEOUT_MS = 115_000;

export function agentHostEngineSelected(): boolean {
  return (process.env.CONFNOTE_CONCIERGE_ENGINE || "").trim().toLowerCase() === AGENT_HOST_ENGINE && Boolean(process.env.CONFNOTE_AGENT_HOST_URL);
}

type HostFrame =
  | { type: "text"; text: string }
  | { type: "notice"; notice: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "error"; error: string; status?: number; body?: unknown }
  | { type: "done" };

export interface AgentHostTurn {
  env: ToolEnv;
  system: string;
  messages: ModelMessage[];
  canvas: boolean;
  onText(text: string): Promise<void>;
  onToolResult(name: string, output: ToolResult): Promise<void>;
  abortSignal?: AbortSignal;
}

function toolDescriptors(canvas: boolean) {
  return SERVED.filter((name) => !HOST_WEB_TOOLS.has(name) && (canvas || !CANVAS_TOOLS.has(name))).map((name) => {
    const entry = toolSpec(name);
    return { name, description: entry.purpose, input_schema: entry.input_schema };
  });
}

function textOf(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => ("text" in part && typeof part.text === "string" ? part.text : "")).join("");
}

/** A host error as the Router error the rest of chat.ts already turns into the buy-more card or a plain failure. */
function hostError(frame: Extract<HostFrame, { type: "error" }>, url: string): Error {
  const status = frame.status;
  let body = frame.body;
  // An Anthropic-shaped envelope ({type:"error", error:{...}}) may carry the wallet body inside.
  if (body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "object") {
    const inner = (body as { error: Record<string, unknown> }).error;
    if (inner && (inner.error === "insufficient_credits" || inner.error === "provider_budget_exhausted")) body = inner;
  }
  if (status === 402 && (!body || typeof body !== "object" || !("error" in body))) body = { error: "insufficient_credits" };
  if (status) {
    return new APICallError({
      message: `agent host: ${frame.error}`,
      url,
      requestBodyValues: {},
      statusCode: status,
      responseBody: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  return new Error(`agent host: ${frame.error}`);
}

/** Runs one Concierge turn on the agent host; resolves when the host is done, throws on a host or model error. */
export async function runAgentHostTurn(ctx: { principal?: { userId?: string } }, turn: AgentHostTurn): Promise<void> {
  const base = (process.env.CONFNOTE_AGENT_HOST_URL || "").replace(/\/+$/, "");
  const routerToken = process.env.CONFNOTE_ROUTER_SERVICE_TOKEN;
  const walletUser = ctx.principal?.userId;
  if (!base || !routerToken || !walletUser) throw new Error("The agent host is not configured, or the user is not signed in.");
  const url = `${base.replace(/^http/, "ws")}/v1/turn`;
  const Socket = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!Socket) throw new Error("This runtime has no WebSocket client.");
  if (turn.abortSignal?.aborted) throw new Error("aborted");

  const socket = new Socket(url);
  const messages = turn.messages
    .map((message) => ({ role: message.role === "assistant" ? "assistant" : "user", content: textOf(message).trim() }))
    .filter((message) => message.content);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let failure: Error | null = null;
    // Frames are handled one at a time so text and tool chips reach the drawer in the order the host sent them.
    let queue = Promise.resolve();
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(turnTimer);
      turn.abortSignal?.removeEventListener("abort", onAbort);
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(new Error("aborted"));
    turn.abortSignal?.addEventListener("abort", onAbort);
    const connectTimer = setTimeout(() => finish(new Error("agent host did not answer")), CONNECT_TIMEOUT_MS);
    const turnTimer = setTimeout(() => finish(failure || new Error("agent host turn timed out")), TURN_TIMEOUT_MS);

    socket.addEventListener("open", () => {
      clearTimeout(connectTimer);
      socket.send(JSON.stringify({
        type: "start",
        routerToken,
        walletUser,
        system: turn.system,
        messages,
        tools: toolDescriptors(turn.canvas),
      }));
    });
    socket.addEventListener("message", (event) => {
      let frame: HostFrame;
      try {
        frame = JSON.parse(String(event.data)) as HostFrame;
      } catch {
        return;
      }
      queue = queue.then(async () => {
        if (settled) return;
        if (frame.type === "text") await turn.onText(frame.text);
        else if (frame.type === "tool_call") {
          const output = await callTool(frame.name, frame.args, turn.env);
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "tool_result", id: frame.id, result: output }));
          await turn.onToolResult(frame.name, output);
        } else if (frame.type === "error") failure ||= hostError(frame, url);
        else if (frame.type === "done") finish(failure);
      }).catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
    });
    socket.addEventListener("error", () => queue.then(() => finish(failure || new Error("agent host connection failed"))));
    socket.addEventListener("close", () => queue.then(() => finish(failure || new Error("agent host closed the turn early"))));
  });
}
