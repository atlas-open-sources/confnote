import { randomUUID } from "node:crypto";
import type { Database } from "../../auth/src/repository.js";

// Concierge chat history on the web, the same contract as the Mac app (packages/local-app/server.py
// list_chat_threads / archive_current_chat / resume_chat / read_chat_history): one active thread per person per
// workspace, "+ new" archives it, "resume" swaps an archived thread back in. The owner always comes from the signed-in
// session, never from the request.

export interface ChatOwner { workspaceId: string; userId: string }
export type ChatRole = "user" | "assistant";
export interface ChatTurn { ts: string; role: ChatRole; text: string; scope: string }
export interface ChatThreadMeta { id: string; ts: string; title: string; turns: number; scope: string }
export interface ChatThreadList { active: ChatThreadMeta | null; archived: ChatThreadMeta[] }

export interface ChatThreadStore {
  append(owner: ChatOwner, role: ChatRole, text: string, scope: string): Promise<void>;
  history(owner: ChatOwner, limit?: number): Promise<ChatTurn[]>;
  list(owner: ChatOwner): Promise<ChatThreadList>;
  archive(owner: ChatOwner): Promise<ChatThreadMeta | null>;
  resume(owner: ChatOwner, threadId: string): Promise<ChatThreadMeta | null>;
}

const TITLE_CHARS = 64;
const MAX_TEXT_CHARS = 32_000;
const MAX_ARCHIVED_LISTED = 100;
export const MAX_HISTORY_TURNS = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stamp(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function lockKey(owner: ChatOwner): string {
  return `chat:${owner.workspaceId}:${owner.userId}`;
}

interface MetaRow extends Record<string, unknown> {
  id: string;
  created_at: Date | string;
  archived_at: Date | string | null;
  turns: string;
  title: string | null;
  scope: string | null;
}

function meta(row: MetaRow): ChatThreadMeta {
  const firstLine = (row.title || "").trim().split("\n")[0] || "";
  return {
    id: row.id,
    ts: stamp(row.archived_at || row.created_at),
    title: firstLine.slice(0, TITLE_CHARS) || "(empty thread)",
    turns: Number(row.turns),
    scope: row.scope || "",
  };
}

const META_SELECT = `SELECT t.id, t.created_at, t.archived_at,
  (SELECT count(*)::text FROM confnote_chat_messages m WHERE m.thread_id = t.id) AS turns,
  (SELECT m.text FROM confnote_chat_messages m WHERE m.thread_id = t.id AND m.role = 'user' ORDER BY m.id LIMIT 1) AS title,
  (SELECT m.scope FROM confnote_chat_messages m WHERE m.thread_id = t.id AND m.scope <> '' ORDER BY m.id DESC LIMIT 1) AS scope
  FROM confnote_chat_threads t`;

export class PostgresChatThreads implements ChatThreadStore {
  constructor(private readonly database: Database) {}

  async append(owner: ChatOwner, role: ChatRole, text: string, scope: string): Promise<void> {
    const body = (text || "").trim().slice(0, MAX_TEXT_CHARS);
    if (!body || (role !== "user" && role !== "assistant")) return;
    await this.database.transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [lockKey(owner)]);
      let active = await db.query<{ id: string }>(
        "SELECT id FROM confnote_chat_threads WHERE workspace_id=$1 AND user_id=$2 AND archived_at IS NULL",
        [owner.workspaceId, owner.userId],
      );
      if (!active.length) {
        active = await db.query<{ id: string }>(
          "INSERT INTO confnote_chat_threads(id,workspace_id,user_id) VALUES($1,$2,$3) RETURNING id",
          [randomUUID(), owner.workspaceId, owner.userId],
        );
      }
      await db.query("INSERT INTO confnote_chat_messages(thread_id,role,text,scope) VALUES($1,$2,$3,$4)", [active[0].id, role, body, scope || ""]);
    });
  }

  async history(owner: ChatOwner, limit = MAX_HISTORY_TURNS): Promise<ChatTurn[]> {
    const capped = Math.max(0, Math.min(Math.floor(limit) || 0, MAX_HISTORY_TURNS));
    if (!capped) return [];
    const rows = await this.database.query<{ role: ChatRole; text: string; scope: string; created_at: Date | string }>(
      `SELECT role, text, scope, created_at FROM (
         SELECT m.id, m.role, m.text, m.scope, m.created_at FROM confnote_chat_messages m
         JOIN confnote_chat_threads t ON t.id = m.thread_id
         WHERE t.workspace_id=$1 AND t.user_id=$2 AND t.archived_at IS NULL
         ORDER BY m.id DESC LIMIT $3
       ) recent ORDER BY id`,
      [owner.workspaceId, owner.userId, capped],
    );
    return rows.map((row) => ({ ts: new Date(row.created_at).toISOString(), role: row.role, text: row.text, scope: row.scope }));
  }

  async list(owner: ChatOwner): Promise<ChatThreadList> {
    const active = await this.database.query<MetaRow>(
      `${META_SELECT} WHERE t.workspace_id=$1 AND t.user_id=$2 AND t.archived_at IS NULL`,
      [owner.workspaceId, owner.userId],
    );
    const archived = await this.database.query<MetaRow>(
      `${META_SELECT} WHERE t.workspace_id=$1 AND t.user_id=$2 AND t.archived_at IS NOT NULL ORDER BY t.archived_at DESC LIMIT $3`,
      [owner.workspaceId, owner.userId, MAX_ARCHIVED_LISTED],
    );
    return { active: active.length ? meta(active[0]) : null, archived: archived.map(meta) };
  }

  async archive(owner: ChatOwner): Promise<ChatThreadMeta | null> {
    return this.database.transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [lockKey(owner)]);
      return archiveActive(db, owner);
    });
  }

  async resume(owner: ChatOwner, threadId: string): Promise<ChatThreadMeta | null> {
    if (!UUID.test(threadId || "")) return null;
    return this.database.transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [lockKey(owner)]);
      const target = await db.query<{ id: string }>(
        "SELECT id FROM confnote_chat_threads WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND archived_at IS NOT NULL",
        [threadId, owner.workspaceId, owner.userId],
      );
      if (!target.length) return null;
      await archiveActive(db, owner);
      await db.query("UPDATE confnote_chat_threads SET archived_at=NULL WHERE id=$1", [threadId]);
      const rows = await db.query<MetaRow>(`${META_SELECT} WHERE t.id=$1`, [threadId]);
      return rows.length ? meta(rows[0]) : null;
    });
  }
}

// Threads are created on their first message, so an active thread always has turns; archiving none is a no-op.
async function archiveActive(db: Database, owner: ChatOwner): Promise<ChatThreadMeta | null> {
  const rows = await db.query<{ id: string }>(
    "UPDATE confnote_chat_threads SET archived_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2 AND archived_at IS NULL RETURNING id",
    [owner.workspaceId, owner.userId],
  );
  if (!rows.length) return null;
  const archived = await db.query<MetaRow>(`${META_SELECT} WHERE t.id=$1`, [rows[0].id]);
  return archived.length ? meta(archived[0]) : null;
}
