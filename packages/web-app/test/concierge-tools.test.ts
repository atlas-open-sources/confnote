import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

// The hosted Concierge tools over a throwaway workspace, and the hosted Concierge answering "what should I ask at
// the talk I picked?" from the user's picks with a mocked model. The Mac twin is tests/test_concierge_tools.py.
const mocked = vi.hoisted(() => ({ model: null as unknown }));
vi.mock("../lib/byok.js", async (original) => ({
  ...(await original<typeof import("../lib/byok.js")>()),
  directLanguageModel: () => mocked.model,
}));

const { callTool } = await import("../lib/concierge-tools.js");
const { addConference, putPicks } = await import("../lib/service.js");
const { streamWebChatEvents } = await import("../lib/chat.js");

const QUESTION = "What should I ask at the talk I picked?";
const KEYNOTE = "0900-keynote.md";
const PANEL = "0930-panel.md";

function event(id: string, title: string, start: string, end: string, extra: Record<string, unknown> = {}) {
  return { id, type: "talk", title, description: `About ${title}.`, start: `2099-05-03T${start}:00+00:00`, end: `2099-05-03T${end}:00+00:00`, room: "main", ...extra };
}

async function workspace() {
  const ctx = { workspace: `tools-${Date.now()}-${Math.random().toString(16).slice(2)}` };
  const imported = await addConference(ctx, {
    schema_version: "confnote.agenda.v1",
    conference: { name: "Tools Conf", date: "2099-05-03", timezone: "Europe/London" },
    speakers: { ada: { name: "Ada Lovelace", bio: "Wrote the first program." } },
    events: [
      event("keynote", "Agents at Scale", "09:00", "10:00", { speakers: ["ada"] }),
      event("panel", "Evals Panel", "09:30", "10:30", { room: "side" }),
      event("close", "Closing", "11:00", "11:30"),
    ],
  });
  if (!("slug" in imported)) throw new Error("agenda did not import");
  const env = { ctx, slug: imported.slug, file: KEYNOTE, deferred: {}, importFromUrl: async () => ({ error: "offline" }) };
  return { ctx, slug: imported.slug, env };
}

afterEach(() => {
  mocked.model = null;
});

describe("hosted Concierge tools", () => {
  it("reads the picks and their clashes, and picks through set_attending", async () => {
    const { slug, env } = await workspace();
    expect(await callTool("get_my_agenda", {}, env)).toMatchObject({ picks: [], clashes: [] });
    expect(await callTool("set_attending", { file: KEYNOTE, attending: true }, env)).toMatchObject({ notes: [KEYNOTE] });
    await callTool("set_attending", { file: "0930-panel", attending: true }, env); // lenient file, as on the Mac
    const agenda = await callTool("get_my_agenda", { slug }, env);
    expect((agenda.picks as Array<{ file: string }>).map((pick) => pick.file)).toEqual([KEYNOTE, PANEL]);
    expect(agenda.clashes).toEqual([[KEYNOTE, PANEL]]);
  });

  it("reads notes, the digest and speakers, and hides Private", async () => {
    const { env } = await workspace();
    const note = await callTool("read_note", {}, env);
    expect(note.file).toBe(KEYNOTE);
    expect(Object.keys(note.sections as object)).not.toContain("Private");
    expect(String((await callTool("read_notes", {}, env)).digest)).toContain(`Agents at Scale [${KEYNOTE}]`);
    expect(await callTool("research_speakers", { file: KEYNOTE }, env)).toMatchObject({
      title: "Agents at Scale",
      speakers: [{ name: "Ada Lovelace", bio: "Wrote the first program." }],
    });
    expect(await callTool("get_conference", { slug: "2099-01-01-nope" }, env)).toMatchObject({ error: expect.stringMatching(/^No such/) });
  });

  it("writes actions, sections and documents under the spec's names", async () => {
    const { env } = await workspace();
    expect(await callTool("append_action", { text: "Email Ada" }, env)).toMatchObject({ ok: true, file: KEYNOTE });
    expect(await callTool("mark_action_done", { text: "email ada." }, env)).toMatchObject({ ok: true, done: true });
    expect(await callTool("save_research", { text: "Ada built engines.", sources: ["https://example.com/ada"] }, env)).toMatchObject({ section: "Research" });
    const debrief = await callTool("write_conference_doc", { name: "DEBRIEF.md", text: "# Debrief\n\n## Action Items\n\n- [ ] Follow up\n" }, env);
    expect(debrief).toMatchObject({ ok: true, synced_actions: 1 });
    expect(await callTool("get_actions", {}, env)).toMatchObject({ total: 2 });
    expect(await callTool("update_agent_section", { section: "Brief", text: "x" }, env)).toMatchObject({ error: expect.stringMatching(/^Invalid arguments/) });
  });

  it("keeps the Concierge's own files the way the Mac does", async () => {
    const { slug, env } = await workspace();
    expect(await callTool("save_artifact", { name: "agenda-source.json", content: "{}" }, env)).toMatchObject({ ok: true });
    expect(await callTool("move_artifact", { name: "agenda-source.json", slug }, env)).toMatchObject({ ok: true });
    expect(await callTool("read_artifact", { name: "agenda-source.json", slug }, env)).toMatchObject({ content: "{}" });
    expect(await callTool("read_artifact", { name: "agenda-source.json" }, env)).toMatchObject({ error: expect.any(String) });
    expect(await callTool("save_artifact", { name: "../x", content: "" }, env)).toMatchObject({ error: expect.stringMatching(/^Rejected/) });
    expect(await callTool("validate_conference", { agenda_json: "{" }, env)).toMatchObject({ ok: false });
  });

  it("labels fetched pages untrusted and refuses local addresses", async () => {
    const { env } = await workspace();
    expect(await callTool("fetch_url", { url: "http://127.0.0.1:11434/health" }, env)).toMatchObject({ error: expect.any(String) });
    expect(await callTool("fetch_url", { url: "http://localhost:8787/" }, env)).toMatchObject({ error: expect.any(String) });
  });
});

describe("hosted Concierge answers from the picks", () => {
  it("answers what to ask at the talk the user picked", async () => {
    const { ctx, slug } = await workspace();
    await putPicks(ctx, slug, { picks: { [KEYNOTE]: true } });
    let step = 0;
    let toolResult = "";
    const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
    mocked.model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        step += 1;
        if (step === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "tool-call", toolCallId: "picks", toolName: "get_my_agenda", input: "{}" },
                { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
              ],
            }),
          };
        }
        toolResult = JSON.stringify(prompt.at(-1));
        const pick = /"title":"([^"]+)"/.exec(toolResult)?.[1] || "nothing";
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: `At ${pick}, ask Ada how she tests agents.` },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
            ],
          }),
        };
      },
    });
    const events: Array<Record<string, unknown>> = [];
    await streamWebChatEvents(
      ctx,
      { slug, body: { messages: [{ role: "user", text: QUESTION }], byok: { provider: "anthropic", apiKey: "fixture-key-123", model: "fixture-model" } } }, // pragma: allowlist secret
      (event) => {
        events.push(event as Record<string, unknown>);
      },
    );
    const text = events.map((event) => event.text || "").join("");
    expect(text).toContain("At Agents at Scale, ask Ada");
    expect(toolResult).toContain(KEYNOTE);
    expect(events.at(-1)).toEqual({ done: true });
  });
});
