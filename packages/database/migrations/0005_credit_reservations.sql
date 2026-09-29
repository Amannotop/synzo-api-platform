-- Credit reservations.
--
-- Why this migration exists: the spec requires that "credit deductions are
-- atomic and cannot result in concurrent requests overspending the balance."
-- Deducting ACTUAL tokens after the provider responds cannot satisfy that.
-- Consider a customer with 1,000 credits left who fires 50 requests
-- simultaneously. Every one of them reserves nothing, every one reaches the
-- upstream, and each then tries to deduct its real cost — by which time the
-- balance is long gone. Whether the balance goes negative depends on the
-- interleaving, not on the code being correct.
--
-- The fix is to hold the tokens BEFORE the upstream is called. A reservation
-- is a claim on the balance: it is taken atomically, the request only proceeds
-- if it succeeds, and when the provider finally reports real usage the
-- reservation is settled to that number and the difference is released.
--
-- Reservations are stored as COLUMNS on credit_balances rather than as a
-- separate table. That is a deliberate choice, and it is what makes the whole
-- thing safe under concurrency:
--
--  - A separate `credit_reservations` table would need its own locking to stop
--    two readers of the same balance from each reserving against a stale
--    snapshot. Holding the reservation on the balance row means the reserve is
--    a single conditional UPDATE on the same row the deduction touches, so the
--    database serialises them for us.
--
--  - The CHECK constraint below is the invariant. A balance is spendable when
--    remaining - reserved >= 0. Enforcing it in the schema means no code path,
--    including a future one nobody has written yet, can leave the platform
--    owing tokens to a customer it has already served.
--
-- Settling is a two-step dance that must be exactly-once. Both the stream and
-- non-stream paths settle, and a client disconnect can interrupt either, so
-- `settled_at` makes a second call a no-op instead of a double deduction.

-- --- 1. Reservation columns ---------------------------------------------

ALTER TABLE credit_balances
  ADD COLUMN free_reserved BIGINT NOT NULL DEFAULT 0 CHECK (free_reserved >= 0),
  ADD COLUMN paid_reserved BIGINT NOT NULL DEFAULT 0 CHECK (paid_reserved >= 0);

-- The invariant, stated once and enforced by the database.
--
-- A reservation does NOT reduce `*_remaining`; it earmarks part of it. That is
-- deliberate, and it is what makes the whole mechanism work: the balance row
-- stays a statement about totals ("you have been granted 500,000 and spent
-- 12,000, so 488,000 remain") while the reserved columns say how much of that
-- 488,000 is spoken for by requests in flight. Spendable is then the
-- expression `remaining - reserved`, and the customer still sees 488,000.
--
-- So the constraint a reservation may violate is NOT about granted at all: a
-- reservation can only ever earmark tokens that are still sitting in the
-- remaining pool, never tokens already spent and never more than the pool
-- holds.
--
--     reserved <= remaining
--
-- The earlier draft of this migration asserted
-- `used + remaining + reserved <= granted` instead, which double-counts: it
-- treats earmarked tokens as if they had left the remaining pool, so the very
-- first reservation of 32,000 against a 500,000 trial (used=0, remaining=500k,
-- reserved=32k) sums to 532,000 and is rejected by the database. Migration
-- 0006 replaces it with the correct form; the statement is kept here in its
-- corrected form so a fresh database and a migrated one agree.
--
-- free_used + free_remaining <= free_granted is NOT repeated here; it already
-- exists on the table from migration 0004 and is unchanged.
ALTER TABLE credit_balances
  ADD CONSTRAINT credit_balances_reservation_consistent
    CHECK (
      free_reserved <= free_remaining
      AND paid_reserved <= paid_remaining
    );

-- Partial indexes for the admin and paywall queries that ask "who is out of
-- credits" without scanning every row. Restricted to rows with nothing in
-- flight, because a customer mid-request is not yet exhausted and the spendable
-- figure is an expression rather than an indexable column.
CREATE INDEX credit_balances_spendable_free_idx ON credit_balances (free_remaining)
  WHERE free_remaining > 0 AND free_reserved = 0;
CREATE INDEX credit_balances_spendable_paid_idx ON credit_balances (paid_remaining)
  WHERE paid_remaining > 0 AND paid_reserved = 0;

-- --- 2. Which request holds which reservation ---------------------------

-- One row per in-flight request that is holding tokens.
--
-- Without this, a release after a crash would have no way to find what to
-- give back, and "exactly once" would not survive a restart. The row is the
-- handle: the chat service reserves (row inserted), then settles or releases
-- (row updated to settled). Re-settling an already-settled row is a no-op,
-- which is what makes both completion paths safe to call twice.
CREATE TABLE credit_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The request this reservation is for. Not a foreign key to `requests`: a
  -- reservation is taken before the request row exists, and the retention
  -- sweep prunes `requests` at 90 days while a held reservation must survive
  -- independently.
  request_id VARCHAR(64) NOT NULL UNIQUE,

  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- What was actually taken, split by bucket, so releasing returns tokens to
  -- exactly the pool they came from.
  free_amount BIGINT NOT NULL DEFAULT 0 CHECK (free_amount >= 0),
  paid_amount BIGINT NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),

  -- The upper bound this reservation was taken at, kept for the audit trail.
  reserved_total BIGINT NOT NULL CHECK (reserved_total > 0),

  -- Set when the reservation is settled (to actual usage) or released (the
  -- request failed before the provider was called). NULL means in flight.
  settled_at TIMESTAMPTZ,

  -- What actually happened, for the operator reading the ledger.
  outcome VARCHAR(16),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX credit_reservations_user_idx ON credit_reservations (user_id, created_at DESC);

-- At most one open reservation per request. A second reserve for the same
-- request id would double-count, so this is a hard database guarantee rather
-- than an application convention.
CREATE UNIQUE INDEX credit_reservations_open_key
  ON credit_reservations (request_id)
  WHERE settled_at IS NULL;
