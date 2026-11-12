import readline from "node:readline";
import postgres from "postgres";
import { databaseAdapter } from "../../lib/auth-runtime.js";
import { PostgresNoteCoordinator } from "../../lib/postgres-notes.js";
import { createStorage, type StorageAdapter } from "../../lib/storage.js";
import { notePayload, putNote } from "../../lib/service.js";
import type { RequestContext } from "../../lib/types.js";
const [mode, workspace, label] = process.argv.slice(2);
const sql = postgres(process.env.CONFNOTE_TEST_DATABASE_URL || "", { max: 1 });
const storage = createStorage();
let armed = false;
const lines = readline.createInterface({ input: process.stdin });
const pending: Array<(line: string) => void> = []; const queue: string[] = [];
lines.on("line", (line) => { const next = pending.shift(); if (next) next(line); else queue.push(line); });
function command(): Promise<string> { return queue.length ? Promise.resolve(queue.shift() || "") : new Promise((resolve) => pending.push(resolve)); }
function send(value: unknown): void { process.stdout.write(JSON.stringify(value) + "\n"); }
const intercepted: StorageAdapter = {
  async readText(key) {
    const result = await storage.readText(key);
    if (armed && key.endsWith("session-talk.md")) { armed = false; send({ read: true }); await command(); }
    return result;
  },
  readBytes: (key) => storage.readBytes(key), writeBytes: (key, bytes, type) => storage.writeBytes(key, bytes, type),
  writeText: (key, text) => storage.writeText(key, text), list: (prefix) => storage.list(prefix),
};
const ctx: RequestContext = { workspace, storage: intercepted, notes: mode === "green" ? new PostgresNoteCoordinator(databaseAdapter(sql)) : undefined };
try {
  const note = await notePayload(ctx, "2099-01-01-fixture", "session-talk.md");
  send({ ready: true, revision: note?.mtime }); await command(); armed = true;
  const result = await putNote(ctx, "2099-01-01-fixture", "session-talk.md", { mtime: note?.mtime, sections: { "Human notes": label } });
  send({ result });
} catch (error) { send({ error: error instanceof Error ? error.message : "worker failure" }); process.exitCode = 1; }
finally { lines.close(); await sql.end(); }
