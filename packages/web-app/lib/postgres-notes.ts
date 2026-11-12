import { createHash } from "node:crypto";
import type { Database } from "../../auth/src/repository.js";
import type { NoteCoordinator, NoteRevision } from "./note-coordination.js";
/** Transaction locks cover the entire storage read/check/write on every web instance. */
export class PostgresNoteCoordinator implements NoteCoordinator {
  constructor(private readonly database: Database) {}
  async run<T>(key: string, action: (revision: NoteRevision) => Promise<T>): Promise<T> {
    return this.database.transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`note:${key}`]);
      await db.query("INSERT INTO confnote_note_revisions(note_key,revision,content_hash) VALUES($1,0,'') ON CONFLICT DO NOTHING", [key]);
      const rows = await db.query<{ revision: string; content_hash: string }>("SELECT revision::text,content_hash FROM confnote_note_revisions WHERE note_key=$1 FOR UPDATE", [key]);
      let revision = Number(rows[0].revision); let hash = rows[0].content_hash;
      return await action({
        async observe(text: string): Promise<number> {
          const next = createHash("sha256").update(text).digest("hex");
          if (hash !== next) {
            const updated = await db.query<{ revision: string }>("UPDATE confnote_note_revisions SET revision=revision+1,content_hash=$2 WHERE note_key=$1 RETURNING revision::text", [key, next]);
            revision = Number(updated[0].revision); hash = next;
          }
          if (!Number.isSafeInteger(revision)) throw new Error("Note revision exceeds safe integer range");
          return revision;
        },
      });
    });
  }
}
