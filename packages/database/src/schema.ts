import { relations, sql } from 'drizzle-orm';
import {
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

export const userStatus = pgEnum('user_status', ['active', 'suspended', 'pending']);
export const keyStatus = pgEnum('key_status', ['active', 'disabled', 'revoked']);
export const keyEnvironment = pgEnum('key_environment', ['live', 'test']);
export const requestStatus = pgEnum('request_status', ['success', 'error', 'cancelled']);

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

/* ----------------------------------------------------------------- relations */

export const usersRelations = relations(users, ({ many, one }) => ({
  projects: many(projects),
  apiKeys: many(apiKeys),
  requests: many(requests),
  limits: one(customerLimits),
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
