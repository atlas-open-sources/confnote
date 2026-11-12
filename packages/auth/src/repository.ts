import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthProviderId, IdentityRepository, Principal, ProviderSession, WorkspaceRole } from "./index.js";
export interface Database {
  query<T extends Record<string, unknown>>(text: string, values?: unknown[]): Promise<T[]>;
  transaction<T>(run: (database: Database) => Promise<T>): Promise<T>;
}
export interface Workspace { id: string; name: string; eventId: string | null; role: WorkspaceRole }
export class WorkspaceLimitError extends Error { constructor() { super("The free plan includes two workspaces. Upgrade to Pro to add another."); } }

export class PostgresIdentityRepository implements IdentityRepository {
  constructor(private readonly database: Database) {}
  async resolve(session: ProviderSession, requestedWorkspace?: string): Promise<Principal | null> {
    return this.database.transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${session.provider}:${session.externalUserId}`]);
      const revoked = await db.query("SELECT session_id FROM confnote_revoked_sessions WHERE provider=$1 AND session_id=$2", [session.provider, session.sessionId]);
      if (revoked.length) return null;
      let users = await db.query<{ id: string; disabled: boolean }>("SELECT u.id,u.disabled FROM confnote_users u JOIN confnote_auth_identities i ON i.user_id=u.id WHERE i.provider=$1 AND i.external_user_id=$2", [session.provider, session.externalUserId]);
      if (!users.length) {
        const id = randomUUID();
        await db.query("INSERT INTO confnote_users(id,email) VALUES($1,$2)", [id, session.email]);
        await db.query("INSERT INTO confnote_auth_identities(provider,external_user_id,user_id) VALUES($1,$2,$3)", [session.provider, session.externalUserId, id]);
        await db.query("INSERT INTO confnote_workspaces(id,name,owner_id) VALUES($1,'Personal notebook',$1)", [id]);
        await db.query("INSERT INTO confnote_memberships(workspace_id,user_id,role) VALUES($1,$1,'owner')", [id]);
        users = [{ id, disabled: false }];
      }
      const user = users[0]; if (user.disabled) return null;
      let workspace = requestedWorkspace || user.id;
      if (!requestedWorkspace && session.externalOrgId) {
        const mapped = await db.query<{ id: string }>("SELECT id FROM confnote_workspaces WHERE external_provider=$1 AND external_org_id=$2", [session.provider, session.externalOrgId]);
        if (mapped.length) workspace = mapped[0].id;
      }
      const membership = await db.query<{ role: WorkspaceRole }>("SELECT role FROM confnote_memberships WHERE workspace_id::text=$1 AND user_id=$2", [workspace, user.id]);
      if (!membership.length) return null;
      return { userId: user.id, email: session.email, emailVerified: session.emailVerified, workspaceId: workspace, role: membership[0].role, authMethod: session.authMethod, sessionId: session.sessionId };
    });
  }
  async plan(userId: string): Promise<"free" | "pro"> {
    const rows = await this.database.query<{ plan: string }>("SELECT plan FROM confnote_entitlements WHERE user_id=$1 AND (valid_until IS NULL OR valid_until>now())", [userId]);
    return rows[0]?.plan === "pro" ? "pro" : "free";
  }
  async workspaces(userId: string): Promise<Workspace[]> {
    const rows = await this.database.query<{ id: string; name: string; event_id: string | null; role: WorkspaceRole }>("SELECT w.id,w.name,w.event_id,m.role FROM confnote_workspaces w JOIN confnote_memberships m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY w.name", [userId]);
    return rows.map((row) => ({ id: row.id, name: row.name, eventId: row.event_id, role: row.role }));
  }
  async eventWorkspace(userId: string, eventId: string, name: string): Promise<Workspace> {
    return this.database.transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [userId]);
      const existing = await db.query<{ id: string; name: string }>("SELECT id,name FROM confnote_workspaces WHERE owner_id=$1 AND event_id=$2", [userId, eventId]);
      if (existing.length) return { ...existing[0], eventId, role: "owner" };
      const plans = await db.query<{ plan: string }>("SELECT plan FROM confnote_entitlements WHERE user_id=$1 AND (valid_until IS NULL OR valid_until>now())", [userId]);
      const count = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM confnote_workspaces WHERE owner_id=$1 AND event_id IS NOT NULL", [userId]);
      if (plans[0]?.plan !== "pro" && Number(count[0].count) >= 2) throw new WorkspaceLimitError();
      const id = randomUUID();
      await db.query("INSERT INTO confnote_workspaces(id,name,owner_id,event_id) VALUES($1,$2,$3,$4)", [id, name, userId, eventId]);
      await db.query("INSERT INTO confnote_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')", [id, userId]);
      return { id, name, eventId, role: "owner" };
    });
  }
  async tracking(userId: string): Promise<Record<string, string>> {
    const rows = await this.database.query<{ event_id: string; status: string }>("SELECT event_id,status FROM confnote_tracking WHERE user_id=$1", [userId]);
    return Object.fromEntries(rows.map((row) => [row.event_id, row.status]));
  }
  async track(userId: string, eventId: string, status: string | null): Promise<void> {
    if (status === null) { await this.database.query("DELETE FROM confnote_tracking WHERE user_id=$1 AND event_id=$2", [userId, eventId]); return; }
    if (!["interested", "going", "attended"].includes(status)) throw new Error("Invalid tracking status");
    await this.database.query("INSERT INTO confnote_tracking(user_id,event_id,status) VALUES($1,$2,$3) ON CONFLICT(user_id,event_id) DO UPDATE SET status=excluded.status", [userId, eventId, status]);
  }
  async rateLimit(bucket: string, limit: number, seconds: number): Promise<boolean> {
    const rows = await this.database.query("INSERT INTO confnote_rate_limits(bucket,count,resets_at) VALUES($1,1,now()+($3*interval '1 second')) ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN confnote_rate_limits.resets_at<=now() THEN 1 ELSE confnote_rate_limits.count+1 END,resets_at=CASE WHEN confnote_rate_limits.resets_at<=now() THEN excluded.resets_at ELSE confnote_rate_limits.resets_at END WHERE confnote_rate_limits.resets_at<=now() OR confnote_rate_limits.count<$2 RETURNING count", [bucket, limit, seconds]);
    return rows.length > 0;
  }
  async ingest(provider: AuthProviderId, event: AuthEvent): Promise<void> {
    await this.database.transaction(async (db) => {
      const added = await db.query("INSERT INTO confnote_auth_events(provider,event_id,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id", [provider, event.id, JSON.stringify(event)]);
      if (!added.length) return;
      if (event.type === "user.deleted") await db.query("UPDATE confnote_users SET disabled=true WHERE id IN(SELECT user_id FROM confnote_auth_identities WHERE provider=$1 AND external_user_id=$2)", [provider, event.externalUserId]);
      if (event.type === "user.upserted") await db.query("UPDATE confnote_users SET email=$3 WHERE id IN(SELECT user_id FROM confnote_auth_identities WHERE provider=$1 AND external_user_id=$2)", [provider, event.externalUserId, event.email]);
      if (event.type === "session.revoked") await db.query("INSERT INTO confnote_revoked_sessions(provider,session_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [provider, event.sessionId]);
      if (event.type === "membership.deleted") await db.query("DELETE FROM confnote_memberships WHERE workspace_id IN(SELECT id FROM confnote_workspaces WHERE external_provider=$1 AND external_org_id=$2) AND user_id IN(SELECT user_id FROM confnote_auth_identities WHERE provider=$1 AND external_user_id=$3)", [provider, event.externalOrgId, event.externalUserId]);
      // New memberships/role changes are inboxed for the application's explicit role mapping.
      // An identity-provider role must never grant application authority by itself.
    });
  }
}
