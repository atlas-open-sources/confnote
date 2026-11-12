import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APICallError } from "ai";
import { agentHostEngineSelected, runAgentHostTurn } from "../lib/agent-host.js";
import { routerFailureEvent } from "../lib/chat.js";
import type { ToolEnv } from "../lib/concierge-tools.js";

// A stand-in for the agent host's socket: it records what confnote sends and replays a scripted host.
type Frame = Record<string, unknown>;
let script: (socket: FakeSocket, frame: Frame) => void;
let sockets: FakeSocket[] = [];

class FakeSocket extends EventTarget {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readyState = 0;
  sent: Frame[] = [];
  constructor(readonly url: string) {
    super();
    sockets.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    });
  }
  send(data: string) {
    const frame = JSON.parse(data) as Frame;
    this.sent.push(frame);
    script(this, frame);
  }
  host(frame: Frame) {
    const event = new Event("message") as Event & { data: string };
    event.data = JSON.stringify(frame);
    this.dispatchEvent(event);
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

const env = { ctx: {}, slug: "", file: "", deferred: {}, importFromUrl: async () => ({}) } as unknown as ToolEnv;

function turn(overrides: Partial<Parameters<typeof runAgentHostTurn>[1]> = {}) {
  const texts: string[] = [];
  const tools: Array<[string, Record<string, unknown>]> = [];
  return {
    texts,
    tools,
    turn: {
      env,
      system: "sys",
      messages: [{ role: "user" as const, content: "hello" }],
      canvas: false,
      onText: async (text: string) => {
        texts.push(text);
      },
      onToolResult: async (name: string, output: Record<string, unknown>) => {
        tools.push([name, output]);
      },
      ...overrides,
    },
  };
}

beforeEach(() => {
  sockets = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubEnv("CONFNOTE_AGENT_HOST_URL", "https://agent-host.test");
  vi.stubEnv("CONFNOTE_ROUTER_SERVICE_TOKEN", "router-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("agent host engine", () => {
  it("is selected only by CONFNOTE_CONCIERGE_ENGINE=agent-host", () => {
    vi.stubEnv("CONFNOTE_CONCIERGE_ENGINE", "agent-sdk");
    expect(agentHostEngineSelected()).toBe(false);
    vi.stubEnv("CONFNOTE_CONCIERGE_ENGINE", "agent-host");
    expect(agentHostEngineSelected()).toBe(true);
  });

  it("sends the turn with the wallet id from the principal, streams text and runs relayed tools here", async () => {
    script = (socket, frame) => {
      if (frame.type === "start") {
        socket.host({ type: "text", text: "Checking." });
        socket.host({ type: "tool_call", id: "t1", name: "validate_conference", args: { agenda_json: "not json" } });
      }
      if (frame.type === "tool_result") {
        socket.host({ type: "text", text: "\n\nDone." });
        socket.host({ type: "done" });
      }
    };
    const { texts, tools, turn: request } = turn();
    await runAgentHostTurn({ principal: { userId: "user_42" } }, request);
    const [socket] = sockets;
    expect(socket.url).toBe("wss://agent-host.test/v1/turn");
    const start = socket.sent[0];
    expect(start).toMatchObject({ type: "start", routerToken: "router-token", walletUser: "user_42", system: "sys" });
    const toolNames = (start.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(toolNames).toContain("list_conferences");
    expect(toolNames).toContain("fetch_url");
    expect(toolNames).not.toContain("web_search");
    expect(toolNames).not.toContain("draw_mind_map");
    expect(socket.sent[1]).toMatchObject({ type: "tool_result", id: "t1", result: { ok: false } });
    expect(tools[0][0]).toBe("validate_conference");
    expect(texts.join("")).toBe("Checking.\n\nDone.");
  });

  it("turns the Router's 402 relayed by the host into the buy-more event", async () => {
    script = (socket, frame) => {
      if (frame.type !== "start") return;
      socket.host({ type: "error", error: "billing_error", status: 402, body: { error: "insufficient_credits", buyMoreUrl: "https://pay.test", available: 0, required: 5 } });
      socket.host({ type: "done" });
    };
    const error = await runAgentHostTurn({ principal: { userId: "user_42" } }, turn().turn).catch((caught) => caught);
    expect(APICallError.isInstance(error)).toBe(true);
    expect(routerFailureEvent(error)).toMatchObject({ status: 402, buyMoreUrl: "https://pay.test", available: 0, required: 5 });
  });

  it("refuses to run without a signed-in user, so the browser can never pick the wallet", async () => {
    await expect(runAgentHostTurn({}, turn().turn)).rejects.toThrow(/not signed in/);
    expect(sockets).toHaveLength(0);
  });

  it("fails the turn when the host closes without done", async () => {
    script = (socket, frame) => {
      if (frame.type === "start") socket.close();
    };
    await expect(runAgentHostTurn({ principal: { userId: "u" } }, turn().turn)).rejects.toThrow(/closed the turn early/);
  });
});
