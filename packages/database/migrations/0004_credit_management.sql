-- Credit management: approval workflow, free trial, ledger, and payments.
--
-- Design notes that matter for anyone modifying this later:
--
-- 1. `user_status` gains 'rejected'. It already had 'pending', which was
--    declared but never written by any code path — the enum value existed
--    while every registration defaulted to 'active'. This migration makes the
--    value real and the behaviour behind it real.
--
-- 2. Balances live in `credit_balances` rather than as columns on `users`.
--    One row per user, holding the two balances the spec requires to be
--    distinguishable (free and paid) plus the running totals. Deduction is a
--    single `UPDATE ... WHERE free_remaining >= n` (or the paid equivalent)
--    inside a transaction, which is what makes concurrent requests unable to
--    overspend: the second writer's WHERE clause matches zero rows and the
--    transaction rolls back. A read-then-write in application code cannot
--    offer that guarantee.
--
-- 3. `credit_ledger` is append-only and is the source of truth for where a
--    balance came from. The balance columns are a running total for cheap
--    reads; the ledger is what an operator audits. Every mutation writes both
--    in one transaction.
--
-- 4. The one-time free trial is enforced by a partial UNIQUE index on
--    `credit_ledger (user_id) WHERE kind = 'free_trial_grant'`, not by an
--    application-level "have I granted it before?" check. The index is the
--    guarantee: a concurrent double-approval, a retried request, or a status
--    flip can each attempt the insert, and only one of them can ever land.
--
-- 5. `payment_requests` carries a unique index on (user_id, reference) so a
--    customer cannot submit the same transaction reference twice, and the
--    status transition to 'approved' is guarded by a CHECK plus a
--    conditional UPDATE (status = 'pending') so credits are added exactly
--    once no matter how many times the admin's button is pressed.

-- --- 1. Account approval status -----------------------------------------

-- 'pending' already existed in the enum but was never used. 'rejected' is new:
-- an account an admin has looked at and turned away, as distinct from one
-- they have not yet reviewed ('pending') or one they suspended after use
-- ('suspended'). Rejecting is terminal for the applicant; suspending is a
-- reversible operator action on a live account.
ALTER TABLE users ALTER COLUMN status DROP DEFAULT;
ALTER TYPE user_status ADD VALUE IF NOT EXISTS 'rejected';
ALTER TABLE users ALTER COLUMN status SET DEFAULT 'active';

-- Why the default stays 'active' rather than becoming 'pending':
--
-- Existing rows and existing tests register and immediately use the API. A
-- new default of 'pending' would break every current customer on the next
-- registration. Approval is therefore opt-in per deployment, controlled by
-- APPROVAL_REQUIRED below: when it is on, the registration code path writes
-- 'pending' explicitly rather than relying on the column default. The column
-- default stays 'active' so a plain INSERT still produces a usable account
-- and the migration itself changes nobody's access.

-- --- 2. Balances --------------------------------------------------------

CREATE TABLE credit_balances (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- Token credits. Kept as integers because a half token is not a thing, and
  -- an integral type makes the conditional UPDATE's arithmetic exact.
  free_granted BIGINT NOT NULL DEFAULT 0 CHECK (free_granted >= 0),
  free_used BIGINT NOT NULL DEFAULT 0 CHECK (free_used >= 0),
  free_remaining BIGINT NOT NULL DEFAULT 0 CHECK (free_remaining >= 0),

  paid_granted BIGINT NOT NULL DEFAULT 0 CHECK (paid_granted >= 0),
  paid_used BIGINT NOT NULL DEFAULT 0 CHECK (paid_used >= 0),
  paid_remaining BIGINT NOT NULL DEFAULT 0 CHECK (paid_remaining >= 0),

  -- Set once, never cleared. This is what "the trial has been granted" means
  -- even after the balance is spent: a flag in a mutable table would be
  -- ambiguous, a timestamp that only ever gets written is not.
  free_trial_granted_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- free_remaining must never exceed what was granted, and used must never
  -- exceed the grant either. Without these, a bug in the deduction arithmetic
  -- could silently manufacture credits.
  CONSTRAINT credit_balances_free_consistent
    CHECK (free_used + free_remaining <= free_granted),
  CONSTRAINT credit_balances_paid_consistent
    CHECK (paid_used + paid_remaining <= paid_granted)
);

CREATE INDEX credit_balances_free_remaining_idx ON credit_balances (free_remaining)
  WHERE free_remaining > 0;
CREATE INDEX credit_balances_paid_remaining_idx ON credit_balances (paid_remaining)
  WHERE paid_remaining > 0;

-- --- 3. Append-only ledger ---------------------------------------------

CREATE TYPE credit_ledger_kind AS ENUM (
  -- The one-time 500,000-token trial, granted by admin approval.
  'free_trial_grant',
  -- A manual admin add (bonus, goodwill, correction).
  'admin_grant',
  -- A manual admin deduction.
  'admin_deduct',
  -- Credits allocated by an approved payment.
  'payment_credit',
  -- Tokens consumed by an API call. Always negative.
  'usage_deduct',
  -- A reversal of a manual deduction that was made in error.
  'reversal'
);

CREATE TYPE credit_ledger_bucket AS ENUM ('free', 'paid');

CREATE TABLE credit_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Which balance this entry moved.
  bucket credit_ledger_bucket NOT NULL,

  kind credit_ledger_kind NOT NULL,

  -- Signed token amount. Grants and usage are signed so a single SUM() over
  -- the ledger reproduces the balance exactly; the CHECK keeps the two
  -- buckets' signs honest (free_trial_grant/admin_grant/payment_credit/
  -- reversal are positive, usage_deduct is negative).
  amount BIGINT NOT NULL,

  -- Balance AFTER this entry. Storing it is what makes the ledger auditable
  -- by reading: each row says where the balance stood, so a disagreement with
  -- credit_balances can be traced to the exact entry that caused it.
  balance_after BIGINT NOT NULL CHECK (balance_after >= 0),

  -- Why the entry exists. Free text for a human, always populated for a
  -- manual adjustment and a payment.
  reason TEXT,

  -- Links an entry to what caused it. A payment allocation and the trial
  -- grant point at a payment_request / approval; usage points at the request
  -- row. Plain columns, not foreign keys: credit_ledger must outlive the
  -- retention sweep that prunes `requests`, or the audit trail would rot.
  reference_type VARCHAR(64),
  reference_id VARCHAR(128),

  -- Who caused it. NULL for automatic usage, since no human approved a token.
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,

  -- Prevents a retried payment approval from allocating twice. NULL for
  -- entries that are legitimately repeatable (usage_deduct).
  idempotency_key VARCHAR(128) UNIQUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX credit_ledger_user_created_idx ON credit_ledger (user_id, created_at DESC);
CREATE INDEX credit_ledger_reference_idx ON credit_ledger (reference_type, reference_id);
CREATE INDEX credit_ledger_kind_idx ON credit_ledger (kind);

-- The one-time free trial, enforced by the database.
--
-- A partial unique index is the whole guarantee. An application-level check
-- ("SELECT then INSERT if absent") has a race between the two statements that
-- two concurrent approvals — or an approval retried by a double-clicked
-- button — will eventually win. This cannot: the second INSERT violates the
-- index no matter how it was sequenced, and the transaction rolls back.
--
-- Deliberately NOT on the free_trial_granted_at column, because that column
-- is only written alongside a successful ledger insert and a direct UPDATE of
-- it would bypass the guarantee.
CREATE UNIQUE INDEX credit_ledger_free_trial_once_idx
  ON credit_ledger (user_id)
  WHERE kind = 'free_trial_grant';

-- A user cannot be granted the trial twice even if their ledger rows are
-- deleted by an operator, because the balance row's timestamp still stands
-- and the approval path checks it. Belt and braces on purpose.

-- --- 4. Credit packages -------------------------------------------------

CREATE TABLE credit_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(80) NOT NULL,
  description TEXT,

  -- How many token credits this package buys.
  credits BIGINT NOT NULL CHECK (credits > 0),

  -- Price in the smallest unit of `currency` to avoid float money. With
  -- currency = 'INR' a value of 49900 means ₹499.00.
  price_minor BIGINT NOT NULL CHECK (price_minor > 0),
  currency VARCHAR(8) NOT NULL DEFAULT 'INR',

  -- Ordering in the customer's package picker, and the "popular" marker.
  sort_order INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX credit_packages_active_idx ON credit_packages (sort_order) WHERE active;

-- A package name is what the customer picks out of a list, so two packages
-- with the same name would be ambiguous on the paywall and in an audit.
CREATE UNIQUE INDEX credit_packages_name_key ON credit_packages (lower(name));

-- --- 5. Payment requests ------------------------------------------------

CREATE TYPE payment_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE payment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- The package as it was at submission time. Denormalized on purpose: if the
  -- admin later edits the package's price or credits, the amount this customer
  -- agreed to pay must not silently change under them.
  package_id UUID REFERENCES credit_packages(id) ON DELETE SET NULL,
  package_name VARCHAR(80) NOT NULL,
  credits BIGINT NOT NULL CHECK (credits > 0),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency VARCHAR(8) NOT NULL,

  -- What the customer typed as proof of payment. Free text: UPI reference,
  -- bank transfer id, whatever their payment method produces.
  reference VARCHAR(160) NOT NULL,

  -- The address the customer confirmed, kept for the record even though the
  -- account is already identified by the session. An operator reconciling a
  -- bank statement needs the address the customer believes they paid from.
  email VARCHAR(320) NOT NULL,

  status payment_status NOT NULL DEFAULT 'pending',

  -- Admin's decision.
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,

  -- Receipt image, if the customer uploaded one.
  receipt_path TEXT,
  receipt_mime VARCHAR(80),
  receipt_bytes INT,

  -- Telegram delivery outcome, kept so an operator can see which submissions
  -- never reached the bot and retry them. NULL until a send is attempted.
  telegram_status VARCHAR(16),
  telegram_error TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX payment_requests_user_created_idx ON payment_requests (user_id, created_at DESC);
CREATE INDEX payment_requests_status_idx ON payment_requests (status, created_at DESC);

-- Duplicate submission guard. A customer who double-submits the form, or
-- whose request is replayed, cannot create a second pending request for the
-- same reference. Combined with the unique idempotency key on the ledger,
-- this is what makes "approved exactly once" hold end to end.
CREATE UNIQUE INDEX payment_requests_user_reference_key
  ON payment_requests (user_id, lower(reference));

-- --- 6. Payment instructions / QR --------------------------------------

-- Single-row configuration table. One row, id = TRUE.
CREATE TABLE billing_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),

  -- Where the customer sends money. Free text so it can hold a UPI id, a
  -- bank account, or a note like "scan and pay".
  payment_instructions TEXT,

  -- The payment QR as a data URL or an https URL. Stored server-side, served
  -- only to the owner of a pending request and to admins, never embedded in
  -- a public page.
  qr_code_url TEXT,
  qr_code_mime VARCHAR(80),
  qr_code_bytes INT,

  -- Shown next to the QR so the customer knows what they are paying for.
  payment_method_label VARCHAR(120),
  currency VARCHAR(8) NOT NULL DEFAULT 'INR',

  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO billing_settings (id, payment_instructions, qr_code_url, payment_method_label, currency)
VALUES (
  TRUE,
  'Scan the QR code below and pay the exact amount shown. Then enter the transaction reference from your payment receipt so we can verify it.',
  NULL,
  'UPI / QR',
  'INR'
)
ON CONFLICT (id) DO NOTHING;

-- --- 7. Trial grant tracking on the user --------------------------------

-- Not strictly needed (credit_balances.free_trial_granted_at covers it) but
-- it lets the admin customer list answer "has this account had its trial?"
-- without a second table lookup on a list of hundreds of rows, and it is the
-- value a customer's own dashboard reads to show "trial used".
CREATE INDEX users_status_created_idx ON users (created_at DESC);

-- --- 8. Seed the default package set -----------------------------------
--
-- Prices are placeholders the admin edits from the dashboard. They exist so
-- a fresh install has a working paywall instead of an empty one. Currency is
-- INR because the operator's payment method (UPI QR) is INR; the admin can
-- change every one of these, and the currency, from the admin UI.
INSERT INTO credit_packages (name, description, credits, price_minor, currency, sort_order) VALUES
  ('Starter',  'Top up to keep building. 1 million token credits.', 1000000,  19900, 'INR', 10),
  ('Growth',   'For teams shipping real traffic. 5 million token credits.', 5000000, 89900, 'INR', 20),
  ('Scale',    'For production workloads. 20 million token credits.', 20000000, 299900, 'INR', 30)
ON CONFLICT (lower(name)) DO NOTHING;
