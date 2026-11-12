-- Content fingerprints reconcile a completed storage write after a failed DB commit.
-- Markdown remains the source of note content; this table contains only CAS metadata.
CREATE TABLE IF NOT EXISTS confnote_note_revisions (
  note_key text PRIMARY KEY,
  revision bigint NOT NULL DEFAULT 0 CHECK(revision >= 0),
  content_hash text NOT NULL DEFAULT ''
);
