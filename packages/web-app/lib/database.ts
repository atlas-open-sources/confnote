import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import postgres from "postgres";

// The Vercel Neon integration (prefix CONFNOTE_DATABASE) names its variable CONFNOTE_DATABASE_DATABASE_URL and marks
// it sensitive, so nobody can copy it by hand; an explicit CONFNOTE_DATABASE_URL still wins.
export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.CONFNOTE_DATABASE_URL || env.CONFNOTE_DATABASE_DATABASE_URL || undefined;
}

export interface Migration { name: string; url: URL }
// Literal URLs so Vercel's file tracer bundles every migration with the function. A test keeps this list equal to
// packages/auth/migrations.
export const AUTH_MIGRATIONS: Migration[] = [
  { name: "001_identity.sql", url: new URL("../../auth/migrations/001_identity.sql", import.meta.url) },
  { name: "002_note_revisions.sql", url: new URL("../../auth/migrations/002_note_revisions.sql", import.meta.url) },
  { name: "003_chat_threads.sql", url: new URL("../../auth/migrations/003_chat_threads.sql", import.meta.url) },
];

// pg_advisory_xact_lock key ("cnf1"). A transaction-scoped lock also holds behind Neon's transaction pooler.
const MIGRATION_LOCK_KEY = 0x636e6631;
const DESTRUCTIVE_SQL = [/\bdrop\b/i, /\balter\b/i, /\btruncate\b/i, /\bdelete\s+from\b/i, /\bupdate\s+\S+\s+set\b/i];

export class DatabaseUnavailableError extends Error {
  constructor() { super("The database is not ready."); }
}

function withoutComments(text: string): string {
  return text.replace(/--[^\n]*/g, "");
}

export function assertAdditive(name: string, text: string): void {
  const statement = DESTRUCTIVE_SQL.find((pattern) => pattern.test(withoutComments(text)));
  if (statement) throw new Error(`migration ${name} is not additive (${statement.source}); apply it by hand`);
}

// Applies the migrations not yet recorded in confnote_schema_migrations, all in one transaction under an advisory
// lock, so concurrent cold starts apply each file once. Returns the names applied by this call.
export async function applyMigrations(sql: postgres.Sql, migrations: Migration[] = AUTH_MIGRATIONS): Promise<string[]> {
  const files = await Promise.all(migrations.map(async (migration) => ({ name: migration.name, text: await fs.readFile(migration.url, "utf8") })));
  for (const file of files) assertAdditive(file.name, file.text);
  return await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`;
    await tx.unsafe("CREATE TABLE IF NOT EXISTS confnote_schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
    const recorded = new Set((await tx<{ name: string }[]>`select name from confnote_schema_migrations`).map((row) => row.name));
    const applied: string[] = [];
    for (const file of files) {
      if (recorded.has(file.name)) continue;
      await tx.unsafe(file.text).simple();
      await tx`insert into confnote_schema_migrations (name, sha256) values (${file.name}, ${createHash("sha256").update(file.text).digest("hex")})`;
      applied.push(file.name);
    }
    return applied;
  }) as string[];
}

// One readiness promise per process (cold start). A failure is logged and cleared so the next request retries;
// until the migrations apply, every database use throws DatabaseUnavailableError (the API answers 503).
export function migrationGate(migrate: () => Promise<string[]>, log: Pick<Console, "info" | "error"> = console): () => Promise<void> {
  let ready: Promise<void> | undefined;
  return function databaseReady(): Promise<void> {
    ready ??= migrate().then((applied) => {
      if (applied.length) log.info(`confnote database: applied migrations ${applied.join(", ")}`);
    }, (error: unknown) => {
      ready = undefined;
      log.error(`confnote database: migrations failed, database requests answer 503 until they apply: ${error instanceof Error ? error.message : String(error)}`);
      throw new DatabaseUnavailableError();
    });
    return ready;
  };
}
