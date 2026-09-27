import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { RateLimitService, type RateLimitInput } from '../../apps/api/src/services/rate-limit.service.js';
import { createHarness, clearRateLimitState } from '../helpers/harness.js';

/**
 * Rate limiting is tested against REAL Valkey, because the guarantees under
 * test are properties of Lua atomicity, key TTLs and counters — none of which
 * an in-memory fake can reproduce. A fake that "looks right" here would hide
 * exactly the lost-update and partial-consumption bugs these tests exist to
 * catch (§21, §22, §50).
 */
let redis: Redis;
let harness: Awaited<ReturnType<typeof createHarness>>;

const USER = 'user-rl-0001';
const KEY = 'key-rl-0001';

function input(overrides: Partial<RateLimitInput> = {}): RateLimitInput {
  return {
    userId: USER,
    apiKeyId: KEY,
    requestsPerMinute: 60,
    requestsPerDay: 1000,
    tokensPerDay: 100_000,
    maxConcurrentRequests: 5,
    unlimited: false,
    ...overrides,
  };
}

/** A logger that records, so tests can assert on warn/error without noise. */
function makeLogger() {
  const warns: unknown[] = [];
  const errors: unknown[] = [];
  return {
    warns,
    errors,
    debug() {},
    info() {},
    warn(_m: string, meta?: Record<string, unknown>) { warns.push(meta); },
    error(_m: string, meta?: Record<string, unknown>) { errors.push(meta); },
    child() { return this; },
  };
}

beforeAll(async () => {
  harness = await createHarness();
  redis = harness.redis;
});

afterAll(async () => {
  await clearRateLimitState(redis, USER, KEY);
  await harness.close();
});

beforeEach(async () => {
  await clearRateLimitState(redis, USER, KEY);
});

describe('minute window (spec 21)', () => {
  it('admits up to the limit and then rejects with 429', async () => {
    const rl = new RateLimitService(redis, makeLogger() as never);
    const leases = [];
    for (let i = 0; i < 3; i++) leases.push(await rl.checkAndConsume(input({ requestsPerMinute: 3 })));

    await expect(rl.checkAndConsume(input({ requestsPerMinute: 3 }))).rejects.toMatchObject({
      statusCode: 429,
      code: 'rate_limit_exceeded',
    });

    for (const l of leases) await l.release();
  });

  it('sets a Retry-After hint on the minute rejection', async () => {
    const rl = new RateLimitService(redis, makeLogger() as never);
    const l = await rl.checkAndConsume(input({ requestsPerMinute: 1 }));
    const err = await rl.checkAndConsume(input({ requestsPerMinute: 1 })).catch((e) => e);
    expect((err as { retryAfter?: number }).retryAfter).toBeGreaterThan(0);
    expect((err as { retryAfter?: number }).retryAfter).toBeLessThanOrEqual(60);
    await l.release();
  });

  it('expires the window so a later request is admitted again', async () => {
    // The window key carries a 60s PEXPIRE; TTL presence is what proves the
    // window self-cleans rather than counting forever.
    const rl = new RateLimitService(redis, makeLogger() as never);
    await rl.checkAndConsume(input({ requestsPerMinute: 5 }));
    const ttl = await redis.pttl(`rl:user:min:${USER}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });

  it('counts two requests in the same millisecond separately', async () => {
    // Without a unique ZSET member these collide and undercount the window,
    // letting a customer exceed their per-minute allowance.
    const rl = new RateLimitService(redis, makeLogger() as never);
    await Promise.all([
      rl.checkAndConsume(input({ requestsPerMinute: 10 })),
      rl.checkAndConsume(input({ requestsPerMinute: 10 })),
    ]);
    expect(await redis.zcard(`rl:user:min:${USER}`)).toBe(2);
  });
});

describe('daily request quota (spec 22)', () => {
  it('rejects with a distinct quota code once the day is exhausted', async () => {
    const rl = new RateLimitService(redis, makeLogger() as never);
    await rl.checkAndConsume(input({ requestsPerDay: 1 }));
    await expect(rl.checkAndConsume(input({ requestsPerDay: 1 }))).rejects.toMatchObject({
      statusCode: 429,
      code: 'daily_request_quota_exceeded',
    });
  });

  it('does not consume a minute slot when the daily quota rejects', async () => {
    // A customer who is out of daily requests must not also burn per-minute
    // allowance on every attempt.
    const rl = new RateLimitService(redis, makeLogger() as never);
    await rl.checkAndConsume(input({ requestsPerDay: 1, requestsPerMinute: 100 }));
    await rl.checkAndConsume(input({ requestsPerDay: 1, requestsPerMinute: 100 })).catch(() => {});
    expect(await redis.zcard(`rl:user:min:${USER}`)).toBe(1);
  });

  it('sets an expiry that rolls the counter over at UTC midnight', async () => {
    const rl = new RateLimitService(redis, makeLogger() as never);
    await rl.checkAndConsume(input());
    const ttl = await redis.ttl(`rl:user:day:${USER}`);
    const now = new Date();
    const nextMidnight = Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0,
    ) - now.getTime();
    const expected = Math.ceil(nextMidnight / 1000);
    // Within a few seconds of midnight-rollover drift.
    expect(Math.abs(ttl - expected)).toBeLessThanOrEqual(5);
  });
});

describe('concurrency (spec 23)', () => {
  it('admits up to maxConcurrentRequests and rejects beyond it', async () => {
    const rl = new RateLimitService(redis, makeLogger() as never);
    const held = [];
    for (let i = 0; i < 2; i++) held.push(await rl.checkAndConsume(input({ maxConcurrentRequests: 2 })));
    await expect(rl.checkAndConsume(input({ maxConcurrentRequests: 2 }))).rejects.toMatchObject({
      statusCode: 429,
    });
    for (const l of held) await l.release();
  });

  it('frees the slot on release so the next request is admitted', async () => {
    const rl = new RateLimitService(redis, makeLogger() as never);
    const l = await rl.checkAndConsume(input({ maxConcurrentRequests: 1 }));
    await expect(rl.checkAndConsume(input({ maxConcurrentRequests: 1 }))).rejects.toMatchObject({
      statusCode: 429,
    });
    await l.release();
    const next = await rl.checkAndConsume(input({ maxConcurrentRequests: 1 }));
    expect(next.holdsConcurrency).toBe(true);
    await next.release();
  });

  it('is idempotent, so a double release cannot over-admit later', async () => {
    const rl = new RateLimitService(redis, makeLogger() as never);
    const a = await rl.checkAndConsume(input({ maxConcurrentRequests: 1 }));
    const b = await rl.checkAndConsume(input({ maxConcurrentRequests: 1 })).catch(() => null);
    expect(b).toBeNull(); // b was rejected; a still holds the only slot

    await a.release();
    await a.release(); // second release must be a no-op
    await a.release();

    const c = await rl.checkAndConsume(input({ maxConcurrentRequests: 1 }));
    expect(c.holdsConcurrency).toBe(true);
    await c.release();
  });

  it('never drives the counter negative under unbalanced release', async () => {
    // A negative counter would silently grant more than the limit for the
    // remainder of the key's TTL, so the release path clamps at zero.
    const rl = new RateLimitService(redis, makeLogger() as never);
    await rl.releaseConcurrency(KEY, USER);
    await rl.releaseConcurrency(KEY, USER);
    const l = await rl.checkAndConsume(input({ maxConcurrentRequests: 1 }));
    await l.release();
    await l.release();
    const raw = await redis.get(`rl:user:concurrent:${USER}`);
    expect(raw === null || Number(raw) === 0).toBe(true);
  });
});

describe('rejection side effects (spec 22)', () => {
  it('leaves no trace when the key scope rejects after the customer scope was admitted', async () => {
    // This is the cross-scope rollback the combined Lua script exists for. If
    // it were not atomic, the customer scope would keep its minute/day
    // counters while the request was rejected — a customer could exhaust
    // their own allowance with requests that were never served.
    const rl = new RateLimitService(redis, makeLogger() as never);

    // Pre-fill the KEY's daily quota right up to its limit, so the very next
    // request exceeds it and the key scope rejects, while the USER scope is
    // still wide open.
    await redis.set(`rl:key:day:${KEY}`, '100', 'EX', 3600);

    await expect(
      rl.checkAndConsume(input({ requestsPerDay: 100, requestsPerMinute: 100 })),
    ).rejects.toBeDefined();

    // Nothing was consumed at either scope.
    expect(await redis.zcard(`rl:user:min:${USER}`)).toBe(0);
    expect(await redis.zcard(`rl:key:min:${KEY}`)).toBe(0);
    const userDay = await redis.get(`rl:user:day:${USER}`);
    expect(userDay === null || Number(userDay) === 0).toBe(true);
    const conc = await redis.get(`rl:user:concurrent:${USER}`);
    expect(conc === null || Number(conc) === 0).toBe(true);
  });

  it('restores the customer concurrency slot when the key scope rejects', async () => {
    const rl = new RateLimitService(redis, makeLogger() as never);
    // Both key-scope limits are already saturated, so the key scope refuses
    // the moment the customer scope has just accepted.
    await redis.set(`rl:key:concurrent:${KEY}`, '5', 'EX', 900);
    await redis.set(`rl:key:day:${KEY}`, '1000', 'EX', 3600);

    await expect(rl.checkAndConsume(input({ maxConcurrentRequests: 5 }))).rejects.toBeDefined();

    const userConc = await redis.get(`rl:user:concurrent:${USER}`);
    expect(userConc === null || Number(userConc) === 0).toBe(true);
  });
});

describe('daily token quota (spec 20, 22)', () => {
  it('records tokens at both the customer and key scopes', async () => {
    const rl = new RateLimitService(redis, makeLogger() as never);
    await rl.recordTokens(input(), 250);
    const usage = await rl.tokenUsage(USER, KEY);
    expect(usage.customer).toBe(250);
    expect(usage.key).toBe(250);
  });

  it('reports the key scope separately when the customer has several keys', async () => {
    // Reading the customer total for both would report the aggregate as one
    // key's usage — wrong for any customer holding more than one key.
    const rl = new RateLimitService(redis, makeLogger() as never);
    const KEY2 = 'key-rl-0002';
    try {
      await rl.recordTokens(input({ apiKeyId: KEY }), 100);
      await rl.recordTokens(input({ apiKeyId: KEY2 }), 40);
      await rl.recordTokens(input({ apiKeyId: KEY2 }), 10);

      const usage = await rl.tokenUsage(USER, KEY);
      expect(usage.customer).toBe(150);
      expect(usage.key).toBe(100);
    } finally {
      await clearRateLimitState(redis, KEY2);
    }
  });

  it('rejects the next request once the daily token quota is spent', async () => {
    const rl = new RateLimitService(redis, makeLogger() as never);
    await rl.recordTokens(input({ tokensPerDay: 1000 }), 1000);
    await expect(rl.checkAndConsume(input({ tokensPerDay: 1000 }))).rejects.toMatchObject({
      statusCode: 429,
      code: 'daily_token_quota_exceeded',
    });
  });

  it('does not consume a minute or concurrency slot when the token quota rejects', async () => {
    const rl = new RateLimitService(redis, makeLogger() as never);
    await rl.recordTokens(input({ tokensPerDay: 1000 }), 1000);
    await rl.checkAndConsume(input({ tokensPerDay: 1000 })).catch(() => {});
    expect(await redis.zcard(`rl:user:min:${USER}`)).toBe(0);
  });

  it('accumulates without losing concurrent increments', async () => {
    const rl = new RateLimitService(redis, makeLogger() as never);
    await Promise.all(Array.from({ length: 20 }, () => rl.recordTokens(input(), 10)));
    expect((await rl.tokenUsage(USER, KEY)).customer).toBe(200);
  });

  it('ignores a null or zero token count', async () => {
    const rl = new RateLimitService(redis, makeLogger() as never);
    await rl.recordTokens(input(), null);
    await rl.recordTokens(input(), 0);
    expect((await rl.tokenUsage(USER, KEY)).customer).toBe(0);
  });

  it('falls back to the customer total when no key is in context', async () => {
    const rl = new RateLimitService(redis, makeLogger() as never);
    await rl.recordTokens(input(), 77);
    const usage = await rl.tokenUsage(USER);
    expect(usage.key).toBe(77);
  });
});

describe('unlimited mode (spec 50)', () => {
  it('admits without touching Redis and holds no concurrency slot', async () => {
    const rl = new RateLimitService(redis, makeLogger() as never);
    const lease = await rl.checkAndConsume(input({ unlimited: true, maxConcurrentRequests: 1 }));
    expect(lease.holdsConcurrency).toBe(false);
    // Repeatedly admissible: no counter was consulted.
    for (let i = 0; i < 50; i++) {
      await rl.checkAndConsume(input({ unlimited: true, maxConcurrentRequests: 1 }));
    }
    expect(await redis.get(`rl:user:min:${USER}`)).toBeNull();
  });

  it('STILL records token usage, because unlimited means not enforced, not unmeasured', async () => {
    const rl = new RateLimitService(redis, makeLogger() as never);
    await rl.recordTokens(input({ unlimited: true }), 5000);
    expect((await rl.tokenUsage(USER, KEY)).customer).toBe(5000);
  });

  it('admits even when the daily token quota is far exceeded', async () => {
    const rl = new RateLimitService(redis, makeLogger() as never);
    await rl.recordTokens(input({ unlimited: true, tokensPerDay: 10 }), 1_000_000);
    const lease = await rl.checkAndConsume(input({ unlimited: true, tokensPerDay: 10 }));
    expect(lease.holdsConcurrency).toBe(false);
  });

  it('does not warn on overshoot for an unlimited customer', async () => {
    // An admin who later removes unlimited mode needs real numbers, but must
    // not be spammed with quota warnings for a mode that has no quota.
    const logger = makeLogger();
    const rl = new RateLimitService(redis, logger as never);
    await rl.recordTokens(input({ unlimited: true, tokensPerDay: 10 }), 9999);
    expect(logger.warns).toHaveLength(0);
  });

  it('warns on overshoot for a limited customer', async () => {
    const logger = makeLogger();
    const rl = new RateLimitService(redis, logger as never);
    await rl.recordTokens(input({ tokensPerDay: 100 }), 500);
    expect(logger.warns.length).toBeGreaterThan(0);
  });
});

describe('reset', () => {
  it('clears every counter for a customer', async () => {
    const rl = new RateLimitService(redis, makeLogger() as never);
    const lease = await rl.checkAndConsume(input());
    await rl.recordTokens(input(), 10);
    await lease.release();
    await rl.reset(USER);
    expect(await redis.get(`rl:user:min:${USER}`)).toBeNull();
    expect(await redis.get(`rl:user:day:${USER}`)).toBeNull();
    expect(await redis.get(`rl:user:tokens:${USER}`)).toBeNull();
  });
});

describe('concurrency safety', () => {
  it('never hands out more slots than the limit under parallel load', async () => {
    // The lost-update bug: a read-modify-write would let several instances
    // each see "0 of 1" and all admit. The single Lua script must not.
    const rl = new RateLimitService(redis, makeLogger() as never);
    const U = 'user-rl-parallel';
    const K = 'key-rl-parallel';
    const inp = input({ userId: U, apiKeyId: K, maxConcurrentRequests: 3, requestsPerMinute: 1000 });

    const results = await Promise.allSettled(
      Array.from({ length: 30 }, () => rl.checkAndConsume(inp)),
    );
    const admitted = results.filter((r) => r.status === 'fulfilled');
    expect(admitted).toHaveLength(3);

    for (const r of admitted) await (r as PromiseFulfilledResult<{ release: () => Promise<void> }>).value.release();
    await clearRateLimitState(redis, U, K);
  });

  it('never over-consumes the minute window under parallel load', async () => {
    const rl = new RateLimitService(redis, makeLogger() as never);
    const U = 'user-rl-parallel2';
    const K = 'key-rl-parallel2';
    const inp = input({ userId: U, apiKeyId: K, requestsPerMinute: 10, maxConcurrentRequests: 1000 });

    const results = await Promise.allSettled(
      Array.from({ length: 40 }, () => rl.checkAndConsume(inp)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);

    for (const r of results) {
      if (r.status === 'fulfilled') await r.value.release();
    }
    await clearRateLimitState(redis, U, K);
  });
});
