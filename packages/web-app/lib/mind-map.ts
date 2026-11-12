import { BOARD_MODULE } from "./board.js";
import { sectionHasRealContent } from "./sections.js";
import { conferencePayload, notePayload, putModuleState } from "./service.js";
import type { RequestContext } from "./types.js";

// "Draw a mind map of today's topics and my notes": the conference day (or one session) in the middle, a
// branch per topic, leaves for key points from the notes and for the speakers. The server builds the spec and
// keeps it where the day board lives (module state "tldraw-board"); the tldraw drawer lays it out and draws it
// (modules/tldraw/mind-map.js). concierge_tools.build_mind_map_spec is the Python port; both are checked
// against packages/contracts/fixtures/mind-map.json.

const MAX_BRANCHES = 7;
const MAX_POINTS = 4;
const MAX_SPEAKERS = 3;
const POINT_CHARS = 90;
const TOPIC_CHARS = 40;
const TITLE_CHARS = 70;
const COLORS = ["blue", "orange", "green", "violet", "red", "light-blue", "light-green"] as const;
const NOTE_SECTIONS = ["Human notes", "Summary", "Research"] as const;
const REST_TYPES = new Set(["break", "lunch", "logistics", "networking", "social"]);
// Tags that name a kind of session, not a topic: never a branch of their own.
const GENERIC_TAGS = new Set(["opening", "welcome", "closing", "panel", "keynote", "talk", "demo"]);

const MD_LINK = /\[([^\]]+)\]\([^)]*\)/g;
const BULLET = /^(?:>\s*)?(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)?/;
const SENTENCE_END = /(?<=[.!?])\s/;

export interface BranchInput {
  topic: string;
  sessions?: string[];
  points?: string[];
}

export interface MindMapLeaf {
  text: string;
  kind: "point" | "session" | "speaker" | "tag";
}

export interface MindMapSpec {
  id: string;
  kind: "mindmap";
  slug: string;
  day: string;
  center: { title: string; subtitle: string };
  branches: Array<{ topic: string; leaves: MindMapLeaf[]; color: string }>;
}

export interface MapEvent {
  id?: string;
  title?: string;
  start?: string;
  end?: string;
  room?: string;
  track?: string;
  type?: string;
  tags?: string[];
  speakers?: string[];
  note?: string;
  has_notes?: boolean;
}

/** A session's note sections by note file ({"Human notes": "…"}). */
export type MapNotes = Record<string, Partial<Record<string, string>>>;

interface Chosen {
  topic: string;
  sessions: string[];
  points: string[];
}

/** `text` cut to `limit` characters at a word boundary, with an ellipsis. */
export function clipText(text: unknown, limit: number): string {
  const flat = String(text ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
  if (flat.length <= limit) return flat;
  let cut = flat.slice(0, limit - 1);
  if (cut.includes(" ")) cut = cut.slice(0, cut.lastIndexOf(" "));
  return `${cut.replace(/[ ,;:-]+$/, "")}…`;
}

/** The first `limit` lines of a note section as short points: bullets and markdown stripped, one sentence each. */
export function keyPoints(text: string | undefined, limit: number): string[] {
  const out: string[] = [];
  for (const raw of String(text || "").split("\n")) {
    let line = raw.trim();
    if (line.startsWith("#")) {
      if (line.replace(/^#+/, "").trim().toLowerCase() === "sources") break;
      continue;
    }
    line = line.replace(BULLET, "").replace(MD_LINK, "$1").replace(/[*`]/g, "").trim();
    if (!line || /^https?:\/\//.test(line)) continue;
    line = line.split(SENTENCE_END)[0].replace(/\.+$/, "");
    out.push(clipText(line, POINT_CHARS));
    if (out.length >= limit) break;
  }
  return out;
}

function speakerName(label: string): string {
  return String(label || "")
    .split(" (")[0]
    .trim();
}

function localDay(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function dayLabel(day: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(date);
}

/** Topics from the sessions' tags: each session joins its most common tag. */
function tagBranches(talks: MapEvent[]): Chosen[] {
  const counts = new Map<string, number>();
  const order = new Map<string, number>();
  const label = new Map<string, string>();
  for (const event of talks) {
    for (const tag of event.tags || []) {
      const key = String(tag).trim().toLowerCase();
      if (!key || GENERIC_TAGS.has(key)) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
      if (!order.has(key)) order.set(key, order.size);
      if (!label.has(key)) label.set(key, String(tag).trim());
    }
  }
  const groups = new Map<string, string[]>();
  for (const event of talks) {
    let best: string | null = null;
    for (const tag of event.tags || []) {
      const key = String(tag).trim().toLowerCase();
      if (!counts.has(key)) continue;
      const count = counts.get(key) as number;
      if (best === null) {
        best = key;
        continue;
      }
      const bestCount = counts.get(best) as number;
      if (count > bestCount || (count === bestCount && (order.get(key) as number) < (order.get(best) as number))) best = key;
    }
    if (best !== null) groups.set(best, [...(groups.get(best) || []), event.id as string]);
  }
  const ranked = [...groups.keys()].sort((a, b) => (groups.get(b) as string[]).length - (groups.get(a) as string[]).length || (order.get(a) as number) - (order.get(b) as number));
  return ranked.map((key) => {
    const text = label.get(key) as string;
    return { topic: text.slice(0, 1).toUpperCase() + text.slice(1), sessions: groups.get(key) as string[], points: [] };
  });
}

/** Themes when the sessions carry no tags: tracks, else rooms, else session kinds (board.ts fallbackThemes). */
function fallbackBranches(talks: MapEvent[]): Chosen[] {
  for (const field of ["track", "room"] as const) {
    const groups = new Map<string, string[]>();
    for (const event of talks) {
      const value = (event[field] || "").trim();
      if (!value || !event.id) continue;
      groups.set(value, [...(groups.get(value) || []), event.id]);
    }
    if (groups.size >= 2) return [...groups.entries()].map(([topic, sessions]) => ({ topic, sessions, points: [] }));
  }
  const kinds = new Map<string, string[]>();
  for (const event of talks) {
    const kind = event.type ? event.type[0].toUpperCase() + event.type.slice(1) : "Talk";
    kinds.set(kind, [...(kinds.get(kind) || []), event.id as string]);
  }
  return [...kinds.entries()].map(([topic, sessions]) => ({ topic, sessions, points: [] }));
}

function requestedBranches(branches: BranchInput[] | undefined, known: Set<string>): Chosen[] {
  const out: Chosen[] = [];
  for (const branch of branches || []) {
    const topic = clipText(branch.topic || "", TOPIC_CHARS);
    const sessions = (branch.sessions || []).filter((id) => known.has(id));
    const points = (branch.points || [])
      .map((point) => clipText(point, POINT_CHARS))
      .filter(Boolean)
      .slice(0, MAX_POINTS);
    if (topic && (sessions.length || points.length)) out.push({ topic, sessions, points });
  }
  return out;
}

function speakerLeaves(sessions: MapEvent[]): MindMapLeaf[] {
  const names = [...new Set(sessions.flatMap((event) => (event.speakers || []).map(speakerName)).filter(Boolean))];
  const shown = names.slice(0, MAX_SPEAKERS);
  if (names.length > shown.length) shown.push(`+${names.length - shown.length} more`);
  return shown.map((text) => ({ text, kind: "speaker" }));
}

/** The Concierge's key points; without them, the notes' points first and the titles of sessions without notes after; then the speakers. */
function branchLeaves(branch: Chosen, sessions: MapEvent[], notes: MapNotes): MindMapLeaf[] {
  const leaves: MindMapLeaf[] = branch.points.map((text) => ({ text, kind: "point" }));
  if (!leaves.length && sessions.length) {
    const perSession = Math.max(1, Math.floor(MAX_POINTS / sessions.length));
    const titles: MindMapLeaf[] = [];
    for (const event of sessions) {
      const sections = notes[event.note || ""] || {};
      const found = NOTE_SECTIONS.map((name) => keyPoints(sections[name], perSession)).find((points) => points.length) || [];
      leaves.push(...found.map((text): MindMapLeaf => ({ text, kind: "point" })));
      if (!found.length) titles.push({ text: clipText(event.title || "", TITLE_CHARS), kind: "session" });
    }
    leaves.push(...titles);
  }
  return [...leaves.slice(0, MAX_POINTS), ...speakerLeaves(sessions)];
}

/** A session's own map when the Concierge names no topics: its notes, then its tags. */
function sessionBranches(event: MapEvent, notes: MapNotes): Array<{ topic: string; leaves: MindMapLeaf[] }> {
  const sections = notes[event.note || ""] || {};
  const out: Array<{ topic: string; leaves: MindMapLeaf[] }> = [];
  for (const [name, topic] of [
    ["Human notes", "My notes"],
    ["Summary", "Summary"],
    ["Research", "Research"],
  ] as const) {
    const points = keyPoints(sections[name], MAX_POINTS);
    if (points.length) out.push({ topic, leaves: points.map((text) => ({ text, kind: "point" })) });
  }
  const tags = (event.tags || [])
    .map((tag) => String(tag).trim())
    .filter(Boolean)
    .slice(0, MAX_POINTS);
  if (tags.length) out.push({ topic: "Topics", leaves: tags.map((text) => ({ text, kind: "tag" })) });
  return out;
}

export function buildMindMapSpec(
  slug: string,
  conference: { name?: string },
  events: MapEvent[],
  notes: MapNotes,
  options: { day?: string; file?: string; branches?: BranchInput[] } = {},
  now = new Date(),
): MindMapSpec | { error: string } {
  const dated = events.filter((event) => event.id && event.start);
  const days = [...new Set(dated.map((event) => String(event.start).slice(0, 10)))].sort();
  if (!days.length) return { error: "This conference has no scheduled sessions to map." };
  let day = days.includes(localDay(now)) ? localDay(now) : days[0];
  if (options.day && days.includes(options.day)) day = options.day;
  const byId = new Map(dated.map((event) => [event.id as string, event]));
  let out: Array<{ topic: string; leaves: MindMapLeaf[] }> = [];
  let center: MindMapSpec["center"];
  if (options.file) {
    const event = dated.find((entry) => entry.note === options.file || entry.id === options.file);
    if (!event) return { error: `No session ${options.file} in this conference. Use a note file from get_conference.` };
    day = String(event.start).slice(0, 10);
    center = { title: clipText(event.title || "", TITLE_CHARS), subtitle: `${String(event.start).slice(11, 16)}–${String(event.end || "").slice(11, 16)}` };
    const requested = requestedBranches(options.branches, new Set());
    out = requested.length ? requested.map((branch) => ({ topic: branch.topic, leaves: branch.points.map((text): MindMapLeaf => ({ text, kind: "point" })) })) : sessionBranches(event, notes);
    const speakers = speakerLeaves([event]);
    if (speakers.length) out.push({ topic: "Speakers", leaves: speakers });
  } else {
    const onDay = dated.filter((event) => String(event.start).slice(0, 10) === day).sort((a, b) => String(a.start).localeCompare(String(b.start)));
    const talks = onDay.filter((event) => !REST_TYPES.has(event.type || ""));
    const known = new Set(talks.map((event) => event.id as string));
    let chosen = requestedBranches(options.branches, known);
    if (!chosen.length) chosen = tagBranches(talks);
    if (!chosen.length) chosen = fallbackBranches(talks);
    for (const branch of chosen.slice(0, MAX_BRANCHES)) {
      const sessions = branch.sessions.map((id) => byId.get(id) as MapEvent).sort((a, b) => String(a.start).localeCompare(String(b.start)));
      out.push({ topic: branch.topic, leaves: branchLeaves(branch, sessions, notes) });
    }
    center = { title: conference.name || "", subtitle: dayLabel(day) };
  }
  const branches = out
    .filter((branch) => branch.leaves.length)
    .slice(0, MAX_BRANCHES)
    .map((branch, index) => ({ ...branch, color: COLORS[index % COLORS.length] }));
  if (!branches.length) return { error: "Nothing to map yet: this session has no notes, tags or speakers." };
  return { id: `map-${day}-${now.getTime().toString(16)}`, kind: "mindmap", slug, day, center, branches };
}

export async function drawMindMap(
  ctx: RequestContext,
  slug: string,
  options: { day?: string; file?: string; branches?: BranchInput[] },
): Promise<{ ok: true; map: string; day: string; center: string; topics: string[]; leaves: number } | { error: string }> {
  const data = await conferencePayload(ctx, slug);
  if (!data) return { error: `Conference not found: ${slug}` };
  const events = data.events as MapEvent[];
  const notes: MapNotes = {};
  for (const event of events) {
    if (!event.has_notes || !event.note) continue;
    const note = await notePayload(ctx, slug, event.note);
    if (!note) continue;
    const sections = note.sections as Record<string, string>;
    // Without the importer's seed hints (and Summary's seeded abstract): only what the user or the agent wrote.
    const real = (name: string) =>
      String(sections[name] || "")
        .split("\n")
        .filter((line) => sectionHasRealContent(name, line))
        .join("\n");
    notes[event.note] = Object.fromEntries(NOTE_SECTIONS.map((name) => [name, real(name)]));
  }
  const spec = buildMindMapSpec(slug, data.conference, events, notes, options);
  if ("error" in spec) return spec;
  await putModuleState(ctx, BOARD_MODULE, slug, spec);
  return {
    ok: true,
    map: spec.id,
    day: spec.day,
    center: spec.center.title,
    topics: spec.branches.map((branch) => branch.topic),
    leaves: spec.branches.reduce((sum, branch) => sum + branch.leaves.length, 0),
  };
}
