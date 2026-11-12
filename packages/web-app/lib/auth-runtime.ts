import { PostgresNoteCoordinator } from "./postgres-notes.js";
import { PostgresChatThreads } from "./chat-threads.js";
import postgres from "postgres";
import { WorkOSAuthProvider, resolvePrincipal, type AuthProvider, type Principal } from "../../auth/src/index.js";
import { PostgresIdentityRepository, type Database } from "../../auth/src/repository.js";
import { workosDriver } from "./workos-driver.js";
import { publicOrigin } from "./public-origin.js";
import { applyMigrations, databaseUrl, migrationGate } from "./database.js";

let repository: PostgresIdentityRepository | undefined;
let noteRepository: PostgresNoteCoordinator | undefined;
let chatThreads: PostgresChatThreads | undefined;
let database: Database | undefined;
// `ready` runs before the first query or transaction (the migrations, see database.ts); a transaction's inner
// adapter is already past it.
export function databaseAdapter(sql: postgres.Sql, ready: () => Promise<void> = async () => {}): Database {
  return {
    async query<T extends Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
      await ready();
      return await sql.unsafe(text, values as postgres.ParameterOrJSON<never>[]) as unknown as T[];
    },
    async transaction<T>(run: (db: Database) => Promise<T>): Promise<T> {
      await ready();
      return await sql.begin(async (transaction) => run(databaseAdapter(transaction as unknown as postgres.Sql))) as T;
    },
  };
}
// One pool per process for identity and notes; the auth migrations apply on its first use.
function migratedDatabase(): Database | undefined {
  if (database) return database;
  const url = databaseUrl();
  if (!url) return undefined;
  const sql = postgres(url, { max: 5, idle_timeout: 20, connect_timeout: 5 });
  database = databaseAdapter(sql, migrationGate(() => applyMigrations(sql)));
  return database;
}
export function identityRepository(): PostgresIdentityRepository | undefined {
  if (repository) return repository;
  const db = migratedDatabase();
  if (!db) return undefined;
  repository = new PostgresIdentityRepository(db);
  return repository;
}
export function authProvider(): AuthProvider | undefined {
  const origin = publicOrigin();
  const apiKey = process.env.WORKOS_API_KEY; const clientId = process.env.WORKOS_CLIENT_ID; const cookiePassword = process.env.WORKOS_COOKIE_PASSWORD;
  if (!origin || !apiKey || !clientId || !cookiePassword) return undefined;
  if (cookiePassword.length < 32) throw new Error("WORKOS_COOKIE_PASSWORD must be at least 32 characters");
  return new WorkOSAuthProvider(workosDriver({ apiKey, clientId, cookiePassword, origin, webhookSecret: process.env.WORKOS_WEBHOOK_SECRET }));
}
export async function authenticatedPrincipal(provider: AuthProvider | undefined, request: Request): Promise<Principal | null> {
  const repo = identityRepository();
  if (!provider || !repo) return null;
  return resolvePrincipal(provider, repo, request);
}

export function noteCoordinator(): PostgresNoteCoordinator | undefined {
  if (noteRepository) return noteRepository;
  const db = migratedDatabase();
  if (!db) return undefined;
  noteRepository = new PostgresNoteCoordinator(db);
  return noteRepository;
}

// Concierge chat threads for signed-in web users (see chat-threads.ts); undefined without a database.
export function chatThreadStore(): PostgresChatThreads | undefined {
  if (chatThreads) return chatThreads;
  const db = migratedDatabase();
  if (!db) return undefined;
  chatThreads = new PostgresChatThreads(db);
  return chatThreads;
}
