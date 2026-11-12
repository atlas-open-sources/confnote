import { CONF_RE, INBOX_NAME, NOTE_RE, noteFileForEvent, notable, safeNotable, speakerLabel, validateAgenda } from "./agenda.js";
import { importAgenda } from "./importAgenda.js";
import {
  CANON_SECTIONS,
  EDITABLE,
  buildNote,
  completeSections,
  mergeLinksIntoSection,
  noteHasContent,
  parseActions,
  parseNote,
  withFrontmatterFlag,
} from "./sections.js";
import { createStorage, storageKey } from "./storage.js";
import type { AgendaData, RequestContext } from "./types.js";
import { exportConference } from "./vault-transfer.js";

const storage = createStorage();
function store(ctx: RequestContext) { return ctx.storage || storage; }
const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const AGENT_WRITABLE = new Set(["Summary", "Research", "AI notes"]);
const ACTION_LINE_RE = /^(\s*[-*]\s+\[)([ xX])(\]\s+)(.*)$/;
const DEBRIEF_ACTION_HEADINGS = new Set(["action items", "actions", "next steps", "follow-ups", "follow ups"]);
const MODULE_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function ext(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx).toLowerCase() : "";
}

function key(ctx: RequestContext, ...parts: string[]): string {
  return storageKey(ctx.workspace, ...parts);
}

function validSlug(slug: string): boolean {
  return CONF_RE.test(slug);
}

function validNote(file: string): boolean {
  return NOTE_RE.test(file) || file === INBOX_NAME;
}

async function loadAgenda(ctx: RequestContext, slug: string): Promise<AgendaData | null> {
  if (!validSlug(slug)) return null;
  const item = await store(ctx).readText(key(ctx, slug, "agenda.json"));
  if (!item) return null;
  return JSON.parse(item.text) as AgendaData;
}

async function noteMarkdown(ctx: RequestContext, slug: string, file: string) {
  if (!validSlug(slug) || !validNote(file)) return null;
  const item = await store(ctx).readText(key(ctx, slug, file === INBOX_NAME ? file : `notes/${file}`));
  if (item && ctx.noteRevision) return { ...item, mtime: await ctx.noteRevision.observe(item.text) };
  return item;
}

async function conferenceSlugs(ctx: RequestContext): Promise<string[]> {
  const objects = await store(ctx).list(key(ctx, ""));
  const slugs = new Set<string>();
  for (const object of objects) {
    const rest = object.path.slice(`${ctx.workspace}/`.length);
    const [slug, name] = rest.split("/");
    if (name === "agenda.json" && CONF_RE.test(slug)) slugs.add(slug);
  }
  return [...slugs].sort().reverse();
}

async function coordinatedNote<T>(ctx: RequestContext, slug: string, file: string, action: (inner: RequestContext) => Promise<T>): Promise<T> {
  if (!ctx.notes) return action(ctx);
  return ctx.notes.run(key(ctx, slug, file), (noteRevision) => action({ ...ctx, notes: undefined, noteRevision }));
}

async function writeNote(ctx: RequestContext, slug: string, file: string, text: string) {
  const saved = await store(ctx).writeText(key(ctx, slug, file === INBOX_NAME ? file : `notes/${file}`), text);
  if (ctx.noteRevision) return { ...saved, mtime: await ctx.noteRevision.observe(saved.text) };
  return saved;
}

export async function conferencesPayload(ctx: RequestContext) {
  const items = [];
  for (const slug of await conferenceSlugs(ctx)) {
    const data = await loadAgenda(ctx, slug);
    if (!data) continue;
    const events = data.events.filter(safeNotable);
    let withNotes = 0;
    for (const event of events) {
      const note = await noteMarkdown(ctx, slug, noteFileForEvent(event));
      if (note && noteHasContent(note.text)) withNotes += 1;
    }
    items.push({
      slug,
      name: data.conference.name,
      date: data.conference.date,
      tagline: data.conference.tagline || "",
      venue: data.conference.venue?.name || "",
      sessions: events.length,
      with_notes: withNotes,
    });
  }
  return items;
}

export async function conferencePayload(ctx: RequestContext, slug: string) {
  const data = await loadAgenda(ctx, slug);
  if (!data) return null;
  const speakers = data.speakers || {};
  const events = [];
  for (const event of data.events) {
    const out: Record<string, unknown> = {
      id: event.id,
      type: event.type,
      title: event.title,
      start: event.start,
      end: event.end,
      room: event.room || "",
      track: event.track || "",
      description: event.description || "",
      tags: event.tags || [],
      speakers: (event.speakers || []).map((id) => speakerLabel(id, speakers)),
    };
    if (safeNotable(event)) {
      const file = noteFileForEvent(event);
      const note = await noteMarkdown(ctx, slug, file);
      out.note = file;
      out.has_notes = Boolean(note && noteHasContent(note.text));
      out.attending = Boolean(note && isPick(parseNote(note.text).frontmatter));
    }
    events.push(out);
  }
  return {
    conference: data.conference,
    rooms: data.rooms || [],
    tracks: data.tracks || [],
    sources: data.sources || [],
    events,
    chat: false,
    _slug: slug,
  };
}

async function notePayloadCoordinated(ctx: RequestContext, slug: string, file: string) {
  const item = await noteMarkdown(ctx, slug, file);
  if (!item) return null;
  const parsed = parseNote(item.text);
  return {
    frontmatter: parsed.frontmatter,
    title: parsed.title,
    sections: completeSections(parsed.sections),
    mtime: item.mtime,
  };
}

const noteWrites = new Map<string, Promise<void>>();

// Serialize each note's read/check/write within this process, including Cat bridge calls.
async function serialized<T>(target: string, action: () => Promise<T>): Promise<T> {
  const previous = noteWrites.get(target) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  noteWrites.set(target, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (noteWrites.get(target) === current) noteWrites.delete(target);
  }
}

async function putNoteCoordinated(ctx: RequestContext, slug: string, file: string, payload: unknown) {
  if (!validSlug(slug) || !validNote(file)) return null;
  return serialized(key(ctx, slug, file), () => putNoteUnlocked(ctx, slug, file, payload));
}

async function putNoteUnlocked(ctx: RequestContext, slug: string, file: string, payload: unknown) {
  const item = await noteMarkdown(ctx, slug, file);
  if (!item) return null;
  const body = payload as { sections?: Record<string, string>; mtime?: number };
  if (body.mtime !== undefined && (!Number.isFinite(body.mtime) || Math.abs(body.mtime - item.mtime) > 1e-6)) {
    return { conflict: true, mtime: item.mtime, note: await notePayload(ctx, slug, file) };
  }
  const parsed = parseNote(item.text);
  const sections = { ...parsed.sections };
  for (const name of CANON_SECTIONS) {
    if (EDITABLE.has(name) && body.sections && Object.hasOwn(body.sections, name)) {
      sections[name] = body.sections[name];
    }
  }
  if (body.sections && Object.hasOwn(body.sections, "Human notes")) {
    sections.Links = mergeLinksIntoSection(sections["Human notes"] || "", sections.Links || "");
  }
  const saved = await writeNote(
    ctx, slug, file,
    buildNote(parsed.frontmatter, parsed.title, sections),
  );
  return { ok: true, mtime: saved.mtime, links: sections.Links || "" };
}

async function putAgentNoteSectionsCoordinated(
  ctx: RequestContext,
  slug: string,
  file: string,
  sectionsPatch: Record<string, string>,
  replaceable?: SectionGuard,
) {
  const item = await noteMarkdown(ctx, slug, file);
  if (!item) return null;
  const parsed = parseNote(item.text);
  const sections = { ...parsed.sections };
  let changed = false;
  for (const [name, value] of Object.entries(sectionsPatch)) {
    if (!AGENT_WRITABLE.has(name) || (replaceable && !replaceable(name, sections[name] || ""))) continue;
    sections[name] = value;
    changed = true;
  }
  if (!changed) return { ok: true, mtime: item.mtime, unchanged: true };
  const saved = await writeNote(
    ctx, slug, file,
    buildNote(parsed.frontmatter, parsed.title, sections),
  );
  return { ok: true, mtime: saved.mtime };
}

function actionLine(text: string): string {
  const body = text.trim();
  return body.startsWith("- [") || body.startsWith("* [") ? body : `- [ ] ${body}`;
}

function normalizeActionText(text: string): string {
  return (text || "")
    .toLowerCase()
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*`_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?,;: ]+$/g, "");
}

function extractMarkdownSection(text: string, headings: Set<string>): string {
  const out: string[] = [];
  let capturing = false;
  for (const line of (text || "").split("\n")) {
    const match = /^#{1,6}\s+(.*)$/.exec(line);
    if (match) {
      if (capturing) break;
      const title = match[1].replace(/[*`_]/g, "").trim().toLowerCase();
      capturing = headings.has(title);
      continue;
    }
    if (capturing) out.push(line);
  }
  return out.join("\n").trim();
}

async function writeInboxActions(ctx: RequestContext, slug: string, actions: string) {
  const saved = await writeNote(
    ctx, slug, INBOX_NAME,
    `# Inbox\n\n## Actions\n\n${actions.trim()}\n`,
  );
  return { ok: true, mtime: saved.mtime };
}

async function readActionsSection(ctx: RequestContext, slug: string, file: string): Promise<string | null> {
  const item = await noteMarkdown(ctx, slug, file);
  if (!item) return file === INBOX_NAME ? "" : null;
  return parseNote(item.text).sections.Actions || "";
}

async function appendActionCoordinated(ctx: RequestContext, slug: string, file: string, text: string) {
  const body = text.trim();
  if (!body || !validSlug(slug) || !validNote(file) || !(await loadAgenda(ctx, slug))) return null;
  const current = await readActionsSection(ctx, slug, file);
  if (current === null) return null;
  const next = [current.trim(), actionLine(body)].filter(Boolean).join("\n");
  if (file === INBOX_NAME) return writeInboxActions(ctx, slug, next);
  return putNote(ctx, slug, file, { sections: { Actions: next } });
}

async function markActionCoordinated(ctx: RequestContext, slug: string, file: string, input: { index?: number; text?: string; done?: boolean }) {
  if (!validSlug(slug) || !validNote(file)) return null;
  const item = await noteMarkdown(ctx, slug, file);
  if (!item) return null;
  const parsed = parseNote(item.text);
  const lines = (parsed.sections.Actions || "").split("\n");
  const wantedIndex = input.index !== undefined ? Math.max(0, Number(input.index) - 1) : -1;
  const wantedText = normalizeActionText(input.text || "");
  let seen = -1;
  let changed = false;
  const done = input.done !== false;
  const next = lines.map((line) => {
    const match = ACTION_LINE_RE.exec(line);
    if (!match) return line;
    seen += 1;
    const body = normalizeActionText(match[4]);
    const byIndex = wantedIndex >= 0 && seen === wantedIndex;
    const byText = Boolean(wantedText && body === wantedText);
    if (!byIndex && !byText) return line;
    changed = true;
    return `${match[1]}${done ? "x" : " "}${match[3]}${match[4]}`;
  });
  if (!changed) return { ok: false, error: "action not found" };
  if (file === INBOX_NAME) return writeInboxActions(ctx, slug, next.join("\n"));
  return putNote(ctx, slug, file, { sections: { Actions: next.join("\n") } });
}

export async function actionsPayload(ctx: RequestContext, slug: string) {
  const data = await loadAgenda(ctx, slug);
  if (!data) return null;
  const sessions = [];
  let open = 0;
  let total = 0;
  const inbox = await noteMarkdown(ctx, slug, INBOX_NAME);
  if (inbox) {
    const items = parseActions(parseNote(inbox.text).sections.Actions || "");
    if (items.length) {
      const count = items.filter((item) => !item.done).length;
      sessions.push({ note: INBOX_NAME, title: "Inbox", time: "—", open: count, total: items.length, items, inbox: true });
      open += count;
      total += items.length;
    }
  }
  for (const event of data.events.filter(safeNotable)) {
    const file = noteFileForEvent(event);
    const note = await noteMarkdown(ctx, slug, file);
    if (!note) continue;
    const items = parseActions(parseNote(note.text).sections.Actions || "");
    if (!items.length) continue;
    const count = items.filter((item) => !item.done).length;
    sessions.push({
      note: file,
      title: event.title,
      time: (event.start || "").slice(11, 16),
      open: count,
      total: items.length,
      items,
    });
    open += count;
    total += items.length;
  }
  return { open, total, sessions };
}

// ---------- what the Concierge tools read (lib/concierge-tools.ts; the Mac twins live in server.py) ----------

export async function conferenceStatus(ctx: RequestContext, slug: string): Promise<string | null> {
  const data = await loadAgenda(ctx, slug);
  return data ? confStatus(data) : null;
}

const DIGEST_EXCERPT_CHARS = 600;

/** server.py session_digest: each session's time, title and file, with excerpts of its notes, Summary and Actions. */
export async function sessionDigest(ctx: RequestContext, slug: string): Promise<string | null> {
  const data = await loadAgenda(ctx, slug);
  if (!data) return null;
  const lines: string[] = [];
  for (const event of data.events.filter(safeNotable)) {
    const file = noteFileForEvent(event);
    let line = `- ${(event.start || "").slice(11, 16)} ${event.title} [${file}]`;
    const note = await noteMarkdown(ctx, slug, file);
    if (note) {
      const sections = parseNote(note.text).sections;
      for (const [label, name] of [["notes", "Human notes"], ["summary", "Summary"], ["actions", "Actions"]]) {
        const body = (sections[name] || "").trim();
        if (body) line += `\n  ${label}: ${body.slice(0, DIGEST_EXCERPT_CHARS)}`;
      }
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/**
 * The session note a loosely named file means (server.py resolve_note_file): an exact file, the file without
 * `.md` or with a `slug/` prefix, the bare session id, or its HHMM time, when exactly one note matches.
 */
export async function resolveNoteFile(ctx: RequestContext, slug: string, raw: string): Promise<string | null> {
  const data = await loadAgenda(ctx, slug);
  if (!data) return null;
  const name = raw.trim().replace(/\\/g, "/").split("/").pop()?.replace(/\.md$/, "").toLowerCase() || "";
  if (!name) return null;
  const files = data.events.filter(safeNotable).map(noteFileForEvent);
  const exact = files.find((file) => file.replace(/\.md$/, "").toLowerCase() === name);
  if (exact) return exact;
  const matches = files.filter((file) => {
    const stem = file.replace(/\.md$/, "").toLowerCase();
    const cut = stem.indexOf("-");
    return name === stem.slice(cut + 1) || name === stem.slice(0, cut);
  });
  return matches.length === 1 ? matches[0] : null;
}

/** A session's abstract and speakers with their bios, for speaker research. */
export async function researchContext(ctx: RequestContext, slug: string, file: string) {
  const data = await loadAgenda(ctx, slug);
  const event = data?.events.filter(safeNotable).find((item) => noteFileForEvent(item) === file);
  if (!data || !event) return null;
  const people = data.speakers || {};
  return {
    slug,
    file,
    title: event.title || "",
    abstract: event.description || "",
    speakers: (event.speakers || []).map((id) => ({ name: speakerLabel(id, people), bio: people[id]?.bio || "" })),
  };
}

// The Concierge's own files, laid out as on the Mac: `.confnote/agent/<name>` for its workspace and
// `<slug>/.confnote/sources/<name>` for a conference's sources.
const ARTIFACT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

async function artifactKey(ctx: RequestContext, name: string, slug: string): Promise<string | null> {
  if (!ARTIFACT_RE.test(name) || name === "." || name === "..") return null;
  if (!slug) return key(ctx, ".confnote", "agent", name);
  if (!(await loadAgenda(ctx, slug))) return null;
  return key(ctx, slug, ".confnote", "sources", name);
}

export async function saveArtifact(ctx: RequestContext, name: string, content: string, slug = ""): Promise<boolean> {
  const target = await artifactKey(ctx, name, slug);
  if (!target) return false;
  await store(ctx).writeText(target, content);
  return true;
}

export async function readArtifact(ctx: RequestContext, name: string, slug = ""): Promise<string | null> {
  const target = await artifactKey(ctx, name, slug);
  if (!target) return null;
  return (await store(ctx).readText(target))?.text ?? null;
}

/** Moves a workspace file into a conference's sources; an error string when it cannot. */
export async function moveArtifact(ctx: RequestContext, name: string, slug: string): Promise<string | null> {
  const from = await artifactKey(ctx, name, "");
  const to = slug ? await artifactKey(ctx, name, slug) : null;
  if (!from || !to) return "Rejected: invalid name or unknown conference.";
  const item = await store(ctx).readText(from);
  if (!item) return `No workspace file named ${name} to move.`;
  await store(ctx).writeText(to, item.text);
  await store(ctx).remove?.(from);
  return null;
}

// Picks ("attending") live in each session note's frontmatter, as on the Mac app (server.py read_picks /
// set_picks): the stars, My Agenda, the Planner and both Concierges read the same line, and it syncs with the notes.
export const PICK_KEY = "attending";

function isPick(frontmatter: Record<string, string>): boolean {
  return String(frontmatter[PICK_KEY] || "").trim().toLowerCase() === "true";
}

export async function picksPayload(ctx: RequestContext, slug: string) {
  const data = await loadAgenda(ctx, slug);
  if (!data) return null;
  const notes: string[] = [];
  for (const event of data.events.filter(safeNotable)) {
    const file = noteFileForEvent(event);
    const note = await noteMarkdown(ctx, slug, file);
    if (note && isPick(parseNote(note.text).frontmatter)) notes.push(file);
  }
  return { slug, notes: notes.sort() };
}

/** Applies {note file: boolean}; unknown files are an error and nothing is written. Null if no such conference. */
export async function putPicks(ctx: RequestContext, slug: string, payload: unknown) {
  const data = await loadAgenda(ctx, slug);
  if (!data) return null;
  const picks = (payload as { picks?: unknown } | undefined)?.picks;
  if (!picks || typeof picks !== "object" || Array.isArray(picks) || Object.values(picks).some((on) => typeof on !== "boolean")) {
    return { error: "picks must map note files to true or false." };
  }
  const known = new Set(data.events.filter(safeNotable).map(noteFileForEvent));
  const unknown: string[] = [];
  for (const file of Object.keys(picks)) {
    if (!known.has(file) || !(await noteMarkdown(ctx, slug, file))) unknown.push(file);
  }
  if (unknown.length) return { error: `Not a session note of ${slug}: ${unknown.sort().join(", ")}` };
  const changed: Record<string, number> = {};
  for (const [file, on] of Object.entries(picks as Record<string, boolean>)) {
    let next: string;
    const mtime = await coordinatedNote(ctx, slug, file, (inner) => serialized(key(inner, slug, file), async () => {
      const item = await noteMarkdown(inner, slug, file);
      if (!item || isPick(parseNote(item.text).frontmatter) === on) return undefined;
      try {
        next = withFrontmatterFlag(item.text, PICK_KEY, on);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return (await writeNote(inner, slug, file, next)).mtime;
    }));
    if (typeof mtime === "string") return { error: `${file}: ${mtime}` };
    if (mtime !== undefined) changed[file] = mtime;
  }
  return { slug, notes: (await picksPayload(ctx, slug))?.notes || [], changed };
}

/** Read-only: the conference as a `.confnote` bundle (see vault-transfer.ts). */
export async function exportPayload(ctx: RequestContext, slug: string) {
  return exportConference(storage, ctx.workspace, slug);
}

export async function confDocPayload(ctx: RequestContext, slug: string) {
  const data = await loadAgenda(ctx, slug);
  if (!data) return null;
  const read = (name: string) => coordinatedNote(ctx, slug, name, async (inner) => {
    const item = await store(inner).readText(key(inner, slug, name));
    if (item && inner.noteRevision) return { ...item, mtime: await inner.noteRevision.observe(item.text) };
    return item;
  });
  const brief = await read("BRIEF.md");
  const debrief = await read("DEBRIEF.md");
  return {
    status: confStatus(data),
    brief: brief?.text || "",
    debrief: debrief?.text || "",
    brief_mtime: brief?.mtime || 0,
    debrief_mtime: debrief?.mtime || 0,
  };
}

async function putConfDocCoordinated(ctx: RequestContext, slug: string, name: string, payload: unknown) {
  if (!["BRIEF.md", "DEBRIEF.md"].includes(name)) return null;
  const data = await loadAgenda(ctx, slug);
  if (!data) return null;
  const current = await store(ctx).readText(key(ctx, slug, name));
  if (current && ctx.noteRevision) current.mtime = await ctx.noteRevision.observe(current.text);
  const body = payload as { text?: string; mtime?: number };
  if (body.mtime !== undefined && current && (!Number.isFinite(body.mtime) || Math.abs(body.mtime - current.mtime) > 1e-6)) {
    return { conflict: true, error: "stale", mtime: current.mtime, text: current.text };
  }
  const saved = await store(ctx).writeText(key(ctx, slug, name), `${(body.text || "").trimEnd()}\n`);
  return { ok: true, mtime: ctx.noteRevision ? await ctx.noteRevision.observe(saved.text) : saved.mtime };
}

async function syncDebriefActionsToInboxCoordinated(ctx: RequestContext, slug: string): Promise<{ ok: true; added: number } | null> {
  if (!validSlug(slug)) return null;
  const data = await loadAgenda(ctx, slug);
  if (!data) return null;
  const debrief = await store(ctx).readText(key(ctx, slug, "DEBRIEF.md"));
  const section = extractMarkdownSection(debrief?.text || "", DEBRIEF_ACTION_HEADINGS);
  const items = parseActions(section);
  if (!items.length) return { ok: true, added: 0 };
  const current = await readActionsSection(ctx, slug, INBOX_NAME);
  if (current === null) return null;
  const seen = new Set(parseActions(current).map((item) => normalizeActionText(item.text)));
  const additions: string[] = [];
  for (const item of items) {
    const normalized = normalizeActionText(item.text);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    additions.push(actionLine(item.text));
  }
  if (!additions.length) return { ok: true, added: 0 };
  await writeInboxActions(ctx, slug, [current.trim(), ...additions].filter(Boolean).join("\n"));
  return { ok: true, added: additions.length };
}

export async function filesPayload(ctx: RequestContext, slug: string, file: string) {
  if (!validSlug(slug) || !NOTE_RE.test(file)) return null;
  const stem = file.replace(/\.md$/, "");
  const dir = `notes/assets/${stem}/`;
  const objects = await store(ctx).list(key(ctx, slug, dir));
  return {
    dir,
    files: objects
      .filter((object) => !object.path.endsWith("/README.txt") && !object.path.endsWith(".tmp"))
      .map((object) => {
        const name = object.path.split("/").pop() || "";
        const rel = `${dir}${name}`;
        return {
          name,
          size: object.size,
          is_image: IMG_EXT.has(ext(name)),
          rel,
          url: `/assets?slug=${encodeURIComponent(slug)}&path=${encodeURIComponent(rel)}`,
        };
      }),
  };
}

export async function assetPayload(ctx: RequestContext, slug: string, rel: string) {
  if (!validSlug(slug) || rel.includes("..") || rel.startsWith("/")) return null;
  return store(ctx).readBytes(key(ctx, slug, "notes", rel.replace(/^notes\//, "")));
}

const UPLOAD_CONTENT_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf",
  "audio/mpeg", "audio/mp4", "audio/wav", "audio/webm", "video/mp4",
]);

export async function uploadAsset(ctx: RequestContext, slug: string, file: string, payload: unknown) {
  if (!validSlug(slug) || !NOTE_RE.test(file)) return null;
  const body = payload as { filename?: string; data?: string };
  const filename = (body.filename || "").replace(/[^A-Za-z0-9._-]/g, "-");
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(body.data || "");
  if (!filename || !match) return null;
  const stem = file.replace(/\.md$/, "");
  const bytes = Uint8Array.from(Buffer.from(match[2], "base64"));
  const rel = `assets/${stem}/${filename}`;
  // The browser names the type; only media and PDF keep theirs, anything else (text/html, image/svg+xml) is stored as bytes.
  const contentType = UPLOAD_CONTENT_TYPES.has(match[1].toLowerCase()) ? match[1].toLowerCase() : "application/octet-stream";
  await store(ctx).writeBytes(key(ctx, slug, "notes", rel), bytes, contentType);
  return { ok: true, rel, markdown: `![${filename}](${rel})` };
}

export async function moduleStatePayload(ctx: RequestContext, name: string, slug: string) {
  if (!MODULE_RE.test(name)) return null;
  if (slug && slug !== "home" && !validSlug(slug)) return null;
  const parts = slug && slug !== "home" ? [slug, ".confnote", "modules", `${name}.json`] : [".confnote", "modules", `${name}.json`];
  const item = await store(ctx).readText(key(ctx, ...parts));
  if (!item) return {};
  try {
    return JSON.parse(item.text);
  } catch {
    return {};
  }
}

export async function putModuleState(ctx: RequestContext, name: string, slug: string, payload: unknown) {
  if (!MODULE_RE.test(name)) return null;
  if (slug && slug !== "home" && !validSlug(slug)) return null;
  const parts = slug && slug !== "home" ? [slug, ".confnote", "modules", `${name}.json`] : [".confnote", "modules", `${name}.json`];
  await store(ctx).writeText(key(ctx, ...parts), JSON.stringify(payload || {}, null, 2));
  return { ok: true };
}

export async function privatePayload(ctx: RequestContext) {
  const item = await store(ctx).readText(key(ctx, ".confnote", "private.json"));
  if (!item) return { configured: false, params: null };
  try {
    return { configured: true, params: JSON.parse(item.text) };
  } catch {
    return { configured: false, params: null };
  }
}

export async function setupPrivate(ctx: RequestContext, payload: unknown) {
  await store(ctx).writeText(key(ctx, ".confnote", "private.json"), JSON.stringify(payload));
  return { ok: true };
}

export async function validateConference(payload: unknown) {
  const body = payload as { agenda?: unknown };
  return validateAgenda(body.agenda || payload);
}

export async function addConference(ctx: RequestContext, payload: unknown) {
  const body = payload as { agenda?: unknown };
  const agenda = body.agenda || payload;
  const validation = validateAgenda(agenda);
  // The slug becomes a folder name: a date like "2026-11-09/x" from an imported page must not nest one.
  const date = String((agenda as Partial<AgendaData>)?.conference?.date || "");
  if (!validation.errors.length && !/^\d{4}-\d{2}-\d{2}$/.test(date)) validation.errors.push("conference.date must be YYYY-MM-DD");
  if (validation.errors.length) return { ok: false, ...validation };
  const workspace = ctx.allocateConference ? await ctx.allocateConference(agenda as AgendaData) : ctx.workspace;
  const imported = await importAgenda(store(ctx), workspace, agenda as AgendaData);
  ctx.workspace = workspace;
  return { ok: true, ...imported, ...validation, workspaceId: workspace };
}

const MINUTES_PER_DAY = 24 * 60;

export function confStatus(data: AgendaData, now = new Date()): string {
  const events = data.events
    .filter((event) => event.start && event.end)
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));
  if (!events.length) return "No scheduled events.";
  const first = new Date(events[0].start || "");
  const last = new Date(events[events.length - 1].end || "");
  const human = (ms: number): string => {
    const mins = Math.floor(Math.abs(ms) / 60000);
    if (mins < 60) return `${mins}m`;
    if (mins >= MINUTES_PER_DAY) {
      const days = Math.floor(mins / MINUTES_PER_DAY);
      return days === 1 ? "1 day" : `${days} days`;
    }
    return mins % 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${Math.floor(mins / 60)}h`;
  };
  if (now < first) return `Pre-conference — starts in ${human(first.getTime() - now.getTime())}.`;
  if (now > last) return `Post-conference — ended ${human(now.getTime() - last.getTime())} ago.`;
  for (const event of events) {
    const start = new Date(event.start || "");
    const end = new Date(event.end || "");
    if (start <= now && now <= end) return `LIVE: '${event.title}' (until ${(event.end || "").slice(11, 16)}).`;
  }
  return "Between sessions.";
}

export async function notePayload(ctx: RequestContext, slug: string, file: string) {
  return coordinatedNote(ctx, slug, file, (inner) => notePayloadCoordinated(inner, slug, file));
}

export async function putNote(ctx: RequestContext, slug: string, file: string, payload: unknown) {
  return coordinatedNote(ctx, slug, file, (inner) => putNoteCoordinated(inner, slug, file, payload));
}

/** Decides, under the note's write lock, whether a section's current body may be replaced. */
export type SectionGuard = (name: string, current: string) => boolean;

export async function putAgentNoteSections(ctx: RequestContext, slug: string, file: string, sectionsPatch: Record<string, string>, replaceable?: SectionGuard) {
  return coordinatedNote(ctx, slug, file, (inner) => putAgentNoteSectionsCoordinated(inner, slug, file, sectionsPatch, replaceable));
}

export async function appendAction(ctx: RequestContext, slug: string, file: string, text: string) {
  return coordinatedNote(ctx, slug, file, (inner) => appendActionCoordinated(inner, slug, file, text));
}

export async function markAction(ctx: RequestContext, slug: string, file: string, input: { index?: number; text?: string; done?: boolean }) {
  return coordinatedNote(ctx, slug, file, (inner) => markActionCoordinated(inner, slug, file, input));
}

export async function syncDebriefActionsToInbox(ctx: RequestContext, slug: string) {
  return coordinatedNote(ctx, slug, INBOX_NAME, (inner) => syncDebriefActionsToInboxCoordinated(inner, slug));
}

export async function putConfDoc(ctx: RequestContext, slug: string, name: string, payload: unknown) {
  return coordinatedNote(ctx, slug, name, (inner) => putConfDocCoordinated(inner, slug, name, payload));
}
