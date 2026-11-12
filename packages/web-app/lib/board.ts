import { conferencePayload, putModuleState } from "./service.js";
import type { RequestContext } from "./types.js";

// "Put the conference on the canvas": the Concierge picks the themes, the server lays out one day as a board
// spec, and the tldraw drawer draws it (modules/tldraw/tldraw.js drawBoard). The spec is kept per conference
// in the vault, so the board is there again after a reload.

export const BOARD_MODULE = "tldraw-board";
const MAX_THEMES = 6;
const MAX_SPEAKERS_SHOWN = 4;
// tldraw's own named colours, in the order themes get them; "grey" is kept for sessions without a theme.
const THEME_COLORS = ["blue", "orange", "green", "violet", "red", "light-blue"] as const;
const OTHER = { name: "Other", color: "grey" };
const REST_TYPES = new Set(["break", "lunch", "logistics", "networking", "social"]);

export interface ThemeInput {
  name: string;
  sessions: string[];
}

export interface BoardSession {
  id: string;
  title: string;
  time: string;
  slot: number;
  theme: number;
  speakers: string[];
  rest: boolean;
}

export interface BoardSpec {
  id: string;
  slug: string;
  day: string;
  title: string;
  themes: Array<{ name: string; color: string }>;
  slots: string[];
  sessions: BoardSession[];
}

interface ConfEvent {
  id?: string;
  title?: string;
  start?: string;
  end?: string;
  room?: string;
  track?: string;
  type?: string;
  speakers?: string[];
}

function clock(iso?: string): string {
  return String(iso || "").slice(11, 16);
}

function dayOf(iso?: string): string {
  return String(iso || "").slice(0, 10);
}

function dayLabel(day: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(date);
}

/** Themes when the Concierge gives none: tracks, else rooms, else session kinds. */
function fallbackThemes(events: ConfEvent[]): ThemeInput[] {
  for (const field of ["track", "room"] as const) {
    const groups = new Map<string, string[]>();
    for (const event of events) {
      const value = (event[field] || "").trim();
      if (!value || !event.id) continue;
      groups.set(value, [...(groups.get(value) || []), event.id]);
    }
    if (groups.size >= 2) return [...groups.entries()].map(([name, sessions]) => ({ name, sessions }));
  }
  const kinds = new Map<string, string[]>();
  for (const event of events) {
    if (!event.id) continue;
    const kind = event.type ? event.type[0].toUpperCase() + event.type.slice(1) : "Talk";
    kinds.set(kind, [...(kinds.get(kind) || []), event.id]);
  }
  return [...kinds.entries()].map(([name, sessions]) => ({ name, sessions }));
}

export function buildBoardSpec(
  slug: string,
  conference: { name: string; date: string },
  allEvents: ConfEvent[],
  options: { day?: string; themes?: ThemeInput[] } = {},
  now = new Date(),
): BoardSpec | { error: string } {
  const dated = allEvents.filter((event) => event.id && event.start);
  const days = [...new Set(dated.map((event) => dayOf(event.start)))].sort();
  if (!days.length) return { error: "This conference has no scheduled sessions to draw." };
  const day = options.day && days.includes(options.day) ? options.day : days[0];
  const events = dated
    .filter((event) => dayOf(event.start) === day)
    .sort((a, b) => Date.parse(a.start || "") - Date.parse(b.start || ""));
  const talks = events.filter((event) => !REST_TYPES.has(event.type || ""));

  const known = new Set(talks.map((event) => event.id as string));
  const requested = (options.themes || [])
    .map((theme) => ({ name: String(theme.name || "").trim().slice(0, 48), sessions: (theme.sessions || []).filter((id) => known.has(id)) }))
    .filter((theme) => theme.name && theme.sessions.length);
  const chosen = (requested.length ? requested : fallbackThemes(talks)).slice(0, MAX_THEMES);
  const themeOf = new Map<string, number>();
  chosen.forEach((theme, index) => {
    for (const id of theme.sessions) if (!themeOf.has(id)) themeOf.set(id, index);
  });
  const themes: BoardSpec["themes"] = chosen.map((theme, index) => ({ name: theme.name, color: THEME_COLORS[index % THEME_COLORS.length] }));
  if (talks.some((event) => !themeOf.has(event.id as string))) themes.push(OTHER);
  const otherIndex = themes.length - 1;

  const slots = [...new Set(events.map((event) => clock(event.start)))];
  const sessions: BoardSession[] = events.map((event) => {
    const rest = REST_TYPES.has(event.type || "");
    const speakers = event.speakers || [];
    const shown = speakers.slice(0, MAX_SPEAKERS_SHOWN);
    if (speakers.length > shown.length) shown.push(`+${speakers.length - shown.length} more`);
    return {
      id: event.id as string,
      title: String(event.title || "").slice(0, 140),
      time: `${clock(event.start)}–${clock(event.end)}`,
      slot: slots.indexOf(clock(event.start)),
      theme: rest ? -1 : (themeOf.get(event.id as string) ?? otherIndex),
      speakers: rest ? [] : shown,
      rest,
    };
  });
  return {
    id: `${day}-${now.getTime().toString(36)}`,
    slug,
    day,
    title: `${conference.name} · ${dayLabel(day)}`,
    themes,
    slots,
    sessions,
  };
}

export async function drawConferenceBoard(
  ctx: RequestContext,
  slug: string,
  options: { day?: string; themes?: ThemeInput[] },
): Promise<{ ok: true; board: string; day: string; sessions: number; themes: string[] } | { error: string }> {
  const data = await conferencePayload(ctx, slug);
  if (!data) return { error: `Conference not found: ${slug}` };
  const spec = buildBoardSpec(slug, data.conference, data.events as ConfEvent[], options);
  if ("error" in spec) return spec;
  await putModuleState(ctx, BOARD_MODULE, slug, spec);
  return { ok: true, board: spec.id, day: spec.day, sessions: spec.sessions.length, themes: spec.themes.map((theme) => theme.name) };
}
