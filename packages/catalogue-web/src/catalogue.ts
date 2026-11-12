import type { Catalogue, Event } from "../../events-model/src/index.js";

export type When = "upcoming" | "past";
export interface Filters {
  q?: string; country?: string; city?: string; program?: string; topic?: string; from?: string; to?: string;
  /** upcoming: still running on `today` or later, soonest first. past: ended before `today`, latest first. */
  when?: When;
}
export interface TripStop { city: string; from: string; to: string }
export type TrackingStatus = "interested" | "going" | "attended";
export interface ApplicationProfile { topics?: string[]; audience?: string[]; country?: string; city?: string }

function equal(a: string | null | undefined, b: string | undefined): boolean {
  return !b || (a || "").toLocaleLowerCase() === b.toLocaleLowerCase();
}
function date(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error("Use YYYY-MM-DD dates.");
  return value;
}
export function localDay(value: string, timezone: string | null): string {
  if (value.length === 10 || !timezone) return value.slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}
export function searchEvents(catalogue: Catalogue, filters: Filters = {}, now = new Date()): Event[] {
  const from = date(filters.from);
  const to = date(filters.to);
  if (from && to && from > to) throw new Error("The date range ends before it starts.");
  if (filters.when && filters.when !== "upcoming" && filters.when !== "past") throw new Error("Use when=upcoming or when=past.");
  const found = catalogue.events.filter((event) => {
    if (filters.when) {
      // "Today" where the event happens: an evening in New York is still upcoming after UTC midnight.
      const ended = localDay(event.end, event.timezone) < localDay(now.toISOString(), event.timezone);
      if (ended !== (filters.when === "past")) return false;
    }
    if (!equal(event.country, filters.country) || !equal(event.city, filters.city) || !equal(event.program, filters.program)) return false;
    if (filters.topic && !event.topics.some((topic) => equal(topic, filters.topic))) return false;
    if (from && localDay(event.end, event.timezone) < from) return false;
    if (to && localDay(event.start, event.timezone) > to) return false;
    if (filters.q && ![event.name, event.city, event.country, event.program, ...event.topics].join(" ").toLocaleLowerCase().includes(filters.q.toLocaleLowerCase())) return false;
    return true;
  }).sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
  return filters.when === "past" ? found.reverse() : found;
}
export function tripEvents(catalogue: Catalogue, stops: TripStop[]): Event[] {
  if (stops.length > 20) throw new Error("A trip supports up to 20 stops.");
  const found = new Set<string>();
  for (const stop of stops) {
    if (!stop.city || !stop.from || !stop.to) throw new Error("Each stop needs a city and dates.");
    for (const event of searchEvents(catalogue, stop)) found.add(event.id);
  }
  return searchEvents(catalogue).filter((event) => found.has(event.id));
}
export function openApplications(catalogue: Catalogue, profile: ApplicationProfile = {}, now = new Date()) {
  const today = now.toISOString();
  return searchEvents(catalogue, { country: profile.country, city: profile.city }).flatMap((event) => {
    if (profile.topics?.length && !profile.topics.some((topic) => event.topics.includes(topic))) return [];
    if (profile.audience?.length && event.audience?.length && !profile.audience.some((audience) => event.audience?.includes(audience))) return [];
    return event.applications.filter((application) => {
      if (!["apply", "cfp", "scholarship", "waitlist"].includes(application.type)) return false;
      if (application.status !== "open" && application.status !== "waitlist") return false;
      if (application.deadline) {
        const expired = application.deadline.length === 10 ? application.deadline < today.slice(0, 10) : Date.parse(application.deadline) < now.getTime();
        if (expired) return false;
      }
      if (application.opens_at && Date.parse(application.opens_at) > now.getTime()) return false;
      return event.end.slice(0, 10) >= today.slice(0, 10);
    }).map((application) => ({ eventId: event.id, eventName: event.name, application, provenance: event.provenance, verifyOnSource: true }));
  });
}
function escapeIcal(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");
}
function fold(line: string): string {
  const lines: string[] = [];
  let current = "";
  let bytes = 0;
  for (const char of line) {
    const size = new TextEncoder().encode(char).length;
    if (bytes + size > 75) { lines.push(current); current = " "; bytes = 1; }
    current += char; bytes += size;
  }
  lines.push(current);
  return lines.join("\r\n");
}
export function calendar(events: Event[], generatedAt = new Date()): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//confnote//Events catalogue//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  const stamp = generatedAt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  for (const event of events) {
    lines.push("BEGIN:VEVENT", `UID:${event.id}@events.confnote`, `DTSTAMP:${stamp}`, `SUMMARY:${escapeIcal(event.name)}`);
    if (event.start.length === 10) {
      const exclusiveEnd = new Date(`${event.end}T00:00:00Z`); exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
      lines.push(`DTSTART;VALUE=DATE:${event.start.replaceAll("-", "")}`, `DTEND;VALUE=DATE:${exclusiveEnd.toISOString().slice(0, 10).replaceAll("-", "")}`);
    } else {
      for (const [key, value] of [["DTSTART", event.start], ["DTEND", event.end]]) lines.push(`${key}:${new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`);
    }
    if (event.city || event.country) lines.push(`LOCATION:${escapeIcal([event.city, event.country].filter(Boolean).join(", "))}`);
    if (event.url) lines.push(`URL:${escapeIcal(event.url)}`);
    if (event.status === "cancelled") lines.push("STATUS:CANCELLED");
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
export function llmsText(): string {
  return "# confnote events\n\nOpen tech event facts and source links. CC-BY-4.0; preserve source attribution.\n\n- [Events JSON](/api/catalogue)\n- [Calendar](/api/catalogue/calendar)\n- [Read-only MCP](/api/catalogue/mcp)\n\nVerify dates and application eligibility on the linked organizer page.\n";
}
