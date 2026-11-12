import type { AgendaData, AgendaEvent, AgendaSpeaker } from "./types.js";

export const CONF_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/;
export const NOTE_RE = /^(?:\d{4}-|session-)[a-z0-9][a-z0-9_-]*\.md$/;
export const INBOX_NAME = "INBOX.md";

export function slugify(text: string): string {
  return (text || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function notable(event: AgendaEvent): boolean {
  return Boolean(event.id && event.start);
}

export function hhmm(iso: string): string {
  return iso.slice(11, 13) + iso.slice(14, 16);
}

export function clock(iso: string): string {
  return iso.slice(11, 16);
}

export function noteFileForEvent(event: AgendaEvent): string {
  const filename = event.note_file || `${hhmm(event.start || "")}-${event.id}.md`;
  if (!NOTE_RE.test(filename)) throw new Error("unsafe note filename");
  return filename;
}

export function eventClock(value: string, timezone?: string | null): string {
  if (!timezone) return clock(value);
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));
}

export function eventDay(start: string, timezone?: string | null): string {
  if (!timezone || start.length === 10) return start.slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(start));
}

export function safeNotable(event: AgendaEvent): boolean {
  if (!notable(event)) return false;
  try { noteFileForEvent(event); return true; } catch { return false; }
}

export function speakerLabel(id: string, speakers: Record<string, AgendaSpeaker> = {}): string {
  const speaker = speakers[id] || {};
  const name = speaker.name || id;
  const role = speaker.role || speaker.title;
  const company = speaker.company;
  if (role && company) return `${name} (${role}, ${company})`;
  if (role) return `${name} (${role})`;
  return name;
}

export function speakersFor(event: AgendaEvent, speakers: Record<string, AgendaSpeaker> = {}): string {
  return (event.speakers || []).map((id) => speakerLabel(id, speakers)).join(", ");
}

export function validateAgenda(data: unknown): { errors: string[]; warnings: string[]; summary: string } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const agenda = data as Partial<AgendaData>;
  if (!agenda || typeof agenda !== "object") {
    return { errors: ["agenda must be a JSON object"], warnings, summary: "Invalid agenda." };
  }
  if (!agenda.conference || typeof agenda.conference !== "object") {
    errors.push("conference is required");
  } else {
    if (!agenda.conference.name) errors.push("conference.name is required");
    if (!agenda.conference.date) errors.push("conference.date is required");
  }
  if (!Array.isArray(agenda.events)) {
    errors.push("events must be an array");
  } else {
    const ids = new Set<string>();
    const files = new Set<string>();
    agenda.events.forEach((event, index) => {
      if (event.id && !/^[a-z0-9][a-z0-9_-]*$/.test(event.id)) errors.push(`events[${index}].id must be a lowercase safe identifier`);
      if (event.id && ids.has(event.id)) errors.push(`events[${index}].id is duplicated`);
      if (event.id) ids.add(event.id);
      if (event.note_file && files.has(event.note_file)) errors.push(`events[${index}].note_file is duplicated`);
      if (event.note_file) files.add(event.note_file);
      if (!event.id) errors.push(`events[${index}].id is required`);
      if (!event.title) errors.push(`events[${index}].title is required`);
      if (!event.start) errors.push(`events[${index}].start is required`);
      if (!event.end) errors.push(`events[${index}].end is required`);
      for (const field of ["start", "end"] as const) {
        const value = event[field];
        if (value && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
          errors.push(`events[${index}].${field} must be ISO 8601 with timezone`);
        }
      }
      if (!event.speakers?.length && ["talk", "keynote", "panel", "workshop"].includes(event.type || "")) {
        warnings.push(`events[${index}] has no speakers`);
      }
    });
  }
  const name = agenda.conference?.name || "(unnamed)";
  const count = Array.isArray(agenda.events) ? agenda.events.length : 0;
  return { errors, warnings, summary: `${name}: ${count} agenda rows.` };
}
