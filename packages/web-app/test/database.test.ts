import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { AUTH_MIGRATIONS, DatabaseUnavailableError, applyMigrations, assertAdditive, databaseUrl, migrationGate } from "../lib/database.js";

const adminUrl = process.env.CONFNOTE_TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../../auth/migrations");
const CONCURRENT_COLD_STARTS = 4;
const ALL_MIGRATIONS = ["001_identity.sql", "002_note_revisions.sql", "003_chat_threads.sql"];

describe("databaseUrl", () => {
  it("prefers CONFNOTE_DATABASE_URL, falls back to the Neon integration's CONFNOTE_DATABASE_DATABASE_URL", () => {
    expect(databaseUrl({ CONFNOTE_DATABASE_URL: "postgres://explicit", CONFNOTE_DATABASE_DATABASE_URL: "postgres://neon" })).toBe("postgres://explicit");
    expect(databaseUrl({ CONFNOTE_DATABASE_DATABASE_URL: "postgres://neon" })).toBe("postgres://neon");
    expect(databaseUrl({ CONFNOTE_DATABASE_URL: "", CONFNOTE_DATABASE_DATABASE_URL: "postgres://neon" })).toBe("postgres://neon");
    expect(databaseUrl({})).toBeUndefined();
  });
});

describe("auth migrations", () => {
  it("lists every file in packages/auth/migrations, in order, each additive", async () => {
    const files = (await fs.readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
    expect(AUTH_MIGRATIONS.map((migration) => migration.name)).toEqual(files);
    for (const migration of AUTH_MIGRATIONS) {
      expect(fileURLToPath(migration.url)).toBe(path.join(migrationsDir, migration.name));
      assertAdditive(migration.name, await fs.readFile(migration.url, "utf8"));
    }
  });
  it("refuses destructive statements but not words in comments", () => {
    expect(() => assertAdditive("x.sql", "DROP TABLE confnote_users;")).toThrow(/not additive/);
    expect(() => assertAdditive("x.sql", "ALTER TABLE confnote_users ADD COLUMN x int;")).toThrow(/not additive/);
    expect(() => assertAdditive("x.sql", "delete from confnote_users;")).toThrow(/not additive/);
    expect(() => assertAdditive("x.sql", "-- never drop this\nCREATE TABLE IF NOT EXISTS t (id int);")).not.toThrow();
  });
});

describe("migrationGate", () => {
  it("migrates once per process, and after a failure logs, fails closed and retries on the next use", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const migrate = vi.fn().mockRejectedValueOnce(new Error("connection refused")).mockResolvedValue(["001_identity.sql"]);
    const ready = migrationGate(migrate, log);
    await expect(ready()).rejects.toBeInstanceOf(DatabaseUnavailableError);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("migrations failed, database requests answer 503 until they apply: connection refused"));
    await ready(); await ready();
    expect(migrate).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith("confnote database: applied migrations 001_identity.sql");
  });
});

// Each run makes its own database on the test server and drops it afterwards.
async function withFreshDatabase(run: (url: string) => Promise<void>): Promise<void> {
  const admin = postgres(adminUrl || "", { max: 1, onnotice: () => {} });
  const name = `confnote_migrations_${randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl || ""); url.pathname = `/${name}`;
  try { await run(url.toString()); } finally { await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); }
}
async function confnoteTables(sql: postgres.Sql): Promise<string[]> {
  return (await sql<{ table_name: string }[]>`select table_name from information_schema.tables where table_schema = 'public' and table_name like 'confnote_%' order by 1`).map((row) => row.table_name);
}
// A separate node process stands in for a separate function instance's cold start.
function coldStart(url: string): Promise<string[]> {
  const script = `import postgres from "postgres"; import { applyMigrations } from "./lib/database.ts";
const sql = postgres(process.env.MIGRATE_URL, { max: 1, onnotice: () => {} });
try { console.log(JSON.stringify(await applyMigrations(sql))); } finally { await sql.end(); }`;
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, MIGRATE_URL: url } });
    let out = ""; let errors = "";
    proc.stdout.on("data", (chunk) => { out += String(chunk); }); proc.stderr.on("data", (chunk) => { errors += String(chunk); });
    proc.once("close", (code) => code === 0 ? resolve(JSON.parse(out.trim().split("\n").at(-1) || "[]")) : reject(new Error(`cold start exited ${code}: ${errors}`)));
  });
}

describe.skipIf(!adminUrl)("applyMigrations against PostgreSQL", () => {
  it("creates the schema on a fresh database and records each file", async () => {
    await withFreshDatabase(async (url) => {
      const sql = postgres(url, { max: 2, onnotice: () => {} });
      try {
        expect(await applyMigrations(sql)).toEqual(ALL_MIGRATIONS);
        expect(await confnoteTables(sql)).toContain("confnote_users");
        expect(await confnoteTables(sql)).toContain("confnote_note_revisions");
        expect((await sql`select name from confnote_schema_migrations order by name`).map((row) => row.name)).toEqual(ALL_MIGRATIONS);
        expect(await applyMigrations(sql)).toEqual([]);
      } finally { await sql.end(); }
    });
  });
  it("adopts a database migrated by hand (tables there, no record) without touching its rows", async () => {
    await withFreshDatabase(async (url) => {
      const sql = postgres(url, { max: 2, onnotice: () => {} });
      try {
        for (const migration of AUTH_MIGRATIONS) await sql.unsafe(await fs.readFile(migration.url, "utf8")).simple();
        await sql`insert into confnote_users (id, email) values (${randomUUID()}, 'kept@example.test')`;
        expect(await applyMigrations(sql)).toEqual(ALL_MIGRATIONS);
        expect((await sql`select email from confnote_users`).map((row) => row.email)).toEqual(["kept@example.test"]);
      } finally { await sql.end(); }
    });
  });
  it("applies each file once when cold starts race (advisory lock)", async () => {
    await withFreshDatabase(async (url) => {
      const results = await Promise.all(Array.from({ length: CONCURRENT_COLD_STARTS }, () => coldStart(url)));
      expect(results.flat().sort()).toEqual(ALL_MIGRATIONS);
      const sql = postgres(url, { max: 1, onnotice: () => {} });
      try { expect((await sql`select count(*)::int as n from confnote_schema_migrations`)[0].n).toBe(ALL_MIGRATIONS.length); } finally { await sql.end(); }
    });
  }, 30_000);
});
