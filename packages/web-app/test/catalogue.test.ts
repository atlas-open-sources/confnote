import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { validateCatalogue, type Catalogue } from "../../events-model/src/index.js";
import { calendar, openApplications, searchEvents, tripEvents } from "../../catalogue-web/src/catalogue.js";
import { mcpResponse } from "../../catalogue-web/src/mcp.js";
const catalogue: Catalogue = JSON.parse(fs.readFileSync(new URL("../../catalogue-web/fixtures/index.json", import.meta.url), "utf8"));

describe("public catalogue", () => {
  it("validates the shared schema and combines country, city, program, topic and date filters", () => {
    validateCatalogue(catalogue);
    expect(searchEvents(catalogue, { city: "london", country: "GB", program: "claude-community", topic: "ai", from: "2099-06-11", to: "2099-06-11" }).map((event) => event.id)).toEqual(["evt-demo-1"]);
    expect(searchEvents(catalogue, { from: "2099-07-01" })).toEqual([]);
    expect(() => searchEvents(catalogue, { from: "2099-02-30" })).toThrow();
    expect(() => searchEvents(catalogue, { from: "2099-06-12", to: "2099-06-01" })).toThrow();
  });
  it("lists upcoming events soonest first and past events latest first, split at today", () => {
    const today = new Date("2099-06-13T09:00:00Z");
    const upcoming = searchEvents(catalogue, { when: "upcoming" }, today);
    const past = searchEvents(catalogue, { when: "past" }, today);
    expect(upcoming.length + past.length).toBe(catalogue.events.length);
    expect(upcoming.every((event) => event.end.slice(0, 10) >= "2099-06-13")).toBe(true);
    expect(past.every((event) => event.end.slice(0, 10) < "2099-06-13")).toBe(true);
    expect(upcoming.map((event) => event.start)).toEqual([...upcoming.map((event) => event.start)].sort());
    expect(past.map((event) => event.start)).toEqual([...past.map((event) => event.start)].sort().reverse());
    expect(searchEvents(catalogue, { when: "upcoming" }, new Date("2000-01-01"))).toHaveLength(catalogue.events.length);
    expect(() => searchEvents(catalogue, { when: "soon" as "past" })).toThrow();
  });
  it("judges upcoming by the event's own calendar day, not UTC's", () => {
    const evening = { ...catalogue.events[0], start: "2026-11-08T23:00:00Z", end: "2026-11-09T04:59:00Z", timezone: "America/New_York" };
    const data = { ...catalogue, events: [evening] };
    // 04:30 UTC on the 9th is still the evening of the 8th in New York.
    expect(searchEvents(data, { when: "upcoming" }, new Date("2026-11-09T04:30:00Z"))).toHaveLength(1);
    expect(searchEvents(data, { when: "past" }, new Date("2026-11-09T06:00:00Z"))).toHaveLength(1);
  });
  it("matches overlapping multi-day trips and deduplicates repeated stops", () => {
    const stops = [{ city: "London", from: "2099-06-11", to: "2099-06-12" }];
    expect(tripEvents(catalogue, [...stops, ...stops]).map((event) => event.id)).toEqual(["evt-demo-1", "evt-demo-3"]);
  });
  it("filters application deadlines, opening dates and profiles", () => {
    expect(openApplications(catalogue, { topics: ["rust"] }, new Date("2099-05-01")).map((row) => row.eventId)).toEqual(["evt-demo-3"]);
    expect(openApplications(catalogue, {}, new Date("2099-06-02"))).toEqual([]);
    const future = structuredClone(catalogue); future.events[0].applications[0].opens_at = "2099-05-20T00:00:00Z";
    expect(openApplications(future, {}, new Date("2099-05-01")).some((row) => row.eventId === "evt-demo-1")).toBe(false);
  });
  it("keeps date-only deadlines open through that UTC calendar day", () => {
    const copy = structuredClone(catalogue); copy.events[0].applications[0].deadline = "2099-06-01";
    expect(openApplications(copy, {}, new Date("2099-06-01T23:59:59Z")).some((row) => row.eventId === "evt-demo-1")).toBe(true);
    expect(openApplications(copy, {}, new Date("2099-06-02T00:00:00Z")).some((row) => row.eventId === "evt-demo-1")).toBe(false);
  });
  it("exports inclusive all-day end dates as exclusive iCal and escapes injected content", () => {
    const event = { ...catalogue.events[0], name: "Hello\nBEGIN:VEVENT,semi;colon" };
    const text = calendar([event], new Date("2099-01-01T00:00:00Z"));
    expect(text).toContain("DTEND;VALUE=DATE:20990612");
    expect(text.match(/\r\nBEGIN:VEVENT/g)).toHaveLength(1);
    expect(text).toContain("SUMMARY:Hello\\nBEGIN:VEVENT\\,semi\\;colon");
  });
  it("serves MCP discovery and only read-only tools", () => {
    expect(mcpResponse(catalogue, { jsonrpc: "2.0", id: 1, method: "tools/list" })).toMatchObject({ result: { tools: [{ name: "search_events", annotations: { readOnlyHint: true } }, { name: "open_applications" }] } });
    expect(mcpResponse(catalogue, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "delete_event" } })).toMatchObject({ error: { code: -32601 } });
    expect(mcpResponse(catalogue, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_events", arguments: { city: 2 } } })).toMatchObject({ result: { isError: true } });
    // Anonymous callers cannot send unbounded profiles or filters (CPU amplification).
    const manyTopics = Array.from({ length: 51 }, (_, i) => `topic-${i}`);
    expect(mcpResponse(catalogue, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "open_applications", arguments: { profile: { topics: manyTopics } } } })).toMatchObject({ result: { isError: true } });
    expect(mcpResponse(catalogue, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "open_applications", arguments: { profile: { city: "x".repeat(201) } } } })).toMatchObject({ result: { isError: true } });
    expect(mcpResponse(catalogue, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "search_events", arguments: { q: "x".repeat(201) } } })).toMatchObject({ result: { isError: true } });
    const bounded = mcpResponse(catalogue, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "open_applications", arguments: { profile: { topics: manyTopics.slice(0, 50) } } } }) as { result: { isError?: boolean } };
    expect(bounded.result.isError).toBeUndefined();
  });
});

it("trip dates use the event timezone rather than the visitor timezone or UTC day", () => {
  const event = { ...catalogue.events[0], city: "Seoul", start: "2099-06-01T16:00:00Z", end: "2099-06-01T17:00:00Z", timezone: "Asia/Seoul" };
  const data = { ...catalogue, events: [event] };
  expect(tripEvents(data, [{ city: "Seoul", from: "2099-06-02", to: "2099-06-02" }])).toHaveLength(1);
  expect(tripEvents(data, [{ city: "Seoul", from: "2099-06-01", to: "2099-06-01" }])).toHaveLength(0);
});

it("serves the list's own calendar feed: the same when filter, or the trip's stops", async () => {
  // The fixture catalogue, whatever snapshot a local build bundled.
  vi.stubEnv("CONFNOTE_CATALOGUE_DIR", new URL("../../catalogue-web/fixtures", import.meta.url).pathname);
  const { catalogueRoute } = await import("../lib/catalogue.js");
  async function get(route: string, query: Record<string, string>) {
    let body = "";
    const res = { status() { return res; }, setHeader() { return res; }, send(text: string) { body = text; return res; }, json(value: unknown) { body = JSON.stringify(value); return res; } };
    await catalogueRoute({ method: "GET", query } as never, res as never, route);
    return body;
  }
  const uids = (ics: string) => [...ics.matchAll(/UID:(\S+)@/g)].map((match) => match[1]);
  const listed = JSON.parse(await get("catalogue", { when: "upcoming" })).events.map((event: { id: string }) => event.id);
  expect(uids(await get("catalogue/calendar", { when: "upcoming" }))).toEqual(listed);
  expect(uids(await get("catalogue/calendar", { when: "past" }))).toEqual([]);
  const stops = JSON.stringify([{ city: "London", from: "2099-06-11", to: "2099-06-12" }]);
  const trip = JSON.parse(await get("catalogue/trip", { stops })).events.map((event: { id: string }) => event.id);
  expect(uids(await get("catalogue/calendar", { stops }))).toEqual(trip);
  expect(trip).toEqual(["evt-demo-1", "evt-demo-3"]);
  vi.unstubAllEnvs();
});
