import { describe, expect, it } from "vitest";
import { FrameError, parseStart, promptFor, routerRefusal } from "../src/protocol.js";

const start = {
  type: "start",
  routerToken: "tok",
  walletUser: "user_1",
  system: "sys",
  messages: [{ role: "user", content: "hi" }],
  tools: [{ name: "list_conferences", description: "d", input_schema: { type: "object" } }],
};

describe("parseStart", () => {
  it("accepts a well-formed start", () => {
    expect(parseStart(start).walletUser).toBe("user_1");
  });
  it("refuses a wallet id that could inject a header", () => {
    expect(() => parseStart({ ...start, walletUser: "u\r\nx-evil: 1" })).toThrow(FrameError);
  });
  it("refuses a turn that does not end with the user", () => {
    expect(() => parseStart({ ...start, messages: [{ role: "assistant", content: "x" }] })).toThrow(FrameError);
  });
  it("refuses bad tool names and a missing token", () => {
    expect(() => parseStart({ ...start, tools: [{ ...start.tools[0], name: "Bash" }] })).toThrow(FrameError);
    expect(() => parseStart({ ...start, routerToken: "" })).toThrow(FrameError);
  });
});

describe("promptFor", () => {
  it("passes a single message through and wraps history", () => {
    expect(promptFor([{ role: "user", content: "hi" }])).toBe("hi");
    const prompt = promptFor([{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }]);
    expect(prompt).toContain("User: a");
    expect(prompt).toContain("Concierge: b");
    expect(prompt.endsWith("c")).toBe(true);
  });
});

describe("routerRefusal", () => {
  it("reads the status and wallet body from the CLI's API error text", () => {
    const refusal = routerRefusal('API Error: 402 {"error":"insufficient_credits","buyMoreUrl":"https://x"}');
    expect(refusal).toEqual({ status: 402, body: { error: "insufficient_credits", buyMoreUrl: "https://x" } });
    expect(routerRefusal("something else")).toBeNull();
  });
});
