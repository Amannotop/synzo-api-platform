import { z } from 'zod';

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

  DEFAULT_MODEL: z.string().min(1).default('space-bunny-free'),

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
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().optional(),

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
});

export type Env = z.infer<typeof envSchema>;
export type AppConfig = ReturnType<typeof buildConfig>;

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
