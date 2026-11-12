import { describe, expect, it, vi } from "vitest";

const fetched = vi.hoisted(() => ({ text: "", urls: [] as string[] }));
vi.mock("../lib/webResearch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/webResearch.js")>()),
  fetchUrlRaw: async (url: string) => {
    fetched.urls.push(url);
    return { url, text: fetched.text };
  },
}));

import { webChatEvents } from "../lib/chat.js";

function agenda(name: string) {
  return {
    schema_version: "confnote.agenda.v1",
    conference: {
      name,
      date: "2099-04-02",
      timezone: "Europe/London",
      venue: { name: "Web Hall" },
    },
    speakers: {
      ada: { name: "Ada Lovelace", role: "Speaker", company: "Analytical Engines" },
    },
    events: [
      {
        id: "opening",
        type: "talk",
        title: "Opening",
        description: "A deterministic chat test session.",
        start: "2099-04-02T09:00:00+00:00",
        end: "2099-04-02T09:30:00+00:00",
        room: "Main",
        speakers: ["ada"],
      },
    ],
  };
}

describe("web concierge", () => {
  it("imports a pasted agenda manifest", async () => {
    const workspace = `chat-import-${Date.now()}`;
    const events = await webChatEvents({
      workspace,
    }, {
      body: { messages: [{ role: "user", text: JSON.stringify(agenda("Chat Import")) }] },
    });

    expect(events.some((event) => "conference_imported" in event)).toBe(true);
    expect(events.at(-1)).toEqual({ done: true });
  });

  it("answers from the imported conference agenda", async () => {
    const workspace = `chat-answer-${Date.now()}`;
    const imported = await webChatEvents({
      workspace,
    }, {
      body: { messages: [{ role: "user", text: JSON.stringify(agenda("Chat Answer")) }] },
    });
    const importedEvent = imported.find((event) => "conference_imported" in event);
    if (!importedEvent || !("conference_imported" in importedEvent)) throw new Error("not imported");

    const events = await webChatEvents({
      workspace,
    }, {
      slug: importedEvent.conference_imported.slug,
      body: { messages: [{ role: "user", text: "who is speaking?" }] },
    });

    expect(events[0]).toMatchObject({ text: expect.stringContaining("Ada Lovelace") });
    expect(events.at(-1)).toEqual({ done: true });
  });

  it("imports pasted agenda JSON whose indentation arrived as no-break spaces", async () => {
    const pasted = JSON.stringify(agenda("Chat Nbsp"), null, 2).replace(/^( +)/gm, (spaces) => "\u00a0".repeat(spaces.length));
    const events = await webChatEvents({ workspace: `chat-nbsp-${Date.now()}` }, {
      body: { messages: [{ role: "user", text: pasted }] },
    });

    expect(events.some((event) => "conference_imported" in event)).toBe(true);
  });

  it("imports an agenda from a link while the vault is empty", async () => {
    fetched.text = JSON.stringify(agenda("Chat Link"), null, 2);
    fetched.urls = [];
    const events = await webChatEvents({ workspace: `chat-link-${Date.now()}` }, {
      body: { messages: [{ role: "user", text: "Import https://example.com/agenda please" }] },
    });

    expect(fetched.urls).toEqual(["https://example.com/agenda"]);
    expect(events.some((event) => "conference_imported" in event)).toBe(true);
  });

  it("leaves a non-JSON link to the agent once a conference exists", async () => {
    const workspace = `chat-link-skip-${Date.now()}`;
    await webChatEvents({ workspace }, {
      body: { messages: [{ role: "user", text: JSON.stringify(agenda("Chat Existing")) }] },
    });
    fetched.text = JSON.stringify(agenda("Chat Ignored"));
    fetched.urls = [];
    const events = await webChatEvents({ workspace }, {
      body: { messages: [{ role: "user", text: "What does https://example.com/talk say?" }] },
    });

    expect(fetched.urls).toEqual([]);
    expect(events.some((event) => "conference_imported" in event)).toBe(false);
  });
});
