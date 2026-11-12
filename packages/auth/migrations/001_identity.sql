-- Additive; run only against the application's own database after operator setup.
CREATE TABLE IF NOT EXISTS confnote_users (id uuid PRIMARY KEY, email text NOT NULL, disabled boolean NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS confnote_auth_identities (provider text NOT NULL, external_user_id text NOT NULL, user_id uuid NOT NULL REFERENCES confnote_users(id), PRIMARY KEY(provider, external_user_id));
CREATE TABLE IF NOT EXISTS confnote_workspaces (id uuid PRIMARY KEY, name text NOT NULL, owner_id uuid NOT NULL REFERENCES confnote_users(id), event_id text, external_provider text, external_org_id text, UNIQUE(owner_id,event_id));
CREATE TABLE IF NOT EXISTS confnote_memberships (workspace_id uuid NOT NULL REFERENCES confnote_workspaces(id), user_id uuid NOT NULL REFERENCES confnote_users(id), role text NOT NULL CHECK(role IN ('owner','editor','viewer')), PRIMARY KEY(workspace_id,user_id));
CREATE TABLE IF NOT EXISTS confnote_tracking (user_id uuid NOT NULL REFERENCES confnote_users(id), event_id text NOT NULL, status text NOT NULL CHECK(status IN ('interested','going','attended')), PRIMARY KEY(user_id,event_id));
CREATE TABLE IF NOT EXISTS confnote_auth_events (provider text NOT NULL, event_id text NOT NULL, payload jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(provider,event_id));
CREATE TABLE IF NOT EXISTS confnote_revoked_sessions (provider text NOT NULL, session_id text NOT NULL, PRIMARY KEY(provider,session_id));
CREATE TABLE IF NOT EXISTS confnote_rate_limits (bucket text PRIMARY KEY, count integer NOT NULL, resets_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS confnote_entitlements (user_id uuid PRIMARY KEY REFERENCES confnote_users(id), plan text NOT NULL CHECK(plan IN ('free','pro')), valid_until timestamptz);
