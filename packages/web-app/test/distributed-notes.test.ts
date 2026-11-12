import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { expect, it } from "vitest";
const databaseUrl = process.env.CONFNOTE_TEST_DATABASE_URL;
interface Message { ready?: boolean; read?: boolean; revision?: number; result?: { ok?: boolean; conflict?: boolean }; error?: string }
function worker(root: string, mode: string, workspace: string, label: string) {
  const proc = spawn(process.execPath, ["--import", "tsx", "test/fixtures/distributed-note-worker.ts", mode, workspace, label], { cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, CONFNOTE_STORAGE: "fs", CONFNOTE_WEB_DATA_DIR: root }, stdio: ["pipe", "pipe", "pipe"] });
  const pending: Array<(message: Message) => void> = []; const queue: Message[] = [];
  const lines = readline.createInterface({ input: proc.stdout });
  lines.on("line", (line) => { const message = JSON.parse(line) as Message; const next = pending.shift(); if (next) next(message); else queue.push(message); });
  const done = new Promise<number | null>((resolve) => proc.once("close", resolve));
  let errors = ""; proc.stderr.on("data", (chunk) => { errors += String(chunk); });
  return { proc, done, message: (): Promise<Message> => queue.length ? Promise.resolve(queue.shift() || {}) : new Promise((resolve) => pending.push(resolve)), send: () => proc.stdin.write("continue\n"), errors: () => errors };
}
it.skipIf(!databaseUrl)("separate instances reject stale notes using shared PostgreSQL revisions; deterministic uncoordinated red control loses a write", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "confnote-distributed-"));
  const sql = postgres(databaseUrl || "", { max: 2 });
  const processes: ChildProcessWithoutNullStreams[] = [];
  try {
    await sql.unsafe(await fs.readFile(path.resolve(import.meta.dirname, "../../auth/migrations/002_note_revisions.sql"), "utf8"));
    for (const mode of ["red", "green"]) {
      const workspace = randomUUID(); const dir = path.join(root, workspace, "2099-01-01-fixture", "notes");
      await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, "session-talk.md"), "# Talk\n\n## Human notes\n\nOriginal\n");
      const a = worker(root, mode, workspace, "Writer A"); const b = worker(root, mode, workspace, "Writer B"); processes.push(a.proc, b.proc);
      const ready = await Promise.all([a.message(), b.message()]); expect(ready.every((item) => item.ready)).toBe(true); expect(ready[0].revision).toBe(ready[1].revision);
      a.send(); expect(await a.message()).toMatchObject({ read: true });
      b.send();
      if (mode === "red") { expect(await b.message()).toMatchObject({ read: true }); a.send(); const first = await a.message(); b.send(); const second = await b.message(); expect(first.result?.ok).toBe(true); expect(second.result?.ok).toBe(true); }
      else { a.send(); const first = await a.message(); expect(await b.message()).toMatchObject({ read: true }); b.send(); const second = await b.message(); expect(first.result?.ok).toBe(true); expect(second.result?.conflict).toBe(true); expect(await fs.readFile(path.join(dir, "session-talk.md"), "utf8")).toContain("Writer A"); }
      expect(await a.done).toBe(0); expect(await b.done).toBe(0);
      if (a.errors() || b.errors()) console.warn(a.errors() + b.errors());
      if (mode === "green") {
        await fs.writeFile(path.join(dir, "session-talk.md"), "# Talk\n\n## Human notes\n\nRecovered storage write\n");
        const recovery = worker(root, mode, workspace, "Writer C"); processes.push(recovery.proc);
        expect((await recovery.message()).revision).toBe(3);
        recovery.send(); expect(await recovery.message()).toMatchObject({ read: true }); recovery.send();
        expect((await recovery.message()).result?.ok).toBe(true); expect(await recovery.done).toBe(0);
      }
      await sql`DELETE FROM confnote_note_revisions WHERE note_key LIKE ${`${workspace}/%`}`;
    }
  } finally { for (const proc of processes) proc.kill(); await sql.end(); await fs.rm(root, { recursive: true, force: true }); }
}, 30000);
