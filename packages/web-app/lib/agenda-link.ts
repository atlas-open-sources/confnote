import { slugify } from "./agenda.js";
import type { AgendaData, AgendaEvent, AgendaSpeaker } from "./types.js";
import { fetchUrlRaw, fetchUrlText } from "./webResearch.js";

// Import by link: a published confnote manifest, an iCal feed, schema.org Event data on the page, or a JSON/iCal
// file the page links to. All of that is free (no model). When a page has none of it, the caller may ask the
// Concierge to read the page text (pageText below) and turn it into an agenda with agendaFromExtraction.

const MAX_LINKED_FILES = 4;
const MAX_EXTRACTED_SESSIONS = 120;
const ISO_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;
const ISO_ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;

export type AgendaSource = "manifest" | "ical" | "json-ld" | "linked-manifest" | "linked-ical" | "page";

export interface FoundAgenda {
  agenda: AgendaData;
  source: AgendaSource;
  url: string;
}

function isManifest(value: unknown): value is AgendaData {
  return Boolean(value && typeof value === "object" && "conference" in value && "events" in value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

/** Untrusted fields (pages, feeds, model replies) as text: strings and numbers only, anything else empty. */
function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** "2026-09-29T11:15" in an IANA zone → "2026-09-29T11:15:00-07:00". */
export function zonedIso(local: string, timezone: string | undefined): string | null {
  if (ISO_ZONED.test(local)) return Number.isFinite(Date.parse(local)) ? local : null;
  if (!ISO_LOCAL.test(local)) return null;
  const withSeconds = local.length === 16 ? `${local}:00` : local;
  if (!timezone) return `${withSeconds}Z`;
  const asUtc = Date.parse(`${withSeconds}Z`);
  if (!Number.isFinite(asUtc)) return null;
  let offsetMinutes: number;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(asUtc));
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    offsetMinutes = Math.round((wall - asUtc) / 60_000);
    // The offset at the wall time itself, so a time just after a DST change still gets its own offset.
    const corrected = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" })
      .formatToParts(new Date(asUtc - offsetMinutes * 60_000))
      .find((part) => part.type === "timeZoneName")?.value;
    const match = /GMT([+-])(\d{2}):(\d{2})/.exec(corrected || "");
    if (match) offsetMinutes = (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
    else if (corrected === "GMT") offsetMinutes = 0;
  } catch {
    return null;
  }
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return `${withSeconds}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function uniqueId(base: string, used: Set<string>): string {
  const root = slugify(base).slice(0, 60).replace(/-+$/, "") || "session";
  let id = root;
  for (let n = 2; used.has(id); n += 1) id = `${root}-${n}`;
  used.add(id);
  return id;
}

const TYPE_WORDS: Array<[RegExp, string]> = [
  [/\bkeynote\b/i, "keynote"],
  [/\bpanel\b/i, "panel"],
  [/\bworkshop\b/i, "workshop"],
  [/\blunch\b/i, "lunch"],
  [/\b(break|coffee)\b/i, "break"],
  [/\b(registration|check-in|doors open|breakfast)\b/i, "logistics"],
  [/\b(networking|reception|happy hour|party)\b/i, "networking"],
];

function guessType(title: string, explicit?: string): string {
  const known = ["talk", "keynote", "panel", "workshop", "break", "lunch", "networking", "social", "logistics", "other"];
  if (explicit && known.includes(explicit)) return explicit;
  for (const [pattern, type] of TYPE_WORDS) if (pattern.test(title)) return type;
  return "talk";
}

interface LooseSession {
  title?: string;
  start?: string;
  end?: string;
  room?: string;
  track?: string;
  speakers?: string[];
  description?: string;
  type?: string;
}

interface LooseConference {
  name?: string;
  date?: string;
  timezone?: string;
  city?: string;
  venue?: string;
  url?: string;
}

/** Normalises sessions from any source (iCal, JSON-LD, the Concierge's extraction) into a confnote.agenda.v1. */
export function agendaFromSessions(conference: LooseConference, sessions: LooseSession[], sourceUrl: string): AgendaData | null {
  const timezone = validZone(text(conference.timezone)) || undefined;
  const ids = new Set<string>();
  const speakers: Record<string, AgendaSpeaker> = {};
  const events: AgendaEvent[] = [];
  for (const session of sessions.slice(0, MAX_EXTRACTED_SESSIONS)) {
    if (!session || typeof session !== "object") continue;
    const title = text(session.title).replace(/\s+/g, " ").trim().slice(0, 200);
    const start = zonedIso(text(session.start).trim(), timezone);
    if (!title || !start) continue;
    let end = zonedIso(text(session.end).trim(), timezone);
    if (!end || Date.parse(end) <= Date.parse(start)) end = new Date(Date.parse(start) + 30 * 60_000).toISOString().replace(".000Z", "Z");
    const names = (Array.isArray(session.speakers) ? session.speakers : [])
      .map((name) => text(name).replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 12);
    for (const name of names) speakers[name] ||= { name };
    events.push({
      id: uniqueId(`${start.slice(11, 16)}-${title}`, ids),
      type: guessType(title, text(session.type)),
      title,
      description: text(session.description).replace(/\s+/g, " ").trim().slice(0, 600),
      start,
      end,
      room: text(session.room).trim().slice(0, 80),
      track: text(session.track).trim().slice(0, 80),
      speakers: names,
      tags: [],
      links: [],
    });
  }
  if (!events.length) return null;
  events.sort((a, b) => Date.parse(a.start || "") - Date.parse(b.start || ""));
  const name = text(conference.name).replace(/\s+/g, " ").trim().slice(0, 140);
  if (!name) return null;
  const firstDay = (events[0].start || "").slice(0, 10);
  const given = text(conference.date);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(given) && Number.isFinite(Date.parse(given)) ? given : firstDay;
  return {
    schema_version: "confnote.agenda.v1",
    conference: {
      name,
      date,
      ...(timezone ? { timezone } : {}),
      ...(text(conference.venue) || text(conference.city) ? { venue: { name: text(conference.venue) || text(conference.city) } } : {}),
    },
    speakers,
    events,
    sources: [{ url: sourceUrl, label: "Imported by the Concierge", retrieved_at: new Date().toISOString() }],
  };
}

// ---- iCal ------------------------------------------------------------------------------------------------

function validZone(zone: string): string {
  if (!zone) return "";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return "";
  }
}

function unfoldIcal(text: string): string[] {
  return text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
}

function icalText(value: string): string {
  return value.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
}

function icalDate(value: string, params: string, fallbackZone?: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h = "00", mi = "00", s = "00", utc] = match;
  const local = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  if (utc) return `${local}Z`;
  const tzid = /TZID=([^;:]+)/i.exec(params)?.[1]?.replace(/^"|"$/g, "");
  return zonedIso(local, tzid || fallbackZone);
}

export function agendaFromIcal(text: string, sourceUrl: string, fallbackName = ""): AgendaData | null {
  if (!/BEGIN:VCALENDAR/i.test(text)) return null;
  const lines = unfoldIcal(text);
  let calendarName = "";
  let calendarZone = "";
  const sessions: LooseSession[] = [];
  let current: Record<string, { value: string; params: string }> | null = null;
  for (const line of lines) {
    if (/^BEGIN:VEVENT/i.test(line)) current = {};
    else if (/^END:VEVENT/i.test(line)) {
      if (current) {
        const start = current.DTSTART ? icalDate(current.DTSTART.value, current.DTSTART.params, calendarZone) : null;
        const end = current.DTEND ? icalDate(current.DTEND.value, current.DTEND.params, calendarZone) : null;
        sessions.push({
          title: icalText(current.SUMMARY?.value || ""),
          start: start || "",
          end: end || "",
          room: icalText(current.LOCATION?.value || ""),
          description: icalText(current.DESCRIPTION?.value || ""),
        });
      }
      current = null;
    } else {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const head = line.slice(0, colon);
      const value = line.slice(colon + 1);
      const [name, ...params] = head.split(";");
      const key = name.toUpperCase();
      if (current) current[key] = { value, params: params.join(";") };
      else if (key === "X-WR-CALNAME") calendarName = icalText(value);
      else if (key === "X-WR-TIMEZONE") calendarZone = value.trim();
    }
  }
  const zone = calendarZone || undefined;
  return agendaFromSessions({ name: calendarName || fallbackName, timezone: zone }, sessions, sourceUrl);
}

// ---- schema.org Event (JSON-LD) ----------------------------------------------------------------------------

interface LdThing {
  "@type"?: string | string[];
  "@graph"?: LdThing[];
  name?: string;
  startDate?: string;
  endDate?: string;
  description?: string;
  location?: { name?: string } | string;
  performer?: LdThing | LdThing[];
  subEvent?: LdThing | LdThing[];
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function isEvent(thing: LdThing | null): thing is LdThing {
  return Boolean(thing && typeof thing === "object" && asArray(thing["@type"]).some((type) => /Event$/.test(String(type))));
}

function ldSession(thing: LdThing): LooseSession {
  return {
    title: thing.name,
    start: thing.startDate,
    end: thing.endDate,
    description: thing.description,
    room: typeof thing.location === "string" ? thing.location : text(thing.location?.name),
    speakers: asArray(thing.performer).map((performer) => text(performer?.name)).filter(Boolean),
  };
}

export function agendaFromJsonLd(html: string, sourceUrl: string): AgendaData | null {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    const parsed = parseJson(block[1].trim());
    const things = asArray(parsed as LdThing | LdThing[]).flatMap((thing) => [thing, ...asArray(thing?.["@graph"])]);
    const parent = things.find((thing) => thing && isEvent(thing) && asArray(thing.subEvent).length);
    if (parent) {
      const sessions = asArray(parent.subEvent).filter(isEvent).map(ldSession);
      const agenda = agendaFromSessions({ name: parent.name, date: text(parent.startDate).slice(0, 10) }, sessions, sourceUrl);
      if (agenda) return agenda;
    }
    const events = things.filter((thing) => thing && isEvent(thing) && thing.startDate);
    if (events.length >= 3) {
      const agenda = agendaFromSessions({ name: pageTitle(html) }, events.map(ldSession), sourceUrl);
      if (agenda) return agenda;
    }
  }
  return null;
}

// ---- the page and what it links to -----------------------------------------------------------------------

function pageTitle(html: string): string {
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1];
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return (og || title || "").replace(/\s+/g, " ").trim();
}

/** Links on the page that look like an agenda file: .json / .ics / webcal, schedule or agenda paths first. */
export function agendaLinks(html: string, base: string): string[] {
  const found: Array<{ url: string; score: number }> = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/(?:href|src|data-src)\s*=\s*["']([^"'#]+)["']/gi)) {
    let raw = match[1].trim().replace(/&amp;/g, "&");
    if (/^webcal:/i.test(raw)) raw = raw.replace(/^webcal:/i, "https:");
    let url: URL;
    try {
      url = new URL(raw, base);
    } catch {
      continue;
    }
    if (!["http:", "https:"].includes(url.protocol)) continue;
    const path = url.pathname.toLowerCase();
    const file = /\.(json|ics|ical)$/.test(path) || /format=(ics|ical|json)/i.test(url.search);
    if (!file || /manifest\.json$|package\.json$|\.webmanifest$/.test(path)) continue;
    const href = url.toString();
    if (seen.has(href)) continue;
    seen.add(href);
    const score = /agenda|schedule|program|sessions|calendar/.test(path) ? 0 : 1;
    found.push({ url: href, score });
  }
  return found.sort((a, b) => a.score - b.score).map((item) => item.url).slice(0, MAX_LINKED_FILES);
}

function agendaFromBody(text: string, url: string, linked: boolean, fallbackName: string): FoundAgenda | null {
  const json = parseJson(text);
  if (isManifest(json)) return { agenda: json, source: linked ? "linked-manifest" : "manifest", url };
  const ical = agendaFromIcal(text, url, fallbackName);
  if (ical) return { agenda: ical, source: linked ? "linked-ical" : "ical", url };
  return null;
}

/** Everything the link offers without a model. `page` is the fetched HTML when nothing structured was found. */
export async function findAgendaAt(url: string): Promise<{ found: FoundAgenda | null; html: string; error?: string }> {
  const fetched = await fetchUrlRaw(url);
  if ("error" in fetched) return { found: null, html: "", error: fetched.error };
  const direct = agendaFromBody(fetched.text, fetched.url, false, "");
  if (direct) return { found: direct, html: "" };
  const html = fetched.text;
  const title = pageTitle(html);
  const ld = agendaFromJsonLd(html, fetched.url);
  if (ld) return { found: { agenda: ld, source: "json-ld", url: fetched.url }, html };
  for (const link of agendaLinks(html, fetched.url)) {
    const body = await fetchUrlRaw(link);
    if ("error" in body) continue;
    const linked = agendaFromBody(body.text, body.url, true, title);
    if (linked) return { found: linked, html };
  }
  return { found: null, html };
}

/** The page as text for the Concierge to read (scripts and styles stripped, capped). */
export async function pageText(url: string): Promise<{ url: string; title: string; text: string } | { error: string }> {
  const page = await fetchUrlText(url);
  if ("error" in page) return page;
  return { url: page.url, title: page.title || "", text: page.text };
}

/** Index just past the bracketed value that opens at `open` ("{" or "["), honouring strings; -1 if cut off. */
function closingIndex(text: string, open: number): number {
  const pairs: Record<string, string> = { "{": "}", "[": "]" };
  const stack: string[] = [];
  let inString = false;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char in pairs) stack.push(pairs[char]);
    else if (char === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return i + 1;
    }
  }
  return -1;
}

type SessionRow = [string?, string?, string?, string?, string?, string?];

/**
 * The Concierge's extraction reply → agenda. Sessions come as compact rows
 * [start, end, title, room, "Speaker; Speaker", type]; each complete row is kept, so a reply cut off at the
 * token cap still yields every session before the cut.
 */
export function agendaFromExtraction(reply: string, sourceUrl: string): AgendaData | null {
  const conferenceAt = reply.search(/"conference"\s*:\s*\{/);
  if (conferenceAt < 0) return null;
  const conferenceOpen = reply.indexOf("{", conferenceAt);
  const conferenceEnd = closingIndex(reply, conferenceOpen);
  if (conferenceEnd < 0) return null;
  const conference = parseJson(reply.slice(conferenceOpen, conferenceEnd)) as LooseConference | null;
  if (!conference) return null;
  const sessions: LooseSession[] = [];
  const listAt = reply.search(/"sessions"\s*:\s*\[/);
  if (listAt >= 0) {
    let i = reply.indexOf("[", listAt) + 1;
    while (i > 0 && i < reply.length) {
      const next = reply.indexOf("[", i);
      const listEnd = reply.indexOf("]", i);
      if (next < 0 || (listEnd >= 0 && listEnd < next)) break;
      const end = closingIndex(reply, next);
      if (end < 0) break;
      const row = parseJson(reply.slice(next, end)) as SessionRow | null;
      if (Array.isArray(row)) {
        const [start, finish, title, room, speakers, type] = row.map((cell) => (typeof cell === "string" ? cell : ""));
        sessions.push({ start, end: finish, title, room, type, speakers: (speakers || "").split(/\s*;\s*/).filter(Boolean) });
      }
      i = end;
    }
  }
  return agendaFromSessions(conference, sessions, sourceUrl);
}
