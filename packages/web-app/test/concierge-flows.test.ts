import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";

// Concierge flows on the web: import by link (file, feed, event data, linked file, page text), the brief with
// speaker research, and the tldraw board. A scripted model stands in for the Router; nothing leaves the process.

const pages = vi.hoisted(() => ({ raw: new Map<string, string>(), fetched: [] as string[] }));
vi.mock("../lib/webResearch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/webResearch.js")>()),
  fetchUrlRaw: async (url: string) => {
    pages.fetched.push(url);
    const text = pages.raw.get(url);
    return text === undefined ? { error: "Fetch returned HTTP 404." } : { url, text };
  },
  fetchUrlText: async (url: string) => {
    const text = pages.raw.get(url);
    if (text === undefined) return { error: "Fetch returned HTTP 404." };
    return { url, title: "Fixture Summit", contentType: "text/html", text: text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ") };
  },
}));
const spies = vi.hoisted(() => ({ direct: vi.fn() }));
vi.mock("../lib/byok.js", async (original) => ({ ...(await original<typeof import("../lib/byok.js")>()), directLanguageModel: spies.direct }));

import { agendaFromExtraction, agendaFromIcal, agendaFromJsonLd, agendaLinks, zonedIso } from "../lib/agenda-link.js";
import { BOARD_MODULE, buildBoardSpec } from "../lib/board.js";
import { mergedBrief, SPEAKER_RESEARCH_MODULE } from "../lib/event-brief.js";

const byok = { provider: "openai", apiKey: "synthetic-fixture-key", model: "fixture-model" }; // pragma: allowlist secret
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };

type Part = Record<string, unknown>;
function stream(parts: Part[]) {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
  };
}
function textReply(text: string, finish = "stop"): Part[] {
  return [
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: finish, raw: finish }, usage },
  ];
}
function toolCall(toolName: string, input: unknown): Part[] {
  return [
    { type: "tool-call", toolCallId: `call-${toolName}`, toolName, input: JSON.stringify(input) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
  ];
}
function promptText(options: { prompt: Array<{ role: string; content: unknown }> }): string {
  return JSON.stringify(options.prompt);
}

const agenda = {
  schema_version: "confnote.agenda.v1",
  conference: { name: "Fixture Summit", date: "2099-05-04", timezone: "Europe/London" },
  speakers: { ada: { name: "Ada Lovelace", company: "Engines" }, alan: { name: "Alan Turing" }, grace: { name: "Grace Hopper" } },
  events: [
    { id: "doors", type: "logistics", title: "Doors", start: "2099-05-04T08:00:00+01:00", end: "2099-05-04T09:00:00+01:00", speakers: [] },
    { id: "keynote", type: "keynote", title: "Opening keynote", start: "2099-05-04T09:00:00+01:00", end: "2099-05-04T10:00:00+01:00", speakers: ["ada"] },
    { id: "agents", type: "talk", title: "Agents", start: "2099-05-04T10:00:00+01:00", end: "2099-05-04T10:40:00+01:00", room: "A", speakers: ["alan"] },
    { id: "compilers", type: "talk", title: "Compilers", start: "2099-05-04T10:00:00+01:00", end: "2099-05-04T10:40:00+01:00", room: "B", speakers: ["grace"] },
    { id: "lunch", type: "lunch", title: "Lunch", start: "2099-05-04T12:00:00+01:00", end: "2099-05-04T13:00:00+01:00", speakers: [] },
  ],
};

let root = "";
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "confnote-concierge-"));
  vi.stubEnv("CONFNOTE_STORAGE", "fs");
  vi.stubEnv("CONFNOTE_WEB_DATA_DIR", root);
  vi.stubEnv("CONFNOTE_TLDRAW", "1");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

async function run(workspace: string, text: string, model?: MockLanguageModelV3, slug?: string) {
  const { streamWebChatEvents } = await import("../lib/chat.js");
  if (model) spies.direct.mockReturnValue(model);
  const events: Array<Record<string, unknown>> = [];
  await streamWebChatEvents({ workspace }, { slug, body: { ...(model ? { byok } : {}), messages: [{ role: "user", text }] } }, (event) => {
    events.push(event as Record<string, unknown>);
  });
  return events;
}

describe("agenda links", () => {
  it("gives local times their zone's offset, either side of a DST change", () => {
    expect(zonedIso("2099-05-04T09:00", "Europe/London")).toBe("2099-05-04T09:00:00+01:00");
    expect(zonedIso("2099-01-04T09:00", "Europe/London")).toBe("2099-01-04T09:00:00+00:00");
    expect(zonedIso("2026-09-29T11:15", "America/Los_Angeles")).toBe("2026-09-29T11:15:00-07:00");
    expect(zonedIso("not a time", "Europe/London")).toBeNull();
  });

  it("reads an iCal feed with TZID times into sessions", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "X-WR-CALNAME:Fixture Summit",
      "BEGIN:VEVENT",
      "SUMMARY:Opening keynote",
      "DTSTART;TZID=Europe/London:20990504T090000",
      "DTEND;TZID=Europe/London:20990504T100000",
      "LOCATION:Main hall",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "SUMMARY:Coffee break",
      "DTSTART:20990504T090000Z",
      "DTEND:20990504T093000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const parsed = agendaFromIcal(ics, "https://fixture.test/feed.ics");
    expect(parsed?.conference).toMatchObject({ name: "Fixture Summit", date: "2099-05-04" });
    expect(parsed?.events.map((event) => [event.title, event.start, event.type, event.room])).toEqual([
      ["Opening keynote", "2099-05-04T09:00:00+01:00", "keynote", "Main hall"],
      ["Coffee break", "2099-05-04T09:00:00Z", "break", ""],
    ]);
  });

  it("reads schema.org subEvents from JSON-LD", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "Event",
      name: "Fixture Summit",
      startDate: "2099-05-04",
      subEvent: [{ "@type": "Event", name: "Agents", startDate: "2099-05-04T10:00:00+01:00", endDate: "2099-05-04T10:40:00+01:00", performer: { name: "Alan Turing" } }],
    })}</script>`;
    const parsed = agendaFromJsonLd(html, "https://fixture.test/");
    expect(parsed?.events).toHaveLength(1);
    expect(parsed?.events[0]).toMatchObject({ title: "Agents", speakers: ["Alan Turing"] });
  });

  it("keeps every complete session row from a reply cut off at the token cap", () => {
    const cut =
      '```json\n{"conference":{"name":"Cut Summit","date":"2099-05-04","timezone":"Europe/London"},"sessions":[' +
      '["2099-05-04T09:00","2099-05-04T09:30","Doors [main]","Hall","","break"],' +
      '["2099-05-04T10:00","2099-05-04T10:40","Agents","A","Alan Turing; Grace Hopper","talk"],' +
      '["2099-05-04T11:00","2099-05-04T11';
    const parsed = agendaFromExtraction(cut, "https://cut.test/");
    expect(parsed?.events.map((event) => event.title)).toEqual(["Doors [main]", "Agents"]);
    expect(parsed?.events[1]).toMatchObject({ start: "2099-05-04T10:00:00+01:00", speakers: ["Alan Turing", "Grace Hopper"] });
  });

  it("survives malformed third-party event data instead of throwing", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "Event",
      name: 42,
      subEvent: [null, { "@type": "Event", name: 7, startDate: "2099-13-45T99:99:00Z", performer: [null, { name: {} }] }, { "@type": "Event", name: "Real", startDate: "2099-05-04T10:00:00+01:00", endDate: "bad" }],
    })}</script>`;
    const parsed = agendaFromJsonLd(html, "https://bad.test/");
    expect(parsed?.events.map((event) => [event.title, event.end])).toEqual([["Real", "2099-05-04T09:30:00Z"]]);
  });

  it("refuses a conference date that would nest folders", async () => {
    const { addConference } = await import("../lib/service.js");
    const result = await addConference({ workspace: `nest-${Date.now()}` }, { ...agenda, conference: { name: "X", date: "2099-05-04/other" } });
    expect(result).toMatchObject({ ok: false, errors: ["conference.date must be YYYY-MM-DD"] });
  });

  it("ranks agenda-looking files and turns webcal into https", () => {
    const html = '<a href="/site.webmanifest"></a><a href="/data/misc.json"></a><a href="webcal://fixture.test/schedule.ics"></a>';
    expect(agendaLinks(html, "https://fixture.test/")).toEqual(["https://fixture.test/schedule.ics", "https://fixture.test/data/misc.json"]);
  });
});

describe("import by link", () => {
  it("imports a website through the agenda file it links to and offers the brief", async () => {
    pages.raw.set("https://summit.test/", '<html><title>Fixture Summit</title><a href="/agenda.json">Agenda</a></html>');
    pages.raw.set("https://summit.test/agenda.json", JSON.stringify(agenda));
    const model = new MockLanguageModelV3({ doStream: async () => stream(textReply("unused")) });
    const events = await run(`link-${Date.now()}`, "https://summit.test/", model);
    const reply = events.filter((event) => "text" in event).map((event) => event.text).join("");
    expect(reply).toContain("Imported **Fixture Summit** from the agenda file the page links to");
    expect(reply).toContain("3 sessions on 2099-05-04, 3 speakers, 1 time slot with parallel sessions");
    expect(reply).toContain("Want me to prepare a brief and research the speakers?");
    expect(events.some((event) => "conference_imported" in event)).toBe(true);
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it("reads the page with the model when the site has no agenda file", async () => {
    pages.raw.set("https://plain.test/", "<html><body>Fixture Summit, 4 May 2099. 10:00 Agents with Alan Turing.</body></html>");
    const model = new MockLanguageModelV3({
      doStream: async () =>
        stream(
          textReply(
            '```json\n{"conference":{"name":"Plain Summit","date":"2099-05-04","timezone":"Europe/London"},"sessions":[["2099-05-04T10:00","2099-05-04T10:40","Agents","","Alan Turing","talk"]]}\n```',
          ),
        ),
    });
    const events = await run(`page-${Date.now()}`, "https://plain.test/", model);
    expect(events.find((event) => "notice" in event && String(event.notice).includes("Reading the page"))).toBeTruthy();
    const imported = events.find((event) => "conference_imported" in event) as { conference_imported: { slug: string } } | undefined;
    expect(imported?.conference_imported.slug).toBe("2099-05-04-plain-summit");
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("says what to paste instead when there is no model and no agenda file", async () => {
    pages.raw.set("https://nomodel.test/", "<html><body>No agenda here</body></html>");
    const events = await run(`nomodel-${Date.now()}`, "https://nomodel.test/");
    expect(String(events.find((event) => "text" in event)?.text)).toContain("Paste the agenda JSON");
  });
});

describe("brief and speaker research", () => {
  it("keeps a person's brief and replaces only an earlier Concierge brief", () => {
    const generated = "# Brief: X\n\n*Prepared by the Concierge from the agenda on 2099-01-01. Edit freely.*\n";
    expect(mergedBrief("", generated)).toBe(generated);
    expect(mergedBrief("_Prepared by the Concierge from the agenda on 2098-01-01._ old", generated)).toBe(generated);
    expect(mergedBrief("My own plan", generated)).toBe(`My own plan\n\n---\n\n${generated}`);
  });

  it("runs after the agent's reply: writes BRIEF.md, a note per speaker and every session's Research", async () => {
    const workspace = `brief-${Date.now()}`;
    const { addConference, confDocPayload, moduleStatePayload, notePayload } = await import("../lib/service.js");
    const imported = await addConference({ workspace }, agenda);
    if (!("slug" in imported)) throw new Error("fixture import failed");
    let agentTurn = 0;
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        const prompt = promptText(options as never);
        if (prompt.includes("opinionated part of my brief")) {
          return stream(textReply('```json\n{"themes":[{"name":"Agents","why":"Agents everywhere."}],"picks":[{"id":"agents","why":"The core talk."}],"prep":["Read the papers."]}\n```'));
        }
        if (prompt.includes("For every session")) return stream(textReply(SESSION_REPLY));
        agentTurn += 1;
        return stream(agentTurn === 1 ? toolCall("prepare_event_brief", {}) : textReply("On it."));
      },
    });
    const events = await run(workspace, "Prepare a brief for the event and research each speaker", model, imported.slug);
    const notices = events.filter((event) => "notice" in event).map((event) => event.notice);
    expect(notices).toContain("Wrote BRIEF.md.");
    expect(notices).toContain("Researched 3 of 3 speakers.");
    expect(notices).toContain("Wrote Research for 3 of 3 sessions.");
    const reply = events.filter((event) => "text" in event).map((event) => event.text).join("");
    expect(reply).toContain("every session has its **Research**");
    expect(events.at(-1)).toEqual({ done: true });
    const docs = await confDocPayload({ workspace }, imported.slug);
    expect(docs?.brief).toMatch(/^# Brief: Fixture Summit\n\n\*Prepared by the Concierge/);
    expect(docs?.brief).toContain("\n\n## At a glance\n");
    expect(docs?.brief).toContain("## Don't miss");
    expect(docs?.brief).toContain("**10:00 Agents** (Alan Turing): The core talk.");
    expect(docs?.brief).toContain("## Decide before you go");
    const research = (await moduleStatePayload({ workspace }, SPEAKER_RESEARCH_MODULE, imported.slug)) as {
      speakers: Record<string, { who: string; talk: string; ask: string; sessions: string[] }>;
    };
    expect(research.speakers["Grace Hopper"]).toMatchObject({ who: "", talk: "Why compilers matter.", ask: "Why COBOL?" });
    expect(research.speakers["Grace Hopper"].sessions).toHaveLength(1);
    const note = await notePayload({ workspace }, imported.slug, research.speakers["Ada Lovelace"].sessions[0]);
    expect(note?.sections.Research).toBe(
      [
        "*Prepared by the Concierge from the agenda on " + new Date().toISOString().slice(0, 10) + ". Ask this session's Concierge to research it further on the web.*",
        "",
        "**The talk:** Opens the day.",
        "",
        "**Listen for:** The roadmap.",
        "",
        "### Ada Lovelace",
        "- **Who:** Engines founder.",
        "- **Ask:** What next?",
      ].join("\n"),
    );
  });

  it("replaces the seed and its own untouched Research, never research someone wrote or edited", async () => {
    const workspace = `brief-keep-${Date.now()}`;
    const { addConference, conferencePayload, notePayload, putAgentNoteSections } = await import("../lib/service.js");
    const imported = await addConference({ workspace }, agenda);
    if (!("slug" in imported)) throw new Error("fixture import failed");
    const files = Object.fromEntries(((await conferencePayload({ workspace }, imported.slug))?.events || []).map((event) => [event.id, String(event.note)]));
    await putAgentNoteSections({ workspace }, imported.slug, files.agents, { Research: "My own dossier on Alan." });
    const { prepareEventBrief } = await import("../lib/event-brief.js");
    let reply = SESSION_REPLY;
    const model = new MockLanguageModelV3({
      doStream: async (options) => stream(textReply(promptText(options as never).includes("For every session") ? reply : "{}")),
    });
    const first = await prepareEventBrief({ workspace }, imported.slug, model, () => {}, () => {}, Date.now() + 60_000);
    expect(first).toMatchObject({ sessionsResearched: 2, sessionsTotal: 3, failedCalls: 0 });
    expect((await notePayload({ workspace }, imported.slug, files.agents))?.sections.Research).toBe("My own dossier on Alan.");
    expect((await notePayload({ workspace }, imported.slug, files.compilers))?.sections.Research).toContain("**The talk:** Why compilers matter.");
    expect((await notePayload({ workspace }, imported.slug, files.keynote))?.sections.Research).toContain("### Ada Lovelace\n- **Who:** Engines founder.");

    // Someone adds to the keynote's note but keeps the Concierge line; the compilers note stays as written.
    const keynote = (await notePayload({ workspace }, imported.slug, files.keynote))?.sections.Research || "";
    await putAgentNoteSections({ workspace }, imported.slug, files.keynote, { Research: `${keynote}\n\nMy follow-up: ask about the roadmap dates.` });
    reply = SESSION_REPLY.replaceAll("Opens the day.", "Opens it again.").replaceAll("Why compilers matter.", "Compilers, again.");
    const second = await prepareEventBrief({ workspace }, imported.slug, model, () => {}, () => {}, Date.now() + 60_000);
    expect(second).toMatchObject({ sessionsResearched: 1 });
    expect((await notePayload({ workspace }, imported.slug, files.compilers))?.sections.Research).toContain("**The talk:** Compilers, again.");
    const kept = (await notePayload({ workspace }, imported.slug, files.keynote))?.sections.Research;
    expect(kept).toContain("My follow-up: ask about the roadmap dates.");
    expect(kept).toContain("**The talk:** Opens the day.");
  });

  it("batches research by sessions and speakers so a call's reply fits its cap", async () => {
    const { researchBatches, researchSessions, SESSIONS_PER_CALL, SPEAKERS_PER_CALL } = await import("../lib/event-brief.js");
    const seed = JSON.parse(await fs.readFile(path.join(__dirname, "../../../tests/e2e/seed-agenda.json"), "utf8")) as { events: Array<{ type?: string; speakers?: string[] }> };
    const sessions = researchSessions(seed.events);
    expect(sessions).toHaveLength(13);
    const batches = researchBatches(sessions);
    expect(batches.flat()).toEqual(sessions);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(SESSIONS_PER_CALL);
      const speakers = batch.reduce((sum, event) => sum + (event.speakers || []).length, 0);
      expect(speakers <= SPEAKERS_PER_CALL || batch.length === 1).toBe(true);
    }
  });

  it("keeps the sessions a reply finished before the token cap cut it off", async () => {
    const workspace = `brief-cut-${Date.now()}`;
    const { addConference, conferencePayload, notePayload } = await import("../lib/service.js");
    const imported = await addConference({ workspace }, agenda);
    if (!("slug" in imported)) throw new Error("fixture import failed");
    const { completeObjects, prepareEventBrief } = await import("../lib/event-brief.js");
    expect(completeObjects('{"sessions":[{"id":"a","talk":"x {not} \\"quoted\\""},{"id":"b","talk":"cut', "sessions")).toEqual([
      { id: "a", talk: 'x {not} "quoted"' },
    ]);
    const cut = SESSION_REPLY.slice(0, SESSION_REPLY.indexOf('{"id":"compilers"') + 30);
    const model = new MockLanguageModelV3({
      doStream: async (options) => stream(textReply(promptText(options as never).includes("For every session") ? cut : "{}", "length")),
    });
    const outcome = await prepareEventBrief({ workspace }, imported.slug, model, () => {}, () => {}, Date.now() + 60_000);
    expect(outcome).toMatchObject({ sessionsResearched: 2, speakersResearched: 2 });
    const files = Object.fromEntries(((await conferencePayload({ workspace }, imported.slug))?.events || []).map((event) => [event.id, String(event.note)]));
    expect((await notePayload({ workspace }, imported.slug, files.agents))?.sections.Research).toContain("**The talk:** Agents in practice.");
  });
});

const SESSION_REPLY =
  '```json\n{"sessions":[' +
  '{"id":"keynote","talk":"Opens the day.","listen":"The roadmap.","speakers":[{"name":"Ada Lovelace (Engines)","who":"Engines founder.","ask":"What next?"}]},' +
  '{"id":"agents","talk":"Agents in practice.","listen":"","speakers":[{"name":"Alan Turing","who":"Not stated in the agenda.","ask":"How do they stop?"}]},' +
  '{"id":"compilers","talk":"Why compilers matter.","listen":"","speakers":[{"name":"Grace Hopper","who":"Not stated in the agenda.","ask":"Why COBOL?"}]}' +
  "]}\n```";

describe("brief failures", () => {
  it("shows the buy-more card when a step runs out of credits, after saving what finished", async () => {
    const workspace = `brief-402-${Date.now()}`;
    const { addConference } = await import("../lib/service.js");
    const imported = await addConference({ workspace }, agenda);
    if (!("slug" in imported)) throw new Error("fixture import failed");
    const { prepareEventBrief } = await import("../lib/event-brief.js");
    const { routerFailureEvent } = await import("../lib/chat.js");
    const { APICallError } = await import("ai");
    const credits = new APICallError({
      message: "insufficient",
      url: "https://router.test/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 402,
      responseBody: JSON.stringify({ error: "insufficient_credits", available: 0, required: 9000, buyMoreUrl: "https://router.test/buy" }),
    });
    expect(routerFailureEvent(credits)).toMatchObject({ status: 402 });
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        if (promptText(options as never).includes("For every session")) throw credits;
        return stream(textReply('```json\n{"themes":[],"picks":[],"prep":["Sleep."]}\n```'));
      },
    });
    const failures: unknown[] = [];
    const outcome = await prepareEventBrief({ workspace }, imported.slug, model, () => {}, (error) => failures.push(error), Date.now() + 60_000);
    expect(outcome).toMatchObject({ briefWritten: true, speakersResearched: 0, sessionsResearched: 0, failedCalls: 1 });
    expect(failures).toEqual([credits]);
  });

  it("runs the steps an in-flight auto top-up refused once more after the credits land", async () => {
    const workspace = `brief-topup-${Date.now()}`;
    const { addConference } = await import("../lib/service.js");
    const imported = await addConference({ workspace }, agenda);
    if (!("slug" in imported)) throw new Error("fixture import failed");
    const { prepareEventBrief } = await import("../lib/event-brief.js");
    const { topUpInFlight } = await import("../lib/chat.js");
    const { APICallError } = await import("ai");
    const inFlight = new APICallError({
      message: "insufficient",
      url: "https://router.test/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 402,
      responseBody: JSON.stringify({ error: "insufficient_credits", available: 0, required: 9000, buyMoreUrl: "https://router.test/buy", autoTopUp: "in_flight" }),
    });
    let refused = 0;
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        if (!promptText(options as never).includes("For every session")) return stream(textReply("{}"));
        refused += 1;
        if (refused === 1) throw inFlight;
        return stream(textReply(SESSION_REPLY));
      },
    });
    const waits: unknown[] = [];
    const failures: unknown[] = [];
    const outcome = await prepareEventBrief({ workspace }, imported.slug, model, () => {}, (error) => failures.push(error), Date.now() + 60_000, new Date(), {
      pending: topUpInFlight,
      wait: async (error) => {
        waits.push(error);
        return true;
      },
    });
    expect(waits).toEqual([inFlight]);
    expect(failures).toEqual([]);
    expect(outcome).toMatchObject({ briefWritten: true, sessionsResearched: 3, speakersResearched: 3, failedCalls: 0 });
  });

  it("starts no step once the turn's time is spent", async () => {
    const workspace = `brief-late-${Date.now()}`;
    const { addConference } = await import("../lib/service.js");
    const imported = await addConference({ workspace }, agenda);
    if (!("slug" in imported)) throw new Error("fixture import failed");
    const { prepareEventBrief, OutOfTime } = await import("../lib/event-brief.js");
    const model = new MockLanguageModelV3({ doStream: async () => stream(textReply("{}")) });
    const failures: unknown[] = [];
    const outcome = await prepareEventBrief({ workspace }, imported.slug, model, () => {}, (error) => failures.push(error), Date.now() + 5_000);
    expect(model.doStreamCalls).toHaveLength(0);
    expect(outcome).toMatchObject({ briefWritten: false, failedCalls: 2 });
    expect(failures.every((error) => error instanceof OutOfTime)).toBe(true);
  });
});

describe("tldraw board", () => {
  it("lays out one day by theme with rests kept out of the themes", () => {
    const spec = buildBoardSpec("2099-05-04-fixture-summit", agenda.conference, agenda.events.map((event) => ({ ...event, speakers: [] })), {
      themes: [{ name: "Systems", sessions: ["agents", "compilers", "missing"] }],
    });
    if ("error" in spec) throw new Error(spec.error);
    expect(spec.themes).toEqual([
      { name: "Systems", color: "blue" },
      { name: "Other", color: "grey" },
    ]);
    expect(spec.slots).toEqual(["08:00", "09:00", "10:00", "12:00"]);
    expect(spec.sessions.find((session) => session.id === "keynote")?.theme).toBe(1);
    expect(spec.sessions.find((session) => session.id === "lunch")).toMatchObject({ rest: true, theme: -1 });
  });

  it("is drawn by the Concierge: stored per conference and the canvas drawer opens", async () => {
    const workspace = `board-${Date.now()}`;
    const { addConference, moduleStatePayload } = await import("../lib/service.js");
    const imported = await addConference({ workspace }, agenda);
    if (!("slug" in imported)) throw new Error("fixture import failed");
    let turn = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        turn += 1;
        return stream(turn === 1 ? toolCall("draw_conference_board", { themes: [{ name: "Systems", sessions: ["agents", "compilers"] }] }) : textReply("Drawn."));
      },
    });
    const events = await run(workspace, "Put the conference on the canvas", model, imported.slug);
    expect(events).toContainEqual({ open_module: "tldraw" });
    const board = (await moduleStatePayload({ workspace }, BOARD_MODULE, imported.slug)) as { day: string; themes: Array<{ name: string }> };
    expect(board.day).toBe("2099-05-04");
    expect(board.themes.map((theme) => theme.name)).toEqual(["Systems", "Other"]);
  });
});
