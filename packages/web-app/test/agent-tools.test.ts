import { describe, expect, it } from "vitest";
import {
  addConference,
  appendAction,
  confDocPayload,
  notePayload,
  markAction,
  putAgentNoteSections,
  putConfDoc,
  syncDebriefActionsToInbox,
} from "../lib/service.js";
import { fetchUrlText, webSearch } from "../lib/webResearch.js";

function agenda(name: string) {
  return {
    schema_version: "confnote.agenda.v1",
    conference: {
      name,
      date: "2099-05-03",
      timezone: "Europe/London",
      venue: { name: "Tool Hall" },
    },
    speakers: {
      ada: { name: "Ada Lovelace", role: "Speaker", company: "Analytical Engines" },
    },
    events: [
      {
        id: "opening",
        type: "talk",
        title: "Opening",
        description: "A tool test session.",
        start: "2099-05-03T09:00:00+00:00",
        end: "2099-05-03T09:30:00+00:00",
        room: "Main",
        speakers: ["ada"],
      },
    ],
  };
}

async function seededWorkspace(prefix: string) {
  const ctx = { workspace: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}` };
  const result = await addConference(ctx, agenda(prefix));
  if (!("slug" in result)) throw new Error("agenda did not import");
  return { ctx, slug: result.slug, file: "0900-opening.md" };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

describe("web concierge tool helpers", () => {
  it("updates agent-owned note sections without touching human notes", async () => {
    const { ctx, slug, file } = await seededWorkspace("agent-sections");

    await putAgentNoteSections(ctx, slug, file, {
      Summary: "New summary",
      Research: "New research",
      "Human notes": "must not write",
    });

    const note = await notePayload(ctx, slug, file);
    expect(note?.sections.Summary).toBe("New summary");
    expect(note?.sections.Research).toBe("New research");
    expect(note?.sections["Human notes"]).not.toBe("must not write");
  });

  it("appends and marks session actions", async () => {
    const { ctx, slug, file } = await seededWorkspace("agent-actions");

    await appendAction(ctx, slug, file, "follow up with Ada");
    await markAction(ctx, slug, file, { text: "follow up with Ada", done: true });

    const note = await notePayload(ctx, slug, file);
    expect(note?.sections.Actions).toContain("- [x] follow up with Ada");
  });

  it("writes conference docs and syncs debrief action items into INBOX", async () => {
    const { ctx, slug } = await seededWorkspace("agent-docs");

    await putConfDoc(ctx, slug, "DEBRIEF.md", {
      text: "# Debrief\n\n## Action Items\n\n- [ ] send deck\n- [x] archive recording",
    });
    const synced = await syncDebriefActionsToInbox(ctx, slug);
    const docs = await confDocPayload(ctx, slug);
    const inbox = await notePayload(ctx, slug, "INBOX.md");

    expect(synced).toEqual({ ok: true, added: 2 });
    expect(docs?.debrief).toContain("send deck");
    expect(inbox?.sections.Actions).toContain("- [ ] send deck");
    expect(inbox?.sections.Actions).toContain("- [ ] archive recording");
  });
});

describe("web research helpers", () => {
  it("reports missing search provider without making network calls", async () => {
    const previous = {
      provider: process.env.CONFNOTE_WEB_SEARCH_PROVIDER,
      enabled: process.env.CONFNOTE_PAID_SEARCH_ENABLED,
      brave: process.env.BRAVE_SEARCH_API_KEY,
      tavily: process.env.TAVILY_API_KEY,
      exa: process.env.EXA_API_KEY,
    };
    delete process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.TAVILY_API_KEY;
    delete process.env.EXA_API_KEY;
    process.env.CONFNOTE_WEB_SEARCH_PROVIDER = "auto";
    process.env.CONFNOTE_PAID_SEARCH_ENABLED = "1";
    const result = await webSearch("confnote test");
    restoreEnv("CONFNOTE_WEB_SEARCH_PROVIDER", previous.provider);
    restoreEnv("CONFNOTE_PAID_SEARCH_ENABLED", previous.enabled);
    restoreEnv("BRAVE_SEARCH_API_KEY", previous.brave);
    restoreEnv("TAVILY_API_KEY", previous.tavily);
    restoreEnv("EXA_API_KEY", previous.exa);

    expect(result).toMatchObject({ error: expect.stringContaining("No web search provider") });
  });

  it("blocks private URL fetches", async () => {
    await expect(fetchUrlText("file:///etc/passwd")).resolves.toMatchObject({ error: expect.stringContaining("Only http") });
    await expect(fetchUrlText("http://127.0.0.1:8787/")).resolves.toMatchObject({ error: expect.stringContaining("Private") });
  });
});
