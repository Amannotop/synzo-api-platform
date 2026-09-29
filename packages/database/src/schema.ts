import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/**
 * Account lifecycle status.
 *
 * 'pending'   registered, awaiting an admin decision — no API access
 * 'active'    approved and usable (also the column default, see migration 0004)
 * 'suspended' an approved account the operator has switched off; reversible
 * 'rejected'  an account the operator reviewed and turned away
 *
 * 'rejected' is separate from 'suspended' on purpose: rejecting is a decision
 * about an applicant that has never had access, while suspending is a lever
 * on a live account. Conflating them makes "reactivate" ambiguous.
 */
export const userStatus = pgEnum('user_status', ['active', 'suspended', 'pending', 'rejected']);
export const keyStatus = pgEnum('key_status', ['active', 'disabled', 'revoked']);
export const keyEnvironment = pgEnum('key_environment', ['live', 'test']);
export const requestStatus = pgEnum('request_status', ['success', 'error', 'cancelled']);
export const accountTokenPurpose = pgEnum('account_token_purpose', [
  'password_reset',
  'email_verification',
]);

/* ---------------------------------------------------------------- providers */

export const providers = pgTable('providers', {
  id: id(),
  name: varchar('name', { length: 64 }).notNull().unique(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/* ------------------------------------------------------------------- models */

export const models = pgTable(
  'models',
  {
    id: id(),
    publicName: varchar('public_name', { length: 200 }).notNull().unique(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'restrict' }),
    upstreamModel: varchar('upstream_model', { length: 200 }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('models_provider_idx').on(t.providerId), index('models_enabled_idx').on(t.enabled)],
);

/* -------------------------------------------------------------------- users */

export const users = pgTable(
  'users',
  {
    id: id(),
    email: varchar('email', { length: 320 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    role: varchar('role', { length: 16 }).notNull().default('customer'),
    status: userStatus('status').notNull().default('active'),
    emailVerified: boolean('email_verified').notNull().default(false),
    /** Admin-granted: bypasses rate limits / quotas (§50). */
    unlimitedMode: boolean('unlimited_mode').notNull().default(false),
    /** Admin-granted: may mint sk_live_ keys. */
    allowLiveKeys: boolean('allow_live_keys').notNull().default(false),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_email_key').on(sql`lower(${t.email})`),
    index('users_status_idx').on(t.status),
  ],
);

/* ----------------------------------------------------------------- projects */

export const projects = pgTable(
  'projects',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    description: varchar('description', { length: 500 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('projects_user_idx').on(t.userId)],
);

/* ------------------------------------------------- per-customer limits (§50) */

export const customerLimits = pgTable('customer_limits', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  requestsPerMinute: integer('requests_per_minute').notNull(),
  requestsPerDay: integer('requests_per_day').notNull(),
  tokensPerDay: integer('tokens_per_day').notNull(),
  maxConcurrentRequests: integer('max_concurrent_requests').notNull(),
  /** NULL = all enabled models allowed. Otherwise a JSON array of public names. */
  allowedModels: text('allowed_models'),
  /**
   * Images this customer may attach per request. Same three states as the
   * package's `imageLimit`: 0 = none, a number = that many, NULL = unlimited.
   */
  maxImages: integer('max_images'),
  /**
   * The grant the customer holds independently of any purchase — what access
   * reverts to when a paid plan expires.
   *
   * Stored rather than re-derived because the entry package comes from package
   * data the operator can edit, and the request path must not depend on it. A
   * renewal restores the paid values without re-purchasing.
   */
  baseAllowedModels: text('base_allowed_models'),
  baseMaxImages: integer('base_max_images'),
  /**
   * When the paid grant lapses. NULL never lapses, which is what a trial and
   * any operator-set row get.
   *
   * Evaluated at request time rather than by a sweep: a 7-day tier swept daily
   * would keep working for up to a day past what was paid for.
   */
  planExpiresAt: timestamp('plan_expires_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/* ----------------------------------------------------------------- api_keys */

/**
 * The full secret is NEVER stored. We keep:
 *  - keyPrefix: the first 12 chars, for display only
 *  - keyHash:   HMAC-SHA256(pepper, full_key), hex — exact indexed lookup
 *
 * HMAC (not bare SHA-256) means a database dump alone cannot be brute-forced
 * without the server-side pepper, which lives in env and is never in the DB.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    keyPrefix: varchar('key_prefix', { length: 32 }).notNull(),
    keyHash: varchar('key_hash', { length: 64 }).notNull(),
    environment: keyEnvironment('environment').notNull().default('test'),
    status: keyStatus('status').notNull().default('active'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('api_keys_hash_key').on(t.keyHash),
    index('api_keys_user_idx').on(t.userId),
    index('api_keys_project_idx').on(t.projectId),
  ],
);

/* ------------------------------------------------------------------ requests */

export const requests = pgTable(
  'requests',
  {
    id: id(),
    requestId: varchar('request_id', { length: 64 }).notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    modelId: uuid('model_id').references(() => models.id, { onDelete: 'set null' }),
    modelName: varchar('model_name', { length: 200 }).notNull(),
    provider: varchar('provider', { length: 64 }).notNull(),
    status: requestStatus('status').notNull(),
    httpStatus: integer('http_status').notNull(),
    stream: boolean('stream').notNull().default(false),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    totalTokens: integer('total_tokens'),
    /**
     * Upstream cost, exactly as reported. The OpenCode provider returns this as a
     * STRING ("0"), so it is parsed defensively and stored as numeric. Kept
     * strictly separate from any customer-facing price (§19).
     */
    upstreamCost: numeric('upstream_cost', { precision: 20, scale: 10 }),
    currency: varchar('currency', { length: 8 }),
    latencyMs: integer('latency_ms').notNull(),
    errorType: varchar('error_type', { length: 64 }),
    errorCode: varchar('error_code', { length: 64 }),
    /** Null unless LOG_REQUEST_CONTENT=true (§20 — off by default). */
    requestContent: text('request_content'),
    createdAt: createdAt(),
  },
  (t) => [
    index('requests_user_created_idx').on(t.userId, t.createdAt),
    index('requests_project_idx').on(t.projectId),
    index('requests_api_key_idx').on(t.apiKeyId),
    index('requests_model_idx').on(t.modelId),
    index('requests_status_idx').on(t.status),
    index('requests_created_idx').on(t.createdAt),
  ],
);

/** Denormalized per-day rollup for fast dashboard charts without scanning `requests`. */
export const usageDaily = pgTable(
  'usage_daily',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    modelName: varchar('model_name', { length: 200 }).notNull(),
    /** UTC day, as YYYY-MM-DD. */
    day: varchar('day', { length: 10 }).notNull(),
    requests: integer('requests').notNull().default(0),
    successfulRequests: integer('successful_requests').notNull().default(0),
    failedRequests: integer('failed_requests').notNull().default(0),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    upstreamCost: numeric('upstream_cost', { precision: 20, scale: 10 }).notNull().default('0'),
    totalLatencyMs: integer('total_latency_ms').notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('usage_daily_unique').on(t.userId, t.projectId, t.modelName, t.day),
    index('usage_daily_user_day_idx').on(t.userId, t.day),
  ],
);

/* ------------------------------------------------------ rate_limits + audit */

/** Per-key daily counters, written through from Redis for durable accounting. */
export const rateLimits = pgTable(
  'rate_limits',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    apiKeyId: uuid('api_key_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'cascade' }),
    day: varchar('day', { length: 10 }).notNull(),
    requestCount: integer('request_count').notNull().default(0),
    tokenCount: integer('token_count').notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('rate_limits_unique').on(t.apiKeyId, t.day),
    index('rate_limits_user_day_idx').on(t.userId, t.day),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the session token. The raw token only ever exists in the cookie. */
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    userAgent: varchar('user_agent', { length: 500 }),
    ip: varchar('ip', { length: 64 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

/**
 * Single-use, hashed tokens for password reset and email verification (§8).
 *
 * Only the SHA-256 digest is stored, so a leaked database dump cannot be
 * replayed as a working reset link. The raw token lives only in the email.
 */
export const accountTokens = pgTable(
  'account_tokens',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    purpose: accountTokenPurpose('purpose').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    ip: varchar('ip', { length: 64 }),
    userAgent: varchar('user_agent', { length: 500 }),
    createdAt: createdAt(),
  },
  (t) => [
    index('account_tokens_user_purpose_idx').on(t.userId, t.purpose),
    index('account_tokens_expires_idx').on(t.expiresAt),
  ],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: varchar('action', { length: 64 }).notNull(),
    resourceType: varchar('resource_type', { length: 64 }),
    resourceId: varchar('resource_id', { length: 128 }),
    metadata: text('metadata'),
    ip: varchar('ip', { length: 64 }),
    userAgent: varchar('user_agent', { length: 500 }),
    createdAt: createdAt(),
  },
  (t) => [index('audit_logs_actor_idx').on(t.actorUserId), index('audit_logs_action_idx').on(t.action)],
);

/* ================================================================ credits */

export const creditLedgerBucket = pgEnum('credit_ledger_bucket', ['free', 'paid']);

export const creditLedgerKind = pgEnum('credit_ledger_kind', [
  'free_trial_grant',
  'admin_grant',
  'admin_deduct',
  'payment_credit',
  'usage_deduct',
  'reversal',
]);

export const paymentStatus = pgEnum('payment_status', ['pending', 'approved', 'rejected']);

/**
 * The two balances a customer holds, in token credits, plus the running totals.
 *
 * Free and paid are separate columns rather than one number because the spec
 * requires them to stay distinguishable — a customer who has spent their trial
 * and bought more must be able to see which pool is draining, and an operator
 * reconciling a payment must be able to confirm the credits arrived in the
 * paid column and not the free one.
 *
 * The `credit_balances_*_consistent` CHECK constraints (migration 0004) make
 * it impossible for used + remaining to exceed granted, so a bug in the
 * deduction arithmetic cannot manufacture credits.
 */
export const creditBalances = pgTable('credit_balances', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  freeGranted: bigint('free_granted', { mode: 'number' }).notNull().default(0),
  freeUsed: bigint('free_used', { mode: 'number' }).notNull().default(0),
  freeRemaining: bigint('free_remaining', { mode: 'number' }).notNull().default(0),
  paidGranted: bigint('paid_granted', { mode: 'number' }).notNull().default(0),
  paidUsed: bigint('paid_used', { mode: 'number' }).notNull().default(0),
  paidRemaining: bigint('paid_remaining', { mode: 'number' }).notNull().default(0),
  /**
   * Tokens held by requests that are in flight and have not yet been settled
   * to their real usage.
   *
   * These are the reason concurrent requests cannot overspend. A request claims
   * its worst-case cost HERE, before the upstream is called, and the claim only
   * succeeds if the spendable balance covers it. Without this, every concurrent
   * request would pass the check against the same stale figure and the balance
   * would be overdrawn by whichever of them settled last.
   *
   * Spendable free = freeRemaining - freeReserved. The
   * `credit_balances_reservation_consistent` CHECK (migration 0005) holds
   * used + remaining + reserved <= granted, so this arithmetic cannot go
   * negative no matter what the application does.
   */
  freeReserved: bigint('free_reserved', { mode: 'number' }).notNull().default(0),
  paidReserved: bigint('paid_reserved', { mode: 'number' }).notNull().default(0),
  /**
   * Set once when the one-time trial is granted and never cleared, so
   * "has this account had its trial" stays answerable after the credits are
   * spent. Mirrors the ledger's partial unique index; see migration 0004.
   */
  freeTrialGrantedAt: timestamp('free_trial_granted_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * A claim on a customer's balance, held for the duration of one API request.
 *
 * The lifecycle is: reserve (row inserted, balance columns claimed), then
 * exactly one of settle or release (row marked, tokens either converted to
 * usage or handed back). `settledAt` is what makes the second call a no-op,
 * which matters because both the streaming and non-streaming paths settle and
 * a client disconnect can make either of them run twice.
 */
export const creditReservations = pgTable(
  'credit_reservations',
  {
    id: id(),
    /**
     * The request id this reservation belongs to. Unique, so a retried reserve
     * for the same request cannot double-claim the balance.
     */
    requestId: varchar('request_id', { length: 64 }).notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Portion taken from the free pool. */
    freeAmount: bigint('free_amount', { mode: 'number' }).notNull().default(0),
    /** Portion taken from the paid pool. */
    paidAmount: bigint('paid_amount', { mode: 'number' }).notNull().default(0),
    /** The upper bound that was reserved, for the audit trail. */
    reservedTotal: bigint('reserved_total', { mode: 'number' }).notNull(),
    /** NULL while in flight; set once settled or released. */
    settledAt: timestamp('settled_at', { withTimezone: true }),
    /** 'settled' | 'released', recorded for the operator. */
    outcome: varchar('outcome', { length: 16 }),
    createdAt: createdAt(),
  },
  (t) => [index('credit_reservations_user_idx').on(t.userId, t.createdAt)],
);

/**
 * Append-only record of every credit movement.
 *
 * `credit_balances` is a running total kept for cheap reads; this is the
 * evidence. An operator asking "where did these 300,000 tokens come from"
 * reads this table, and a disagreement between the two can be traced to the
 * exact entry that caused it because each row stores the balance it produced.
 *
 * Nothing in the application updates or deletes a row here.
 */
export const creditLedger = pgTable(
  'credit_ledger',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bucket: creditLedgerBucket('bucket').notNull(),
    kind: creditLedgerKind('kind').notNull(),
    /** Signed: positive grants, negative usage. */
    amount: bigint('amount', { mode: 'number' }).notNull(),
    /** Balance in `bucket` immediately after this entry. */
    balanceAfter: bigint('balance_after', { mode: 'number' }).notNull(),
    reason: text('reason'),
    referenceType: varchar('reference_type', { length: 64 }),
    referenceId: varchar('reference_id', { length: 128 }),
    /** NULL for automatic usage — no human approved a token. */
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    /**
     * Set for operations that must happen at most once (a payment allocation,
     * the trial grant). The UNIQUE constraint on this column is the last line
     * of defence against a retried request allocating twice.
     */
    idempotencyKey: varchar('idempotency_key', { length: 128 }).unique(),
    createdAt: createdAt(),
  },
  (t) => [
    index('credit_ledger_user_created_idx').on(t.userId, t.createdAt),
    index('credit_ledger_reference_idx').on(t.referenceType, t.referenceId),
    index('credit_ledger_kind_idx').on(t.kind),
  ],
);

/** A purchasable bundle of token credits, priced in minor currency units. */
export const creditPackages = pgTable(
  'credit_packages',
  {
    id: id(),
    name: varchar('name', { length: 80 }).notNull(),
    description: text('description'),
    /**
     * The token grant behind the package. Now the abuse guard rather than the
     * headline: what a customer is buying is `allowedModels`, and this is the
     * ceiling that stops one account from consuming the upstream balance. It
     * is still `notNull` so a package can never be unbounded by accident.
     */
    credits: bigint('credits', { mode: 'number' }).notNull(),
    /**
     * Which models this package grants. NULL = every model, the same convention
     * `customer_limits.allowed_models` already uses, so one parser reads both.
     *
     * A stored list rather than "the N cheapest tiers", because a count would
     * silently change what a customer already bought the moment an operator
     * enabled, disabled or renamed a model.
     */
    allowedModels: text('allowed_models'),
    /**
     * Images this package grants per request. 0 = none, a number = that many,
     * NULL = no plan-level cap. NULL is kept distinct from a large number
     * because it is the only value that means "unlimited".
     */
    imageLimit: integer('image_limit'),
    /**
     * Term in days. NULL means the purchase never expires. A duration is only
     * meaningful as a positive number, which the column constrains.
     */
    durationDays: integer('duration_days'),
    /**
     * Price in the smallest unit of `currency` — paise for INR, cents for USD.
     * Integral on purpose: money as a float loses cents.
     */
    priceMinor: bigint('price_minor', { mode: 'number' }).notNull(),
    currency: varchar('currency', { length: 8 }).notNull().default('INR'),
    sortOrder: integer('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('credit_packages_active_idx').on(t.sortOrder)],
);

/**
 * A customer's claim that they have paid.
 *
 * Carries its own copy of the package name, credit amount and price rather
 * than joining back to `credit_packages` at read time: if the admin later
 * reprices a package, the amount this customer agreed to must not change
 * under them. The request is a historical document, not a live view.
 */
export const paymentRequests = pgTable(
  'payment_requests',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    packageId: uuid('package_id').references(() => creditPackages.id, { onDelete: 'set null' }),
    packageName: varchar('package_name', { length: 80 }).notNull(),
    credits: bigint('credits', { mode: 'number' }).notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: varchar('currency', { length: 8 }).notNull(),
    /** UPI / bank reference the customer typed as proof. */
    reference: varchar('reference', { length: 160 }).notNull(),
    email: varchar('email', { length: 320 }).notNull(),
    status: paymentStatus('status').notNull().default('pending'),
    reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewNote: text('review_note'),
    receiptPath: text('receipt_path'),
    receiptMime: varchar('receipt_mime', { length: 80 }),
    receiptBytes: integer('receipt_bytes'),
    /**
     * Whether the Telegram notification landed. Kept on the row so an
     * operator can find the submissions the bot never received, and retry
     * them, instead of having to infer it from log history.
     */
    telegramStatus: varchar('telegram_status', { length: 16 }),
    telegramError: text('telegram_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('payment_requests_user_created_idx').on(t.userId, t.createdAt),
    index('payment_requests_status_idx').on(t.status, t.createdAt),
    index('payment_requests_user_reference_key').on(t.userId, sql`lower(${t.reference})`),
  ],
);

/**
 * Single-row payment configuration (id is pinned to TRUE by a CHECK).
 *
 * A table rather than environment variables because the operator needs to
 * change the QR and the instructions from the dashboard without a redeploy,
 * and because the QR is binary-adjacent data that does not belong in a file
 * everyone with shell access can read.
 */
export const billingSettings = pgTable('billing_settings', {
  id: boolean('id').primaryKey().default(true),
  paymentInstructions: text('payment_instructions'),
  qrCodeUrl: text('qr_code_url'),
  qrCodeMime: varchar('qr_code_mime', { length: 80 }),
  qrCodeBytes: integer('qr_code_bytes'),
  paymentMethodLabel: varchar('payment_method_label', { length: 120 }),
  currency: varchar('currency', { length: 8 }).notNull().default('INR'),
  updatedAt: updatedAt(),
});

/* ----------------------------------------------------------------- relations */

export const usersRelations = relations(users, ({ many, one }) => ({
  projects: many(projects),
  apiKeys: many(apiKeys),
  requests: many(requests),
  limits: one(customerLimits),
  credits: one(creditBalances),
  ledger: many(creditLedger),
  payments: many(paymentRequests),
}));

export const creditBalancesRelations = relations(creditBalances, ({ one, many }) => ({
  user: one(users, { fields: [creditBalances.userId], references: [users.id] }),
  ledger: many(creditLedger),
}));

export const creditReservationsRelations = relations(creditReservations, ({ one }) => ({
  user: one(users, { fields: [creditReservations.userId], references: [users.id] }),
}));

export const creditLedgerRelations = relations(creditLedger, ({ one }) => ({
  user: one(users, { fields: [creditLedger.userId], references: [users.id] }),
}));

export const paymentRequestsRelations = relations(paymentRequests, ({ one }) => ({
  user: one(users, { fields: [paymentRequests.userId], references: [users.id] }),
  package: one(creditPackages, { fields: [paymentRequests.packageId], references: [creditPackages.id] }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  user: one(users, { fields: [projects.userId], references: [users.id] }),
  apiKeys: many(apiKeys),
  requests: many(requests),
}));

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, { fields: [apiKeys.userId], references: [users.id] }),
  project: one(projects, { fields: [apiKeys.projectId], references: [projects.id] }),
}));

export const modelsRelations = relations(models, ({ one }) => ({
  provider: one(providers, { fields: [models.providerId], references: [providers.id] }),
}));

export const requestsRelations = relations(requests, ({ one }) => ({
  user: one(users, { fields: [requests.userId], references: [users.id] }),
  project: one(projects, { fields: [requests.projectId], references: [projects.id] }),
  model: one(models, { fields: [requests.modelId], references: [models.id] }),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Model = typeof models.$inferSelect;
export type Provider = typeof providers.$inferSelect;
export type RequestRecord = typeof requests.$inferSelect;
export type CustomerLimits = typeof customerLimits.$inferSelect;
export type AccountToken = typeof accountTokens.$inferSelect;
export type CreditBalance = typeof creditBalances.$inferSelect;
export type CreditLedgerEntry = typeof creditLedger.$inferSelect;
export type CreditPackage = typeof creditPackages.$inferSelect;
export type PaymentRequest = typeof paymentRequests.$inferSelect;
export type BillingSettings = typeof billingSettings.$inferSelect;
export type CreditReservation = typeof creditReservations.$inferSelect;
