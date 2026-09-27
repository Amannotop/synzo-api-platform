import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import { buildConfig, loadEnv } from '@synzo/config';
import { createDatabase, type DatabaseHandle } from '@synzo/database';
import { buildApp, type BuiltApp } from '../../apps/api/src/app.js';
import { LocalUpstream } from './local-upstream.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const WORKSPACE_ROOT = resolve(HERE, '../..');

/**
 * Integration tests run against the REAL PostgreSQL and Valkey the platform
 * uses in production, not mocks or in-memory doubles. Rate limiting and
 * quota enforcement are exactly the kind of behaviour that a fake would get
 * wrong — a fake cannot reproduce Lua atomicity, key TTLs, or a unique index
 * enforcing tenant isolation.
 *
 * The upstream AI provider is the one exception: it is a local HTTP server,
 * because timeout/disconnect/malformed-SSE behaviour has to be deterministic
 * and cannot be provoked on demand from the live endpoint. scripts/smoke.sh
 * covers the real OpenCode Zen upstream.
 */
function loadEnvFile(): NodeJS.ProcessEnv {
  // Resolved relative to the workspace, not the caller's CWD, so the suite
  // behaves the same however it is invoked.
  const text = readFileSync(resolve(WORKSPACE_ROOT, '.env'), 'utf8');
  const out: NodeJS.ProcessEnv = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export interface Harness {
  app: BuiltApp['app'];
  logger: BuiltApp['logger'];
  db: DatabaseHandle['db'];
  sql: DatabaseHandle['sql'];
  redis: Redis;
  upstream: LocalUpstream;
  config: ReturnType<typeof buildConfig>;
  close: () => Promise<void>;
}

export interface HarnessOptions {
  /** Point the provider at a local server instead of the live upstream. */
  localUpstream?: boolean;
  env?: Record<string, string>;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const upstream = new LocalUpstream();
  if (options.localUpstream !== false) await upstream.start();

  const fileEnv = loadEnvFile();
  const merged: NodeJS.ProcessEnv = {
    ...fileEnv,
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    // Point every service at the local stub so nothing reaches the internet.
    UPSTREAM_BASE_URL: upstream.baseUrl,
    UPSTREAM_API_KEY: '',
    ...options.env,
  };

  const config = buildConfig(loadEnv(merged));
  const handle = createDatabase(config.databaseUrl, { max: 5 });
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3, lazyConnect: true });
  await redis.connect();

  const built = await buildApp({ config, db: handle.db, redis });
  await built.app.ready();

  return {
    app: built.app,
    logger: built.logger,
    db: handle.db,
    sql: handle.sql,
    redis,
    upstream,
    config,
    close: async () => {
      await built.app.close();
      await handle.close();
      redis.disconnect();
      await upstream.stop();
    },
  };
}

/** Removes every key this suite created, so cases cannot leak into each other. */
export async function clearRateLimitState(redis: Redis, ...ids: string[]): Promise<void> {
  const keys: string[] = [];
  for (const id of ids) {
    for (const scope of ['user', 'key']) {
      keys.push(
        `rl:${scope}:concurrent:${id}`,
        `rl:${scope}:min:${id}`,
        `rl:${scope}:day:${id}`,
        `rl:${scope}:tokens:${id}`,
      );
    }
  }
  if (keys.length > 0) await redis.del(...keys);
}
