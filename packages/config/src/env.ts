import { config as loadDotenv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { z } from 'zod';

/**
 * Load .env from the repo root so the API, the migration runner and tests all
 * resolve configuration identically. A missing file is fine in production,
 * where real environment variables are injected by the platform.
 */
function bootstrapDotenv(): void {
  if (process.env.NODE_ENV === 'production') return;
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, '..', '..', '..');
  const candidates = [resolve(root, '.env'), resolve(process.cwd(), '.env')];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      loadDotenv({ path: candidate, override: false, quiet: true });
      return;
    }
  }
}

bootstrapDotenv();

/**
 * Booleans in .env files are always strings. "false" must not become true.
 */
const boolFromString = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

/**
 * A secret that may be intentionally empty.
 * Optional-and-empty is legitimate for UPSTREAM_API_KEY (see §3 of the spec):
 * when empty we must send NO Authorization header upstream, because OpenCode
 * returns 401 for *any* Authorization header, verified empirically.
 */
const optionalSecret = z
  .string()
  .optional()
  .transform((v) => {
    const trimmed = v?.trim() ?? '';
    return trimmed.length > 0 ? trimmed : undefined;
  });

const intFromEnv = (min: number, max: number) =>
  z.coerce.number().int().min(min).max(max);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: intFromEnv(1, 65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: intFromEnv(1, 200).default(10),

  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  // Upstream provider (OpenCode Zen)
  UPSTREAM_BASE_URL: z.string().url().default('https://opencode.ai/zen/v1'),
  UPSTREAM_CHAT_COMPLETIONS_PATH: z.string().default('/chat/completions'),
  UPSTREAM_MODELS_PATH: z.string().default('/models'),
  UPSTREAM_API_KEY: optionalSecret,
  UPSTREAM_CONNECT_TIMEOUT: intFromEnv(100, 120_000).default(10_000),
  UPSTREAM_REQUEST_TIMEOUT: intFromEnv(1000, 600_000).default(120_000),
  UPSTREAM_STREAM_TIMEOUT: intFromEnv(1000, 1_800_000).default(300_000),
  UPSTREAM_MAX_RETRIES: intFromEnv(0, 5).default(1),

  /**
   * Default tier when a chat request omits `model`. `max` is the strongest
   * tier the upstream offers, so an omitted model is the most capable one
   * rather than a cheap fallback.
   */
  DEFAULT_MODEL: z.string().min(1).default('max'),

  // Default per-customer limits
  DEFAULT_REQUESTS_PER_MINUTE: intFromEnv(1, 100_000).default(60),
  DEFAULT_REQUESTS_PER_DAY: intFromEnv(1, 100_000_000).default(10_000),
  DEFAULT_TOKENS_PER_DAY: intFromEnv(1, 10_000_000_000).default(1_000_000),
  DEFAULT_MAX_CONCURRENT_REQUESTS: intFromEnv(1, 10_000).default(10),

  // Request-shape limits
  MAX_REQUEST_BODY_BYTES: intFromEnv(1024, 100_000_000).default(1_048_576),
  MAX_MESSAGES: intFromEnv(1, 10_000).default(200),
  MAX_MESSAGE_CHARS: intFromEnv(1, 10_000_000).default(100_000),
  MAX_CONTENT_TOKENS_HARD_CAP: intFromEnv(1, 1_000_000).default(8_000),

  // Security
  API_KEY_PEPPER: z.string().min(32, 'API_KEY_PEPPER must be at least 32 characters'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  SESSION_TTL_HOURS: intFromEnv(1, 24 * 365).default(24),
  SESSION_COOKIE_NAME: z.string().default('synzo_session'),
  SESSION_COOKIE_SECURE: boolFromString.default('false'),
  BCRYPT_ISH_SCRYPT_N: intFromEnv(2, 1 << 20).default(32768),
  PASSWORD_MAX_LENGTH: intFromEnv(8, 1024).default(256),

  // Brute-force protection on dashboard auth endpoints
  LOGIN_MAX_ATTEMPTS: intFromEnv(1, 100).default(10),
  LOGIN_ATTEMPT_WINDOW: intFromEnv(1, 3600).default(900),
  LOGIN_LOCKOUT_SECONDS: intFromEnv(1, 86_400).default(900),

  // Admin bootstrap
  // Empty string means "unset", consistent with every other optional secret.
  ADMIN_EMAIL: optionalSecret.pipe(z.string().email().optional()),
  ADMIN_PASSWORD: optionalSecret,

  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: boolFromString.default('false'),

  // Content logging must be opt-in (§20: never record message content by default)
  LOG_REQUEST_CONTENT: boolFromString.default('false'),
  LOG_REQUEST_CONTENT_MAX_CHARS: intFromEnv(0, 1_000_000).default(0),

  // Provider health monitoring (§36)
  PROVIDER_HEALTH_ENABLED: boolFromString.default('true'),
  PROVIDER_HEALTH_INTERVAL_MS: intFromEnv(5000, 3_600_000).default(300_000),

  // Open registration (§)
  REGISTRATION_ENABLED: boolFromString.default('true'),
  // Live keys are blocked until an admin grants unlimited/live access
  ALLOW_LIVE_KEYS: boolFromString.default('false'),

  DASHBOARD_ORIGIN: z.string().default('http://localhost:5173'),

  // --- Account recovery / verification (§8) -------------------------------
  /**
   * Public origin of the deployment, used to build the links in reset and
   * verification emails.
   *
   * Optional on purpose. When it is unset the origin is derived from the
   * incoming request, so one deployment works on any domain without being
   * reconfigured, and a staging copy on a different hostname still mints
   * working links. Set it explicitly to pin the value; it then wins over
   * detection, which is the escape hatch when a proxy's headers are wrong.
   */
  PUBLIC_BASE_URL: optionalSecret,
  /**
   * Where password-reset and verification emails go. 'log' is development and
   * test only and is rejected in production, because writing a live reset link
   * to stdout would put a working credential in the log pipeline.
   */
  MAIL_TRANSPORT: z.enum(['smtp', 'log']).default('log'),
  MAIL_FROM: z.string().default('Synzo <no-reply@synzo.local>'),
  SMTP_URL: optionalSecret,
});

/**
 * The model catalogue exposed to customers.
 *
 * A customer picks a tier; the tier resolves to a concrete upstream model. The
 * two are separate on purpose: the public name is the product surface and can
 * be renamed or re-pointed without a code change, while the upstream id is
 * whatever the provider currently calls that model.
 *
 * Order is meaningful — it is the order the tiers are shown in, from most to
 * least capable.
 */
export interface ModelTier {
  /** What a customer sends as `model`. */
  tier: string;
  /** The provider's identifier for the model serving this tier. */
  upstreamModel: string;
  /** Display name for the dashboard. */
  label: string;
  /** One-line description of what this tier is for. */
  description: string;
}

export const MODEL_TIERS: readonly ModelTier[] = [
  { tier: 'max', upstreamModel: 'gpt-6-astra', label: 'GPT-6 Astra', description: 'Maximum capability. Hardest reasoning and the most thorough answers.' },
  { tier: 'xhigh', upstreamModel: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', description: 'Extra high. Near-maximum capability at lower cost and latency.' },
  { tier: 'high', upstreamModel: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', description: 'High. Strong general capability for complex work.' },
  { tier: 'medium', upstreamModel: 'claude-opus-4-8', label: 'Claude Opus 4.8', description: 'Medium. Balanced quality and speed for everyday tasks.' },
  { tier: 'low', upstreamModel: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', description: 'Low. Fastest and cheapest. Best for simple, high-volume work.' },
] as const;


export type Env = z.infer<typeof envSchema>;
export interface AppConfig {
  env: string;
  isProduction: boolean;
  isTest: boolean;
  port: number;
  host: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  databaseUrl: string;
  databasePoolMax: number;
  redisUrl: string;
  upstream: {
    baseUrl: string;
    chatPath: string;
    modelsPath: string;
    apiKey: string | undefined;
    connectTimeoutMs: number;
    requestTimeoutMs: number;
    streamTimeoutMs: number;
    maxRetries: number;
  };
  defaultModel: string;
  defaults: { requestsPerMinute: number; requestsPerDay: number; tokensPerDay: number; maxConcurrentRequests: number };
  limits: { maxBodyBytes: number; maxMessages: number; maxMessageChars: number; maxContentTokensHardCap: number };
  security: {
    apiKeyPepper: string;
    sessionSecret: string;
    sessionTtlHours: number;
    sessionCookieName: string;
    sessionCookieSecure: boolean;
    scryptN: number;
    passwordMaxLength: number;
    trustProxy: boolean;
  };
  bruteForce: { maxAttempts: number; attemptWindowSeconds: number; lockoutSeconds: number };
  admin: { email: string | undefined; password: string | undefined };
  cors: { allowList: string[]; allowCredentials: boolean };
  dashboardOrigin: string;
  /**
   * The operator-pinned public origin, or undefined when the origin should be
   * detected per request.
   */
  publicBaseUrl: string | undefined;
  mail: { transport: 'smtp' | 'log'; from: string; smtpUrl: string | undefined };
  logging: { level: string; logRequestContent: boolean; logRequestContentMaxChars: number };
  providerHealth: { enabled: boolean; intervalMs: number };
  features: { registrationEnabled: boolean; allowLiveKeys: boolean };
}


export interface CorsOrigins {
  allowList: string[];
  allowCredentials: boolean;
}

/**
 * Parse and validate the environment exactly once at process start.
 * Missing or malformed values throw here rather than failing mysteriously later.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return parsed.data;
}

export function buildConfig(env: Env): AppConfig {
  const origins = env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);

  /**
   * Cross-field rules that a per-field schema cannot express.
   *
   * The important one: writing reset links to stdout is fine locally and is a
   * credential leak in production, where stdout is shipped to log aggregation
   * and readable by anyone with log access. Failing at startup is the only
   * point where this is still cheap to notice.
   */
  if (env.NODE_ENV === 'production') {
    if (env.MAIL_TRANSPORT === 'log') {
      throw new Error(
        'Invalid environment configuration:\n  - MAIL_TRANSPORT: "log" is not allowed when NODE_ENV=production. ' +
          'Set MAIL_TRANSPORT=smtp and SMTP_URL, or account recovery emails will be written to the log stream.',
      );
    }
    if (!env.SMTP_URL) {
      throw new Error(
        'Invalid environment configuration:\n  - SMTP_URL: required when NODE_ENV=production and MAIL_TRANSPORT=smtp.',
      );
    }
    if (!env.SESSION_COOKIE_SECURE) {
      throw new Error(
        'Invalid environment configuration:\n  - SESSION_COOKIE_SECURE: must be true when NODE_ENV=production.',
      );
    }
  }

  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    port: env.PORT,
    host: env.HOST,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    databasePoolMax: env.DATABASE_POOL_MAX,
    redisUrl: env.REDIS_URL,
    upstream: {
      baseUrl: env.UPSTREAM_BASE_URL.replace(/\/+$/, ''),
      chatPath: env.UPSTREAM_CHAT_COMPLETIONS_PATH,
      modelsPath: env.UPSTREAM_MODELS_PATH,
      apiKey: env.UPSTREAM_API_KEY,
      connectTimeoutMs: env.UPSTREAM_CONNECT_TIMEOUT,
      requestTimeoutMs: env.UPSTREAM_REQUEST_TIMEOUT,
      streamTimeoutMs: env.UPSTREAM_STREAM_TIMEOUT,
      maxRetries: env.UPSTREAM_MAX_RETRIES,
    },
    defaultModel: env.DEFAULT_MODEL,
    defaults: {
      requestsPerMinute: env.DEFAULT_REQUESTS_PER_MINUTE,
      requestsPerDay: env.DEFAULT_REQUESTS_PER_DAY,
      tokensPerDay: env.DEFAULT_TOKENS_PER_DAY,
      maxConcurrentRequests: env.DEFAULT_MAX_CONCURRENT_REQUESTS,
    },
    limits: {
      maxBodyBytes: env.MAX_REQUEST_BODY_BYTES,
      maxMessages: env.MAX_MESSAGES,
      maxMessageChars: env.MAX_MESSAGE_CHARS,
      maxContentTokensHardCap: env.MAX_CONTENT_TOKENS_HARD_CAP,
    },
    security: {
      apiKeyPepper: env.API_KEY_PEPPER,
      sessionSecret: env.SESSION_SECRET,
      sessionTtlHours: env.SESSION_TTL_HOURS,
      sessionCookieName: env.SESSION_COOKIE_NAME,
      sessionCookieSecure: env.SESSION_COOKIE_SECURE,
      scryptN: env.BCRYPT_ISH_SCRYPT_N,
      passwordMaxLength: env.PASSWORD_MAX_LENGTH,
      trustProxy: env.TRUST_PROXY,
    },
    bruteForce: {
      maxAttempts: env.LOGIN_MAX_ATTEMPTS,
      attemptWindowSeconds: env.LOGIN_ATTEMPT_WINDOW,
      lockoutSeconds: env.LOGIN_LOCKOUT_SECONDS,
    },
    admin: {
      email: env.ADMIN_EMAIL,
      password: env.ADMIN_PASSWORD,
    },
    cors: { allowList: origins, allowCredentials: true } satisfies CorsOrigins,
    dashboardOrigin: env.DASHBOARD_ORIGIN,
    /**
     * Undefined means "derive the public origin from each request". See
     * apps/api/src/lib/public-origin.ts for the rules and the trust boundary.
     */
    publicBaseUrl: env.PUBLIC_BASE_URL?.replace(/\/+$/, ''),
    mail: {
      transport: env.MAIL_TRANSPORT,
      from: env.MAIL_FROM,
      smtpUrl: env.SMTP_URL,
    },
    logging: {
      level: env.LOG_LEVEL,
      logRequestContent: env.LOG_REQUEST_CONTENT,
      logRequestContentMaxChars: env.LOG_REQUEST_CONTENT_MAX_CHARS,
    },
    providerHealth: {
      enabled: env.PROVIDER_HEALTH_ENABLED,
      intervalMs: env.PROVIDER_HEALTH_INTERVAL_MS,
    },
    features: {
      registrationEnabled: env.REGISTRATION_ENABLED,
      allowLiveKeys: env.ALLOW_LIVE_KEYS,
    },
  };
}
