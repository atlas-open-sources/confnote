import { describe, expect, it } from "vitest";
import { confStatus } from "../lib/service.js";
import type { AgendaData } from "../lib/types.js";

const agenda = {
  conference: { name: "Status Conf", date: "2026-05-19" },
  speakers: {},
  events: [
    { id: "open", title: "Opening", start: "2026-05-19T09:00:00+01:00", end: "2026-05-19T09:30:00+01:00" },
    { id: "close", title: "Closing", start: "2026-05-19T17:00:00+01:00", end: "2026-05-19T17:30:00+01:00" },
  ],
} as unknown as AgendaData;

describe("confStatus", () => {
  it("keeps hours under a day", () => {
    expect(confStatus(agenda, new Date("2026-05-19T20:30:00+01:00"))).toBe("Post-conference — ended 3h ago.");
  });

  it("counts long spans in days, not thousands of hours", () => {
    expect(confStatus(agenda, new Date("2026-05-21T09:00:00+01:00"))).toBe("Post-conference — ended 1 day ago.");
    expect(confStatus(agenda, new Date("2026-11-10T12:00:00Z"))).toBe("Post-conference — ended 174 days ago.");
    expect(confStatus(agenda, new Date("2026-05-16T07:00:00+01:00"))).toBe("Pre-conference — starts in 3 days.");
  });
});
