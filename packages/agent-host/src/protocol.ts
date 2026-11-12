// The wire between confnote's web app (the trusted caller) and this agent host: one WebSocket per Concierge turn.
// confnote sends `start`, the host streams text and asks confnote to run each confnote tool (`tool_call`), confnote
// answers with `tool_result`. The host never touches confnote storage; the user's identity never leaves confnote
// except as the Router wallet id the caller already bills.

export interface TurnMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface StartFrame {
  type: "start";
  /** The caller's Mochi Router service token; the Router, not this host, decides whether it is valid. */
  routerToken: string;
  /** The Router wallet the turn is billed to, set by confnote from its signed-in principal. */
  walletUser: string;
  system: string;
  messages: TurnMessage[];
  tools: ToolDescriptor[];
}

export interface ToolResultFrame {
  type: "tool_result";
  id: string;
  result: Record<string, unknown>;
}

export type ClientFrame = StartFrame | ToolResultFrame;

export type HostFrame =
  | { type: "text"; text: string }
  | { type: "notice"; notice: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "error"; error: string; status?: number; body?: unknown }
  | { type: "done" };

const LIMITS = {
  messages: 60,
  contentChars: 200_000,
  systemChars: 40_000,
  tools: 40,
  descriptionChars: 4_000,
  tokenChars: 512,
};
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
// The wallet id goes into an HTTP header: no CR/LF, no colon-free tricks, a short opaque id only.
const WALLET_USER = /^[A-Za-z0-9_.@|:+-]{1,200}$/;

export class FrameError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Validates the caller's first frame; throws FrameError with a short reason. */
export function parseStart(raw: unknown): StartFrame {
  if (!isRecord(raw) || raw.type !== "start") throw new FrameError("first frame must be start");
  const { routerToken, walletUser, system, messages, tools } = raw;
  if (typeof routerToken !== "string" || !routerToken || routerToken.length > LIMITS.tokenChars || /\s/.test(routerToken)) {
    throw new FrameError("routerToken is required");
  }
  if (typeof walletUser !== "string" || !WALLET_USER.test(walletUser)) throw new FrameError("walletUser is invalid");
  if (typeof system !== "string" || system.length > LIMITS.systemChars) throw new FrameError("system is invalid");
  if (!Array.isArray(messages) || !messages.length || messages.length > LIMITS.messages) throw new FrameError("messages are invalid");
  let chars = 0;
  const cleanMessages: TurnMessage[] = messages.map((message) => {
    if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string") {
      throw new FrameError("a message is invalid");
    }
    chars += message.content.length;
    return { role: message.role, content: message.content };
  });
  if (chars > LIMITS.contentChars) throw new FrameError("messages are too long");
  if (cleanMessages[cleanMessages.length - 1].role !== "user") throw new FrameError("the last message must be the user's");
  if (!Array.isArray(tools) || tools.length > LIMITS.tools) throw new FrameError("tools are invalid");
  const seen = new Set<string>();
  const cleanTools: ToolDescriptor[] = tools.map((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string" || !TOOL_NAME.test(entry.name) || seen.has(entry.name)) {
      throw new FrameError("a tool name is invalid");
    }
    if (typeof entry.description !== "string" || entry.description.length > LIMITS.descriptionChars || !isRecord(entry.input_schema)) {
      throw new FrameError(`tool ${entry.name} is invalid`);
    }
    seen.add(entry.name);
    return { name: entry.name, description: entry.description, input_schema: entry.input_schema };
  });
  return { type: "start", routerToken, walletUser, system, messages: cleanMessages, tools: cleanTools };
}

/** The conversation as one prompt: earlier turns as a transcript, then the user's latest message. */
export function promptFor(messages: TurnMessage[]): string {
  const latest = messages[messages.length - 1].content;
  const earlier = messages.slice(0, -1);
  if (!earlier.length) return latest;
  const transcript = earlier.map((message) => `${message.role === "user" ? "User" : "Concierge"}: ${message.content}`).join("\n\n");
  return `<conversation_so_far>\n${transcript}\n</conversation_so_far>\n\nThe user's new message:\n${latest}`;
}

/**
 * A Router refusal inside the CLI's API-error text ("API Error: 402 {...}"): the status and the JSON body, so the
 * caller can show the same buy-more card it shows for its own Router calls.
 */
export function routerRefusal(text: string): { status: number; body?: unknown } | null {
  const match = /\b(402|429|503|401|403)\b/.exec(text);
  if (!match) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  let body: unknown;
  if (start >= 0 && end > start) {
    try {
      body = JSON.parse(text.slice(start, end + 1));
    } catch {
      body = undefined;
    }
  }
  return { status: Number(match[1]), body };
}
