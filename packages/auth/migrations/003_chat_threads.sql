-- Concierge chat history on the web, the same model as the Mac app's .chat/ folder: one active thread per person per
-- workspace, older threads archived and resumable. Rows belong to (workspace_id, user_id) from the signed-in session.
CREATE TABLE IF NOT EXISTS confnote_chat_threads (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES confnote_workspaces(id),
  user_id uuid NOT NULL REFERENCES confnote_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS confnote_chat_threads_one_active ON confnote_chat_threads(workspace_id, user_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS confnote_chat_threads_owner ON confnote_chat_threads(workspace_id, user_id, archived_at);
CREATE TABLE IF NOT EXISTS confnote_chat_messages (
  id bigserial PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES confnote_chat_threads(id),
  role text NOT NULL CHECK(role IN ('user', 'assistant')),
  text text NOT NULL,
  scope text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS confnote_chat_messages_thread ON confnote_chat_messages(thread_id, id);
