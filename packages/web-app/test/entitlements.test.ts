import { expect, it } from "vitest";
import { PostgresIdentityRepository, WorkspaceLimitError, type Database } from "../../auth/src/repository.js";
it("locks creation before enforcing free two workspaces; Pro removes the count cap", async () => {
  const calls: string[] = [];
  let pro = false;
  const db: Database = {
    transaction: async (run) => run(db),
    query: async <T extends Record<string, unknown>>(sql: string): Promise<T[]> => {
      calls.push(sql);
      if (sql.includes("SELECT plan")) return (pro ? [{ plan: "pro" }] : []) as unknown as T[];
      if (sql.includes("SELECT count")) return [{ count: "2" }] as unknown as T[];
      return [];
    },
  };
  const repository = new PostgresIdentityRepository(db);
  await expect(repository.eventWorkspace("user", "third", "Third")).rejects.toBeInstanceOf(WorkspaceLimitError);
  expect(calls[0]).toContain("pg_advisory_xact_lock");
  expect(calls.some((sql) => sql.startsWith("INSERT"))).toBe(false);
  pro = true;
  expect(await repository.eventWorkspace("user", "third", "Third")).toMatchObject({ name: "Third", role: "owner" });
});
it("provider admin claims cannot bypass application membership", async () => {
  const db: Database = { transaction: async (run) => run(db), query: async <T extends Record<string, unknown>>(sql: string): Promise<T[]> => sql.includes("SELECT u.id") ? [{ id: "internal", disabled: false }] as unknown as T[] : [] };
  expect(await new PostgresIdentityRepository(db).resolve({ provider: "workos", externalUserId: "vendor", externalOrgId: null, providerRoles: ["admin"], permissions: ["all"], email: "fixture@example.test", emailVerified: true, sessionId: "session", expiresAt: new Date(Date.now() + 10000), authMethod: "email_code" }, "victim")).toBeNull();
});
it("an unmapped provider organization falls back to the owned personal notebook", async () => {
  const db: Database = { transaction: async (run) => run(db), query: async <T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<T[]> => {
    if (sql.includes("SELECT u.id")) return [{ id: "internal", disabled: false }] as unknown as T[];
    if (sql.includes("SELECT role") && values?.[0] === "internal") return [{ role: "owner" }] as unknown as T[];
    return [];
  } };
  const principal = await new PostgresIdentityRepository(db).resolve({ provider: "workos", externalUserId: "vendor", externalOrgId: "unmapped-org", providerRoles: ["admin"], permissions: [], email: "fixture@example.test", emailVerified: true, sessionId: "session", expiresAt: new Date(Date.now() + 10000), authMethod: "email_code" });
  expect(principal?.workspaceId).toBe("internal"); expect(principal?.role).toBe("owner");
});
