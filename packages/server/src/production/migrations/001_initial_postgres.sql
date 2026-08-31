CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  tenant TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL,
  created TIMESTAMPTZ NOT NULL, seq INTEGER NOT NULL DEFAULT 0, head TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (tenant, id)
);
CREATE TABLE IF NOT EXISTS events (
  tenant TEXT NOT NULL, session TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL,
  blob TEXT NOT NULL, prev TEXT NOT NULL, hash TEXT NOT NULL,
  PRIMARY KEY (tenant, session, seq), UNIQUE (tenant, session, id),
  FOREIGN KEY (tenant, session) REFERENCES sessions(tenant, id),
  CONSTRAINT events_immutable CHECK (length(hash) = 64)
);
CREATE OR REPLACE FUNCTION reject_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable events'; END; $$;
DROP TRIGGER IF EXISTS events_no_update ON events;
DROP TRIGGER IF EXISTS events_no_delete ON events;
CREATE TRIGGER events_no_update BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();
CREATE TRIGGER events_no_delete BEFORE DELETE ON events FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();
CREATE TABLE IF NOT EXISTS artifacts (
  tenant TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, author TEXT NOT NULL,
  status TEXT NOT NULL, digest TEXT NOT NULL, blob TEXT NOT NULL, meta JSONB NOT NULL,
  seal TEXT NOT NULL, created TIMESTAMPTZ NOT NULL, PRIMARY KEY (tenant, kind, key)
);
CREATE TABLE IF NOT EXISTS pointers (
  tenant TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, ref TEXT NOT NULL,
  seal TEXT NOT NULL, PRIMARY KEY (tenant, kind, name)
);
CREATE TABLE IF NOT EXISTS jobs (
  tenant TEXT NOT NULL, id TEXT NOT NULL, actor TEXT NOT NULL, session TEXT NOT NULL,
  kind TEXT NOT NULL, idem TEXT NOT NULL, request_hash TEXT NOT NULL, blob TEXT NOT NULL,
  state TEXT NOT NULL, owner TEXT, deadline BIGINT, lease_until BIGINT, result JSONB,
  created BIGINT NOT NULL, PRIMARY KEY (tenant, id), UNIQUE (tenant, idem)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_session ON jobs(tenant, session)
  WHERE state IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS queued_jobs ON jobs(state, created);
CREATE TABLE IF NOT EXISTS revoked_tokens (hash TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, window_start BIGINT NOT NULL, count INTEGER NOT NULL);

-- A migration checkpoint is deliberately separate from business facts.  It makes
-- SQLite -> PostgreSQL cutovers auditable and allows the migration command to
-- prove that a rollback only targets a database that was empty before import.
CREATE TABLE IF NOT EXISTS migration_checkpoints (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','completed','rolled_back','failed')),
  target_was_empty BOOLEAN NOT NULL DEFAULT FALSE,
  tenants JSONB NOT NULL DEFAULT '[]'::jsonb,
  counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_hash TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

INSERT INTO schema_migrations(version) VALUES (1) ON CONFLICT (version) DO NOTHING;
