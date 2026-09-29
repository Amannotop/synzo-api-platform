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
  /**
   * The retention job, so a test can drive a sweep directly rather than
   * waiting on its timer or reaching into the process's private state.
   */
  retention: BuiltApp['retention'];
  /** Credit accounting, for suites that exercise balances directly. */
  credits: BuiltApp['credits'];
  creditService: BuiltApp['creditService'];
  /** The stale-reservation reclaim loop, drivable without waiting on a timer. */
  creditSweeper: BuiltApp['creditSweeper'];
  /**
   * The payment notifier, so a suite can drive the delivery path against a
   * stub instead of api.telegram.org. Its `fetchImpl` is a plain writable
   * field for exactly this reason.
   */
  telegram: BuiltApp['telegram'];
  close: () => Promise<void>;
}

export interface HarnessOptions {
  /** Point the provider at a local server instead of the live upstream. */
  localUpstream?: boolean;
  env?: Record<string, string>;
  /**
   * Opt into the credit system's production semantics: new registrations
   * require admin approval, and a fresh account has NO credits.
   *
   * Off by default so the suites that predate credits (rate limiting, tool
   * calling, metrics, usage) keep testing what they were written to test
   * rather than tripping over a 402 they have no reason to expect. A suite
   * that is ABOUT the credit system turns this on, because "a new account
   * cannot use the API" is exactly the behaviour it needs to verify.
   */
  creditSystem?: boolean;
  /**
   * Opt into plan entitlements: a trial grants only the entry package's models
   * instead of every model.
   *
   * Deliberately separate from `creditSystem`, because the two are different
   * subjects. A suite about credit accounting still needs to address models by
   * name — `max`, `high` — and expect them to work; making it also opt into
   * model tiers would fail every one of those calls with a 404 that is correct
   * but unrelated to what the suite is testing. So `creditSystem` governs
   * approval and balances, and this governs which models a trial can reach.
   */
  planEntitlements?: boolean;
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
    /**
     * Legacy suites register an account and immediately make an API call. With
     * credit enforcement wired in (which is unconditional in `buildApp`, and
     * should be), that account has a zero balance and the call is correctly
     * refused with a 402. Turning the switch off is the honest way to keep
     * those suites testing their own subject; every one of them can instead
     * opt in and assert the credit behaviour explicitly.
     */
    APPROVAL_REQUIRED: options.creditSystem ? 'true' : 'false',
    /**
     * Legacy suites address models by name (`max`, `high`) and expect them to
     * work. The trial tier only grants the entry package's models, so with real
     * plan semantics every one of those calls would be refused with a 404 —
     * correctly, and for a reason that has nothing to do with what those suites
     * are testing. The trial is therefore unrestricted here, the same way
     * APPROVAL_REQUIRED is turned off above. A suite that IS about plan
     * entitlements passes `planEntitlements: true` and gets the real behaviour.
     */
    FREE_TRIAL_PACKAGE: options.planEntitlements ? '' : 'none',
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
    retention: built.retention,
    credits: built.credits,
    creditService: built.creditService,
    creditSweeper: built.creditSweeper,
    telegram: built.telegram,
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
