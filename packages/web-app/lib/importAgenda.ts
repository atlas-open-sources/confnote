import { buildNote } from "./sections.js";
import type { AgendaData, AgendaEvent } from "./types.js";
import { clock, eventClock, eventDay, validateAgenda, hhmm, noteFileForEvent, notable, slugify, speakersFor } from "./agenda.js";
import type { StorageAdapter } from "./storage.js";
import { storageKey } from "./storage.js";

const TYPE_ICON: Record<string, string> = {
  logistics: "🧭",
  talk: "🎤",
  keynote: "⭐",
  panel: "🗣️",
  workshop: "🛠️",
  break: "☕",
  lunch: "🍽️",
  networking: "🥂",
  social: "🥂",
  other: "•",
};

function readme(data: AgendaData): string {
  const conf = data.conference;
  const speakers = data.speakers || {};
  const venue = conf.venue || {};
  const social = conf.social || {};
  const lines = [
    `# ${conf.name}`,
    "",
    `> ${conf.tagline || ""}`,
    "",
    `- **Date:** ${conf.date} (${conf.timezone || ""})`,
    `- **Venue:** ${venue.name || ""} — ${venue.address || ""}`,
    `- **Organiser:** ${conf.organiser || ""}`,
    `- **Contact:** ${conf.contact || ""}`,
  ];
  if (Object.keys(social).length) {
    lines.push(`- **Social:** ${Object.entries(social).map(([k, v]) => `${k}: ${v}`).join(" · ")}`);
  }
  lines.push("", "## Agenda", "", "| Time | | Session | Speakers | Notes |", "| --- | --- | --- | --- | --- |");
  for (const event of data.events) {
    const icon = TYPE_ICON[event.type || ""] || "•";
    const time = `${clock(event.start || "")}–${clock(event.end || "")}`;
    let title = event.title || "";
    let noteLink = "";
    if (notable(event)) {
      noteLink = `[notes](notes/${noteFileForEvent(event)})`;
      title = `**${title}**`;
    }
    lines.push(`| ${time} | ${icon} | ${title} | ${speakersFor(event, speakers)} | ${noteLink} |`);
  }
  lines.push(
    "",
    "## Sessions",
    "",
    "One note file per session, prefixed with `HHMM` so `ls notes/` is in running order:",
    "",
  );
  for (const event of data.events.filter(notable)) {
    lines.push(
      `- \`${clock(event.start || "")}\` [${event.title}](notes/${noteFileForEvent(event)}) — ${speakersFor(event, speakers)}`,
    );
  }
  lines.push("", "See [speakers.md](speakers.md) for full bios.", "");
  return lines.join("\n");
}

function speakersMarkdown(data: AgendaData): string {
  const lines = [`# Speakers — ${data.conference.name}`, ""];
  for (const speaker of Object.values(data.speakers || {})) {
    const title = speaker.role || speaker.title || "";
    const company = speaker.company || "";
    lines.push(`## ${speaker.name || ""}`);
    const sub = [title, company].filter(Boolean).join(" · ");
    if (sub) lines.push(`*${sub}*`);
    lines.push("", speaker.bio || "");
    const social = speaker.social || {};
    if (Object.keys(social).length) {
      lines.push("", Object.entries(social).map(([k, v]) => `[${k}](${v})`).join(" · "));
    }
    lines.push("");
  }
  return lines.join("\n");
}

function noteMarkdown(event: AgendaEvent, data: AgendaData): string {
  const links: string[] = [];
  for (const item of event.links || []) {
    if (typeof item === "string") {
      links.push(`- ${item}`);
    } else if (item.url) {
      links.push(`- [${item.label || item.title || item.url}](${item.url})`);
    }
  }
  const tz = data.conference.timezone || "";
  return buildNote(
    {
      session: event.title || "",
      session_id: event.id || "",
      day: event.day || eventDay(event.start || "", data.conference.timezone),
      speakers: speakersFor(event, data.speakers || {}),
      time: `${event.day || eventDay(event.start || "", tz)} ${eventClock(event.start || "", tz)}–${eventClock(event.end || "", tz)} (${tz})`,
      room: event.room || "",
      track: event.track || "",
      type: event.type || "",
      tags: `[${(event.tags || []).join(", ")}]`,
      recording: "",
      transcript: "",
    },
    event.title || "",
    {
      "Human notes": "",
      Summary: `AI-driven — seeded from the agenda, an agent refines this.\n\n> ${
        event.description || "No description provided."
      }`,
      Research: "Speaker & company dossier — run tools/research.py before the conference.",
      "AI notes": "Agent-owned. Live notes and follow-up research land here.",
      Transcript: "",
      Actions: "Tasks and follow-ups — `- [ ] task` lines, tick them off as you go.",
      Links: links.join("\n"),
      Scratchpad: "",
      Private: "",
    },
  );
}

export async function importAgenda(
  storage: StorageAdapter,
  workspace: string,
  data: AgendaData,
): Promise<{ slug: string; created: number; skipped: number }> {
  const validation = validateAgenda(data);
  if (validation.errors.length) throw new Error(validation.errors.join("; "));
  const slug = `${data.conference.date}-${slugify(data.conference.name)}`;
  const prefix = (...parts: string[]): string => storageKey(workspace, slug, ...parts);
  data = structuredClone(data);
  const previous = await storage.readText(prefix("agenda.json"));
  const paths = new Map<string | undefined, string>();
  if (previous) {
    const prior: AgendaData = JSON.parse(previous.text);
    for (const event of prior.events.filter(notable)) paths.set(event.id, noteFileForEvent(event));
  }
  const targets = new Set<string>();
  for (const event of data.events.filter(notable)) {
    if (paths.has(event.id)) event.note_file = paths.get(event.id);
    else if (data.schema_version === "confnote.agenda.v2") event.note_file ||= `session-${event.id}.md`;
    const target = noteFileForEvent(event);
    if (!paths.has(event.id) && target !== `session-${event.id}.md` && !new RegExp(`^\\d{4}-${event.id}\\.md$`).test(target)) throw new Error("note_file must belong to its session");
    if (targets.has(target)) throw new Error("duplicate note_file target");
    targets.add(target);
    event.session_id = event.id;
    event.day = eventDay(event.start || "", data.conference.timezone);
  }
  if (data.schema_version === "confnote.agenda.v2") {
    data.conference.start_date ||= data.conference.date;
    data.conference.end_date = [data.conference.end_date || data.conference.date, ...data.events.map((event) => eventDay(event.end || event.start || data.conference.date, data.conference.timezone))].sort().at(-1);
  }
  await storage.writeText(prefix("agenda.json"), JSON.stringify(data, null, 2) + "\n");
  await storage.writeText(prefix("README.md"), readme(data));
  await storage.writeText(prefix("speakers.md"), speakersMarkdown(data));

  let created = 0;
  let skipped = 0;
  for (const event of data.events.filter(notable)) {
    const file = noteFileForEvent(event);
    const key = prefix("notes", file);
    const existing = await storage.readText(key);
    if (existing) {
      skipped += 1;
      continue;
    }
    await storage.writeText(key, noteMarkdown(event, data));
    created += 1;
  }
  return { slug, created, skipped };
}
