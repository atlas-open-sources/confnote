import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { HANDLERS, SERVED, TOOL_SPECS, checkArgs, conciergeTools, toolSpec, type ToolEnv } from "../lib/concierge-tools.js";

// Concierge tool parity, hosted side. The Mac half is tests/test_tool_contract.py; both read
// packages/contracts/tools.json, so a tool added, dropped or re-shaped on one host without the spec fails one of them.
const spec = JSON.parse(fs.readFileSync(new URL("../../contracts/tools.json", import.meta.url), "utf8"));
const names: string[] = spec.tools.map((tool: { name: string }) => tool.name);
const notOnHosted = new Set(spec.not_on.filter((entry: { host: string }) => entry.host === "hosted").map((entry: { tool: string }) => entry.tool));

const env: ToolEnv = { ctx: { workspace: "tool-contract" }, slug: "", file: "", deferred: {}, importFromUrl: async () => ({}) };

describe("Concierge tool parity (hosted)", () => {
  it("implements every spec tool except the ones the spec excuses for hosted, and nothing else", () => {
    expect(TOOL_SPECS.map((tool) => tool.name)).toEqual(names);
    expect(new Set(Object.keys(HANDLERS))).toEqual(new Set(names.filter((name) => !notOnHosted.has(name))));
    expect(SERVED).toEqual(names.filter((name) => !notOnHosted.has(name)));
    for (const entry of spec.not_on.filter((item: { host: string }) => item.host === "hosted")) {
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });

  it("gives the model the spec's names, purposes and schemas", async () => {
    const tools = conciergeTools(env, { canvas: true });
    expect(Object.keys(tools).sort()).toEqual([...SERVED].sort());
    for (const [name, defined] of Object.entries(tools)) {
      expect(defined.description).toBe(toolSpec(name).purpose);
      const schema = await (defined.inputSchema as { jsonSchema: unknown }).jsonSchema;
      expect(schema).toEqual(toolSpec(name).input_schema);
    }
  });

  it.each(["draw_conference_board", "draw_mind_map"])("offers the canvas tool %s only where the canvas ships, as the spec's conditional entry says", (name) => {
    expect(spec.conditional.some((entry: { host: string; tool: string }) => entry.host === "hosted" && entry.tool === name)).toBe(true);
    expect(Object.keys(conciergeTools(env, { canvas: false }))).not.toContain(name);
    expect(Object.keys(conciergeTools(env, { canvas: true }))).toContain(name);
  });

  it("checks arguments the way the Mac does", () => {
    const schema = toolSpec("mark_action_done").input_schema;
    expect(checkArgs(schema, { index: 2, done: false })).toEqual({ index: 2, done: false });
    expect(() => checkArgs(schema, { index: 0 })).toThrow(/at least 1/);
    expect(() => checkArgs(schema, { index: true })).toThrow(/integer/);
    expect(() => checkArgs(schema, { note_file: "x.md" })).toThrow(/unknown/);
    expect(() => checkArgs(toolSpec("set_attending").input_schema, { file: "x.md" })).toThrow(/missing attending/);
    expect(() => checkArgs(toolSpec("write_conference_doc").input_schema, { name: "x.md", text: "" })).toThrow(/one of/);
  });
});
