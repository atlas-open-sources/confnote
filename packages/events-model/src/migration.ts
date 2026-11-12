import { localDay } from "./time.js";
/** Non-destructive migration: markdown and attachments keep their original paths. */
import { readFile, open, rename, lstat } from "node:fs/promises";
import { join } from "node:path";
export interface LegacySession {
  id: string; title?: string; start: string; end: string;
  session_id?: string; day?: string; note_file?: string;
  [key: string]: unknown;
}
export interface LegacyAgenda {
  schema_version?: string;
  conference: {name: string; date: string; start_date?: string; end_date?: string; [key: string]: unknown};
  events: LegacySession[];
  [key: string]: unknown;
}
const ID = /^[a-z0-9][a-z0-9_-]*$/;
const NOTE = /^(?:\d{4}-|session-)[a-z0-9][a-z0-9_-]*\.md$/;
export function migrateAgenda(source: LegacyAgenda): LegacyAgenda {
  const data = structuredClone(source);
  if (![undefined,"1.0","confnote.agenda.v1","confnote.agenda.v2"].includes(data.schema_version)) throw new Error("unsupported agenda version");
  if (!data.conference?.name || !/^\d{4}-\d{2}-\d{2}$/.test(data.conference.date)) throw new Error("conference name and date required");
  const ids = new Set<string>();
  const files = new Set<string>();
  data.events ??= [];
  for (const event of data.events) {
    if (!ID.test(event.id) || ids.has(event.id)) throw new Error("unsafe or duplicate session id");
    ids.add(event.id);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(event.start)) throw new Error("session needs a dated start");
    const filename = event.note_file ?? `${event.start.slice(11,13)}${event.start.slice(14,16)}-${event.id}.md`;
    if (!NOTE.test(filename) || files.has(filename)) throw new Error("unsafe or duplicate note path");
    files.add(filename);
    event.session_id = event.id;
    event.day = localDay(event.start, data.conference.timezone as string | undefined);
    event.note_file = filename;
  }
  data.conference.start_date ||= data.conference.date;
  data.conference.end_date = [data.conference.date, data.conference.end_date ?? data.conference.date,...data.events.map(event => localDay(event.end, data.conference.timezone as string | undefined))].sort().at(-1)!;
  data.schema_version = "confnote.agenda.v2";
  return data;
}
async function rejectSymlink(path: string): Promise<void> {
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error("symlink vault is not supported"); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
}
export async function migrateVault(directory: string): Promise<LegacyAgenda> {
  const path = join(directory,"agenda.json");
  await rejectSymlink(directory);
  await rejectSymlink(path);
  await rejectSymlink(join(directory,"notes"));
  const data = migrateAgenda(JSON.parse(await readFile(path,"utf8")));
  for (const event of data.events) await rejectSymlink(join(directory,"notes",event.note_file!));
  const temporary = join(directory,".agenda-v2.tmp");
  const file = await open(temporary,"wx");
  try { await file.writeFile(JSON.stringify(data,null,2)+"\n"); await file.sync(); } finally { await file.close(); }
  await rename(temporary,path);
  return data;
}
