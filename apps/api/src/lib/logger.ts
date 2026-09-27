import type { AppConfig } from '@synzo/config';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 } satisfies Record<LogLevel, number>;

function levelValue(level: LogLevel): number {
  return LEVEL_ORDER[level];
}

/**
 * Keys whose values must never reach a log sink (§31). Matched
 * case-insensitively against top-level and nested object keys.
 */
const SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'passwordhash',
  'password_hash',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'sessionsecret',
  'session_secret',
  'apikey',
  'api_key',
  'keyhash',
  'key_hash',
  'apikeypepper',
  'api_key_pepper',
  'upstreamapikey',
  'upstream_api_key',
  'databaseurl',
  'database_url',
  'redisurl',
  'redis_url',
  'secret',
  'authorizationheader',
]);

/** sk_live_… / sk_test_… patterns, which can appear in free-text fields. */
const API_KEY_PATTERN = /\b(sk_(?:live|test)_)[A-Za-z0-9]{8,}/g;

export function redactString(value: string): string {
  return value.replace(API_KEY_PATTERN, '$1[REDACTED]');
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return '[UNSERIALIZABLE]';
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

class JsonLogger implements Logger {
  constructor(
    private readonly minLevel: number,
    private readonly bindings: Record<string, unknown> = {},
  ) {}

  private write(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (levelValue(level) < this.minLevel) return;
    const record = {
      level,
      time: new Date().toISOString(),
      msg: redactString(msg),
      ...((redact(this.bindings) ?? {}) as Record<string, unknown>),
      ...(meta ? ((redact(meta) ?? {}) as Record<string, unknown>) : {}),
    };
    const line = JSON.stringify(record);
    if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }

  debug(m: string, meta?: Record<string, unknown>) {
    this.write('debug', m, meta);
  }
  info(m: string, meta?: Record<string, unknown>) {
    this.write('info', m, meta);
  }
  warn(m: string, meta?: Record<string, unknown>) {
    this.write('warn', m, meta);
  }
  error(m: string, meta?: Record<string, unknown>) {
    this.write('error', m, meta);
  }
  child(bindings: Record<string, unknown>): Logger {
    return new JsonLogger(this.minLevel, { ...this.bindings, ...bindings });
  }
}

export function createLogger(config: AppConfig): Logger {
  return new JsonLogger(LEVEL_ORDER[config.logLevel]);
}
