import { jsonSchema, tool, type ToolSet } from "ai";
import spec from "../../contracts/tools.json" with { type: "json" };
import { INBOX_NAME } from "./agenda.js";
import { drawConferenceBoard } from "./board.js";
import { drawMindMap } from "./mind-map.js";
import {
  actionsPayload,
  addConference,
  appendAction,
  confDocPayload,
  conferencePayload,
  conferenceStatus,
  conferencesPayload,
  markAction,
  moveArtifact,
  notePayload,
  putAgentNoteSections,
  putConfDoc,
  putPicks,
  readArtifact,
  researchContext,
  resolveNoteFile,
  saveArtifact,
  sessionDigest,
  syncDebriefActionsToInbox,
  validateConference,
} from "./service.js";
import type { RequestContext } from "./types.js";
import { UNTRUSTED, fetchUrlText, webSearch } from "./webResearch.js";

// The hosted Concierge's tools, built from the one spec (packages/contracts/tools.json) that the Mac app's
// packages/local-app/concierge_tools.py implements too: same names, purposes and parameters. Each handler below
// answers a JSON object; a failure is {error}. test/tool-contract.test.ts fails when this file and the spec drift.

export type ToolResult = Record<string, unknown>;
type Args = Record<string, any>;

export interface ToolSpec {
  name: string;
  access: string;
  purpose: string;
  input_schema: Record<string, any>;
  result: string;
}

export interface ToolEnv {
  ctx: RequestContext;
  /** The conference and note the user has open. */
  slug: string;
  file: string;
  /** Work a tool queues for after the reply (the brief), so it never counts against the agent's step time. */
  deferred: { briefSlug?: string };
  /** chat.ts owns the link importer (it needs the model to read a page). */
  importFromUrl(url: string): Promise<ToolResult>;
}

export const HOST = "hosted";
export const TOOL_SPECS = spec.tools as ToolSpec[];
const NOT_ON = new Set(spec.not_on.filter((entry) => entry.host === HOST).map((entry) => entry.tool));
const AGENT_SECTIONS = new Set(["Summary", "Research", "AI notes"]);
const CANVAS_TOOLS = new Set(["draw_conference_board", "draw_mind_map"]);

export function toolSpec(name: string): ToolSpec {
  const found = TOOL_SPECS.find((entry) => entry.name === name);
  if (!found) throw new Error(`No such Concierge tool: ${name}`);
  return found;
}

// ---------- argument checking (concierge_tools.check_args: the subset of JSON Schema the spec uses) ----------

const JSON_TYPES: Record<string, (value: unknown) => boolean> = {
  string: (value) => typeof value === "string",
  integer: (value) => Number.isInteger(value),
  number: (value) => typeof value === "number" && Number.isFinite(value),
  boolean: (value) => typeof value === "boolean",
  array: (value) => Array.isArray(value),
  object: (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value),
};

function checkValue(schema: Record<string, any>, value: unknown, where: string): unknown {
  const expected = schema.type as string | undefined;
  if (expected && JSON_TYPES[expected] && !JSON_TYPES[expected](value)) throw new Error(`${where} must be ${expected}`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${where} must be one of ${schema.enum.join(", ")}`);
  if (expected === "string") {
    const text = value as string;
    if (schema.maxLength !== undefined && text.length > schema.maxLength) throw new Error(`${where} is longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(text)) throw new Error(`${where} has the wrong format`);
  }
  if (expected === "integer") {
    const number = value as number;
    if (schema.minimum !== undefined && number < schema.minimum) throw new Error(`${where} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && number > schema.maximum) throw new Error(`${where} must be at most ${schema.maximum}`);
  }
  if (expected === "array") {
    const items = value as unknown[];
    if (schema.maxItems !== undefined && items.length > schema.maxItems) throw new Error(`${where} has more than ${schema.maxItems} items`);
    return items.map((item) => checkValue(schema.items || {}, item, `${where}[]`));
  }
  if (expected === "object") return checkArgs(schema, value, where);
  return value;
}

export function checkArgs(schema: Record<string, any>, args: unknown, where = "arguments"): Args {
  if (!JSON_TYPES.object(args)) throw new Error(`${where} must be an object`);
  const input = args as Args;
  const props: Record<string, any> = schema.properties || {};
  const unknown = Object.keys(input).filter((name) => !(name in props)).sort();
  if (unknown.length && schema.additionalProperties === false) throw new Error(`unknown ${where}: ${unknown.join(", ")}`);
  const missing = (schema.required || []).filter((name: string) => !(name in input));
  if (missing.length) throw new Error(`missing ${missing.join(", ")}`);
  const out: Args = {};
  for (const [name, value] of Object.entries(input)) if (name in props) out[name] = checkValue(props[name], value, name);
  return out;
}

// ---------- scope helpers ----------

function slugOf(env: ToolEnv, args: Args): string {
  return String(args.slug || env.slug || "").trim();
}

function noConference(slug: string): ToolResult {
  if (!slug) return { error: "No conference is open. Call list_conferences and pass a slug." };
  return { error: `No such conference: ${slug}. Call list_conferences for valid slugs.` };
}

async function noteFile(env: ToolEnv, slug: string, raw: unknown, inboxDefault = true): Promise<string | null> {
  const given = String(raw || "").trim() || (slug === env.slug ? env.file : "");
  if (!given) return inboxDefault ? INBOX_NAME : null;
  if (given === INBOX_NAME) return given;
  return resolveNoteFile(env.ctx, slug, given);
}

/** [[file, file]] for every two picked sessions whose times overlap (concierge_tools.overlapping_pairs). */
export function overlappingPairs(events: Array<{ file: string; start?: string; end?: string }>): string[][] {
  const timed = events.filter((event) => event.start && event.end);
  const out: string[][] = [];
  timed.forEach((a, index) => {
    for (const b of timed.slice(index + 1)) {
      if (Date.parse(a.start as string) < Date.parse(b.end as string) && Date.parse(b.start as string) < Date.parse(a.end as string)) {
        out.push([a.file, b.file]);
      }
    }
  });
  return out;
}

async function writeSection(env: ToolEnv, args: Args, section: string, text: string): Promise<ToolResult> {
  const slug = slugOf(env, args);
  if (!(await conferenceStatus(env.ctx, slug))) return noConference(slug);
  const file = await noteFile(env, slug, args.file, false);
  if (!file || file === INBOX_NAME) return { error: "A session note file is required to write a section." };
  const result = await putAgentNoteSections(env.ctx, slug, file, { [section]: text });
  if (!result) return { error: `Could not write ${section} for ${slug}/${file}` };
  return { ok: true, slug, file, section };
}

// ---------- the handlers: one per spec tool served on the hosted site ----------

type Handler = (args: Args, env: ToolEnv) => Promise<ToolResult>;

export const HANDLERS: Record<string, Handler> = {
  list_conferences: async (_args, env) => {
    const rows = [];
    for (const row of await conferencesPayload(env.ctx)) rows.push({ ...row, status: await conferenceStatus(env.ctx, row.slug) });
    return { conferences: rows };
  },
  get_conference: async (args, env) => {
    const slug = slugOf(env, args);
    const data = slug ? await conferencePayload(env.ctx, slug) : null;
    if (!data) return noConference(slug);
    return { slug, conference: data.conference, rooms: data.rooms, tracks: data.tracks, events: data.events };
  },
  get_conference_docs: async (args, env) => {
    const slug = slugOf(env, args);
    const docs = slug ? await confDocPayload(env.ctx, slug) : null;
    if (!docs) return noConference(slug);
    return { slug, status: docs.status, brief: docs.brief, debrief: docs.debrief };
  },
  read_notes: async (args, env) => {
    const slug = slugOf(env, args);
    const digest = slug ? await sessionDigest(env.ctx, slug) : null;
    if (digest === null) return noConference(slug);
    return { slug, digest: digest || "(no notes yet)" };
  },
  read_note: async (args, env) => {
    const slug = slugOf(env, args);
    if (!(await conferenceStatus(env.ctx, slug))) return noConference(slug);
    const file = await noteFile(env, slug, args.file);
    const note = file ? await notePayload(env.ctx, slug, file) : null;
    if (!note) return { error: `No such note: ${args.file || file}` };
    const { Private: _private, ...sections } = note.sections; // never shown to the agent
    return { slug, file, title: note.title, frontmatter: note.frontmatter, sections };
  },
  get_my_agenda: async (args, env) => {
    const slug = slugOf(env, args);
    const data = slug ? await conferencePayload(env.ctx, slug) : null;
    if (!data) return noConference(slug);
    const picks = (data.events as Args[])
      .filter((event) => event.note && event.attending)
      .map((event) => ({
        file: event.note as string,
        id: event.id,
        title: event.title,
        start: event.start,
        end: event.end,
        room: event.room || "",
        speakers: event.speakers || [],
        description: event.description || "",
      }))
      .sort((a, b) => String(a.start).localeCompare(String(b.start)));
    return { slug, picks, clashes: overlappingPairs(picks) };
  },
  get_actions: async (args, env) => {
    const slug = slugOf(env, args);
    const data = slug ? await actionsPayload(env.ctx, slug) : null;
    return data || noConference(slug);
  },
  research_speakers: async (args, env) => {
    const slug = slugOf(env, args);
    if (!(await conferenceStatus(env.ctx, slug))) return noConference(slug);
    const file = await noteFile(env, slug, args.file, false);
    const context = file ? await researchContext(env.ctx, slug, file) : null;
    return context || { error: `Unknown session: ${args.file}` };
  },
  validate_conference: async (args) => {
    let agenda: unknown;
    try {
      agenda = JSON.parse(args.agenda_json);
    } catch (error) {
      return { ok: false, errors: [`invalid agenda JSON: ${error instanceof Error ? error.message : error}`], warnings: [] };
    }
    const result = await validateConference(agenda);
    return { ok: !result.errors.length, ...result };
  },
  read_artifact: async (args, env) => {
    const slug = String(args.slug || "").trim();
    const content = await readArtifact(env.ctx, args.name, slug);
    if (content === null) return { error: `No such artifact: ${args.name}` };
    return { name: args.name, slug, content };
  },
  web_search: async (args) => {
    const found = await webSearch(args.query, args.max_results);
    if ("error" in found) return found;
    return { results: found.results, trust: UNTRUSTED };
  },
  fetch_url: async (args) => {
    const page = await fetchUrlText(args.url);
    if ("error" in page) return page;
    return { url: page.url, title: page.title || "", text: page.text, truncated: Boolean(page.truncated), trust: UNTRUSTED };
  },
  set_attending: async (args, env) => {
    const slug = slugOf(env, args);
    if (!(await conferenceStatus(env.ctx, slug))) return noConference(slug);
    const file = await noteFile(env, slug, args.file, false);
    if (!file || file === INBOX_NAME) return { error: `Unknown session: ${args.file}` };
    const result = await putPicks(env.ctx, slug, { picks: { [file]: args.attending } });
    if (!result || "error" in result) return { error: result?.error || `Could not save the pick for ${file}` };
    return { slug, file, attending: args.attending, notes: result.notes };
  },
  append_action: async (args, env) => {
    const slug = slugOf(env, args);
    if (!(await conferenceStatus(env.ctx, slug))) return noConference(slug);
    const file = await noteFile(env, slug, args.file);
    const text = String(args.text).trim();
    if (!file || !text) return { error: "A session note (or INBOX.md) and action text are required." };
    const result = await appendAction(env.ctx, slug, file, text);
    if (!result) return { error: `Could not append the action to ${slug}/${file}` };
    return { ok: true, slug, file, action: text };
  },
  mark_action_done: async (args, env) => {
    const slug = slugOf(env, args);
    if (!(await conferenceStatus(env.ctx, slug))) return noConference(slug);
    const file = await noteFile(env, slug, args.file);
    if (!file) return { error: `No such note: ${args.file}` };
    const done = args.done !== false;
    const result = await markAction(env.ctx, slug, file, { index: args.index, text: args.text, done });
    if (!result) return { error: `No such note: ${args.file || file}` };
    if ("error" in result && result.error) return { error: result.error };
    return { ok: true, slug, file, done };
  },
  update_agent_section: async (args, env) => {
    if (!AGENT_SECTIONS.has(args.section)) return { error: "Only Summary, Research or AI notes can be written." };
    return writeSection(env, args, args.section, args.text);
  },
  save_research: async (args, env) => {
    const sources = ((args.sources as string[] | undefined) || []).filter((url) => url.trim());
    const block = sources.length ? `\n\n### Sources\n${sources.map((url) => `- ${url}`).join("\n")}` : "";
    const result = await writeSection(env, args, "Research", `${String(args.text).trim()}${block}`);
    return "error" in result ? result : { ...result, sources };
  },
  write_conference_doc: async (args, env) => {
    const slug = slugOf(env, args);
    if (!(await conferenceStatus(env.ctx, slug))) return noConference(slug);
    const result = await putConfDoc(env.ctx, slug, args.name, { text: args.text });
    if (!result || "conflict" in result) return { error: `Could not write ${args.name} for ${slug}` };
    let synced = 0;
    if (args.name === "DEBRIEF.md" && args.sync_debrief_actions !== false) {
      synced = (await syncDebriefActionsToInbox(env.ctx, slug))?.added || 0;
    }
    return { ok: true, slug, name: args.name, synced_actions: synced };
  },
  add_conference: async (args, env) => {
    let agenda: unknown;
    try {
      agenda = JSON.parse(args.agenda_json);
    } catch (error) {
      return { error: `Invalid JSON: ${error instanceof Error ? error.message : error}` };
    }
    const result = await addConference(env.ctx, agenda);
    if (!("slug" in result)) return { ok: false, errors: result.errors, warnings: result.warnings };
    const name = (agenda as { conference?: { name?: string } }).conference?.name || "";
    return { ok: true, slug: result.slug, name, created: result.created, skipped: result.skipped, warnings: result.warnings, workspaceId: result.workspaceId };
  },
  import_conference_from_url: async (args, env) => env.importFromUrl(args.url),
  prepare_event_brief: async (args, env) => {
    const slug = slugOf(env, args);
    if (!(await conferenceStatus(env.ctx, slug))) return noConference(slug);
    env.deferred.briefSlug = slug;
    return { ok: true, slug, status: "queued: written after this reply" };
  },
  save_artifact: async (args, env) => {
    const slug = String(args.slug || "").trim();
    if (!(await saveArtifact(env.ctx, args.name, args.content, slug))) {
      return { error: "Rejected: invalid name (letters/digits/._-) or unknown conference." };
    }
    return { ok: true, name: args.name, slug };
  },
  move_artifact: async (args, env) => {
    const error = await moveArtifact(env.ctx, args.name, String(args.slug).trim());
    return error ? { error } : { ok: true, name: args.name, slug: args.slug };
  },
  draw_conference_board: async (args, env) => {
    const slug = slugOf(env, args);
    if (!slug) return noConference(slug);
    return drawConferenceBoard(env.ctx, slug, { day: args.day, themes: args.themes });
  },
  draw_mind_map: async (args, env) => {
    const slug = slugOf(env, args);
    if (!slug) return noConference(slug);
    const file = String(args.file || "").trim() || undefined;
    return drawMindMap(env.ctx, slug, { day: args.day, file, branches: args.branches });
  },
};

/** The spec tools this host serves: everything not in the spec's not_on list for "hosted". */
export const SERVED = TOOL_SPECS.map((entry) => entry.name).filter((name) => !NOT_ON.has(name));

/** Runs one tool by name with spec-checked arguments; never throws. */
export async function callTool(name: string, args: unknown, env: ToolEnv): Promise<ToolResult> {
  let clean: Args;
  try {
    clean = checkArgs(toolSpec(name).input_schema, args);
  } catch (error) {
    return { error: `Invalid arguments: ${error instanceof Error ? error.message : error}` };
  }
  try {
    return await HANDLERS[name](clean, env);
  } catch (error) {
    return { error: `${name} failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * The model-facing tools: the spec's name, purpose and input_schema with this host's handler. The canvas tools
 * are only offered where the canvas drawer ships (the spec's "conditional" entries).
 */
export function conciergeTools(env: ToolEnv, options: { canvas: boolean }): ToolSet {
  const tools: ToolSet = {};
  for (const name of SERVED) {
    if (CANVAS_TOOLS.has(name) && !options.canvas) continue;
    const entry = toolSpec(name);
    tools[name] = tool({
      description: entry.purpose,
      inputSchema: jsonSchema<Args>(entry.input_schema as Parameters<typeof jsonSchema>[0], {
        validate: (value) => {
          try {
            return { success: true, value: checkArgs(entry.input_schema, value) };
          } catch (error) {
            return { success: false, error: error instanceof Error ? error : new Error(String(error)) };
          }
        },
      }),
      execute: async (input: Args) => callTool(name, input, env),
    });
  }
  return tools;
}
