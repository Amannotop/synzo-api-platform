-- Core multi-tenant schema for the Synzo API platform.
-- Every customer-owned table carries user_id so tenant scope is enforceable at the DB layer.

CREATE TYPE user_status AS ENUM ('active', 'suspended', 'pending');
CREATE TYPE key_status AS ENUM ('active', 'disabled', 'revoked');
CREATE TYPE key_environment AS ENUM ('live', 'test');
CREATE TYPE request_status AS ENUM ('success', 'error', 'cancelled');

CREATE TABLE providers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(64) NOT NULL UNIQUE,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE models (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_name     VARCHAR(200) NOT NULL UNIQUE,
  provider_id     UUID NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  upstream_model  VARCHAR(200) NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX models_provider_idx ON models(provider_id);
CREATE INDEX models_enabled_idx  ON models(enabled);

CREATE TABLE users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email            VARCHAR(320) NOT NULL,
  password_hash    TEXT NOT NULL,
  name             VARCHAR(120) NOT NULL,
  role             VARCHAR(16) NOT NULL DEFAULT 'customer',
  status           user_status NOT NULL DEFAULT 'active',
  email_verified   BOOLEAN NOT NULL DEFAULT FALSE,
  unlimited_mode   BOOLEAN NOT NULL DEFAULT FALSE,
  allow_live_keys  BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));
CREATE INDEX users_status_idx ON users(status);

CREATE TABLE projects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        VARCHAR(100) NOT NULL,
  description VARCHAR(500),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX projects_user_idx ON projects(user_id);

CREATE TABLE customer_limits (
  user_id                 UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  requests_per_minute     INTEGER NOT NULL,
  requests_per_day        INTEGER NOT NULL,
  tokens_per_day          INTEGER NOT NULL,
  max_concurrent_requests INTEGER NOT NULL,
  allowed_models          TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- key_prefix is display-only; key_hash is HMAC-SHA256(pepper, secret) hex.
-- The plaintext secret is never persisted, so it cannot leak from a DB dump.
CREATE TABLE api_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         VARCHAR(100) NOT NULL,
  key_prefix   VARCHAR(32) NOT NULL,
  key_hash     VARCHAR(64) NOT NULL,
  environment  key_environment NOT NULL DEFAULT 'test',
  status       key_status NOT NULL DEFAULT 'active',
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX api_keys_hash_key ON api_keys(key_hash);
CREATE INDEX api_keys_user_idx    ON api_keys(user_id);
CREATE INDEX api_keys_project_idx ON api_keys(project_id);

CREATE TABLE requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id        VARCHAR(64) NOT NULL UNIQUE,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  api_key_id        UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  model_id          UUID REFERENCES models(id) ON DELETE SET NULL,
  model_name        VARCHAR(200) NOT NULL,
  provider          VARCHAR(64) NOT NULL,
  status            request_status NOT NULL,
  http_status       INTEGER NOT NULL,
  stream            BOOLEAN NOT NULL DEFAULT FALSE,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  total_tokens      INTEGER,
  upstream_cost     NUMERIC(20,10),
  currency          VARCHAR(8),
  latency_ms        INTEGER NOT NULL,
  error_type        VARCHAR(64),
  error_code        VARCHAR(64),
  -- NULL unless LOG_REQUEST_CONTENT=true; content logging is OFF by default.
  request_content   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX requests_user_created_idx ON requests(user_id, created_at);
CREATE INDEX requests_project_idx     ON requests(project_id);
CREATE INDEX requests_api_key_idx     ON requests(api_key_id);
CREATE INDEX requests_model_idx       ON requests(model_id);
CREATE INDEX requests_status_idx      ON requests(status);
CREATE INDEX requests_created_idx     ON requests(created_at);

-- Rollup table so dashboard charts never scan the full requests table.
CREATE TABLE usage_daily (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id           UUID REFERENCES projects(id) ON DELETE CASCADE,
  model_name           VARCHAR(200) NOT NULL,
  day                  VARCHAR(10) NOT NULL,
  requests             INTEGER NOT NULL DEFAULT 0,
  successful_requests  INTEGER NOT NULL DEFAULT 0,
  failed_requests      INTEGER NOT NULL DEFAULT 0,
  prompt_tokens        INTEGER NOT NULL DEFAULT 0,
  completion_tokens    INTEGER NOT NULL DEFAULT 0,
  total_tokens         INTEGER NOT NULL DEFAULT 0,
  upstream_cost        NUMERIC(20,10) NOT NULL DEFAULT 0,
  total_latency_ms     INTEGER NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX usage_daily_unique ON usage_daily(user_id, project_id, model_name, day);
CREATE INDEX usage_daily_user_day_idx  ON usage_daily(user_id, day);

CREATE TABLE rate_limits (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_key_id    UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  day           VARCHAR(10) NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  token_count   INTEGER NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX rate_limits_unique         ON rate_limits(api_key_id, day);
CREATE INDEX      rate_limits_user_day_idx    ON rate_limits(user_id, day);

CREATE TABLE sessions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  user_agent VARCHAR(500),
  ip         VARCHAR(64),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx    ON sessions(user_id);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);

CREATE TABLE audit_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action        VARCHAR(64) NOT NULL,
  resource_type VARCHAR(64),
  resource_id   VARCHAR(128),
  metadata      TEXT,
  ip            VARCHAR(64),
  user_agent    VARCHAR(500),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_actor_idx  ON audit_logs(actor_user_id);
CREATE INDEX audit_logs_action_idx ON audit_logs(action);
