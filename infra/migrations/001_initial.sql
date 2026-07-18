CREATE TABLE IF NOT EXISTS reference_schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reference_contract_imports (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  record jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS reference_releases (
  id text PRIMARY KEY,
  sequence bigint NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  record jsonb NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS reference_releases_one_active
  ON reference_releases (active) WHERE active;

CREATE TABLE IF NOT EXISTS reference_endpoints (
  id text PRIMARY KEY,
  state text NOT NULL,
  url text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  record jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS reference_subscriptions (
  endpoint_id text PRIMARY KEY REFERENCES reference_endpoints(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL,
  record jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS reference_secret_versions (
  id text PRIMARY KEY,
  endpoint_id text NOT NULL REFERENCES reference_endpoints(id) ON DELETE CASCADE,
  state text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  record jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS reference_secret_versions_endpoint
  ON reference_secret_versions(endpoint_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reference_test_commands (
  id text PRIMARY KEY,
  endpoint_id text NOT NULL REFERENCES reference_endpoints(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  state text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  record jsonb NOT NULL,
  UNIQUE(endpoint_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS reference_metadata_observations (
  dedupe_key text PRIMARY KEY,
  delivery_id text NOT NULL,
  sequence integer NOT NULL,
  occurred_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL,
  late boolean NOT NULL,
  record jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS reference_metadata_observations_delivery
  ON reference_metadata_observations(delivery_id, ingested_at);

CREATE TABLE IF NOT EXISTS reference_metadata_timeline (
  delivery_id text PRIMARY KEY,
  endpoint_id text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  status text NOT NULL,
  occurred_at timestamptz NOT NULL,
  last_ingested_at timestamptz NOT NULL,
  record jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS reference_metadata_timeline_search
  ON reference_metadata_timeline(last_ingested_at DESC, delivery_id DESC);
CREATE INDEX IF NOT EXISTS reference_metadata_timeline_filters
  ON reference_metadata_timeline(endpoint_id, event_type, status, occurred_at DESC);

CREATE TABLE IF NOT EXISTS reference_audit_events (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  result text NOT NULL,
  record jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS reference_audit_events_created
  ON reference_audit_events(created_at DESC);

CREATE TABLE IF NOT EXISTS reference_payload_references (
  id text PRIMARY KEY,
  object_key text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  delivery_id text,
  record jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS reference_payload_references_expiry
  ON reference_payload_references(expires_at);

INSERT INTO reference_schema_migrations(version)
VALUES ('001_initial')
ON CONFLICT DO NOTHING;
