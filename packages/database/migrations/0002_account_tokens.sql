-- Single-use, hashed tokens for account recovery and email verification.
--
-- Only the SHA-256 digest of each token is stored, so a database dump alone
-- cannot be replayed against a live deployment: possession of the row is not
-- possession of the token. The raw token exists only in the email link and in
-- the customer's browser.
--
-- Both flows share one table with a `purpose` discriminator rather than two
-- near-identical tables. A token is scoped to exactly one account and one
-- purpose, expires, and is marked consumed on first use, so replay always
-- fails and an old email can never re-open an account after a password change.

CREATE TYPE account_token_purpose AS ENUM ('password_reset', 'email_verification');

CREATE TABLE account_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256 hex of the raw token. Unique so a collision cannot silently
  -- invalidate an outstanding request.
  token_hash  VARCHAR(64) NOT NULL UNIQUE,
  purpose     account_token_purpose NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  -- Client IP and user agent of the request that created the token, for the
  -- abuse-investigation trail in §49. Never the token itself.
  ip          VARCHAR(64),
  user_agent  VARCHAR(500),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lookup is always "outstanding tokens for this user and purpose".
CREATE INDEX account_tokens_user_purpose_idx ON account_tokens (user_id, purpose);
-- Supports the periodic sweep that deletes expired rows.
CREATE INDEX account_tokens_expires_idx ON account_tokens (expires_at);
