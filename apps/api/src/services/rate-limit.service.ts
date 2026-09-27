import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Logger } from '../lib/logger.js';
import type { HttpError} from '../lib/errors.js';
import { quotaExceeded, rateLimited } from '../lib/errors.js';
import type { Metrics } from '../metrics/registry.js';

export interface RateLimitInput {
  userId: string;
  apiKeyId: string;
  requestsPerMinute: number;
  requestsPerDay: number;
  tokensPerDay: number;
  maxConcurrentRequests: number;
  /** true when the customer has admin-granted unlimited mode (§50). */
  unlimited: boolean;
}

/**
 * The handle returned by an admission. Release is idempotent, so a streaming
 * path that both finishes normally and trips a client-disconnect abort cannot
 * give back a concurrency slot twice.
 */
export interface AdmissionLease {
  /** True only when a concurrency slot was actually taken and is owed back. */
  readonly holdsConcurrency: boolean;
  release(): Promise<void>;
}

export type RateLimitScope = 'user' | 'key';

export interface TokenUsage {
  customer: number;
  key: number;
}

interface ScopeTarget {
  scope: RateLimitScope;
  concurrencyKey: string;
  minuteKey: string;
  dayKey: string;
  tokenKey: string;
}

/**
 * Sliding-window rate limiting backed by Valkey/Redis.
 *
 * Every limit is enforced at BOTH scopes (§21 requires per-customer *and*
 * per-API-key limiting):
 *
 *  - `user:<id>` counts aggregate traffic across all of a customer's keys.
 *  - `key:<id>`  counts traffic for one key.
 *
 * Both are checked against the same configured customer limit, so holding
 * several keys never multiplies a customer's allowance — it only isolates one
 * key's traffic from another's in the dashboard.
 *
 * A minute window is a ZSET of request timestamps; daily counters are plain
 * integers with a midnight-UTC expiry. Daily token usage is written after a
 * response is known and read back before admitting the next request, which is
 * what makes the token quota a real limit rather than an after-the-fact log
 * line.
 *
 * WHY A SINGLE MULTI-SCOPE LUA SCRIPT
 * ----------------------------------
 * Admission used to be a read-modify-write sequence run in application code,
 * and then briefly a separate atomic script per scope. Both have defects that
 * only show up under load:
 *
 *  1. Partial consumption. The minute window and the daily counter are
 *     separate commands. If the customer scope admits and the key scope then
 *     rejects, the customer's minute window and daily counter have already
 *     been consumed. Handing those back from application code races other
 *     requests: a naive rollback can delete a ZSET entry that a different
 *     request owns. A rejected request would permanently consume allowance.
 *  2. Lost updates. Two app instances both read "59 of 60 used" and both
 *     admit, handing the 61st slot away.
 *
 * `ADMIT_LUA` therefore takes BOTH scopes' keys in one call and does the whole
 * check-and-consume atomically. It is written so that every rejection branch
 * restores every counter it touched, across both scopes. The net state after a
 * rejection is byte-identical to the state before the call, so there is nothing
 * to compensate for and nothing to race.
 */
export class RateLimitService {
  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
    /**
     * Optional so a caller that only needs enforcement (a one-off script, a
     * narrow test) does not have to construct a registry. When present, a
     * rejection is counted by which limit fired — the number that answers
     * "is this customer being throttled, or is the platform slow?".
     */
    private readonly metrics?: Metrics,
  ) {}

  /* ------------------------------------------------------------ key naming */

  private target(scope: RateLimitScope, id: string): ScopeTarget {
    return {
      scope,
      concurrencyKey: `rl:${scope}:concurrent:${id}`,
      minuteKey: `rl:${scope}:min:${id}`,
      dayKey: `rl:${scope}:day:${id}`,
      tokenKey: `rl:${scope}:tokens:${id}`,
    };
  }

  /**
   * The two scopes, always in customer-then-key order. Typed as a tuple so
   * callers can destructure without the elements being `| undefined`.
   */
  private targetsFor(input: RateLimitInput): readonly [ScopeTarget, ScopeTarget] {
    return [this.target('user', input.userId), this.target('key', input.apiKeyId)] as const;
  }

  /** How long a concurrency counter may outlive the last release. */
  private static readonly CONCURRENCY_TTL_SEC = 900;

  private static secondsUntilUtcMidnight(now: Date): number {
    const next = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      0,
      0,
    );
    return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
  }

  /* ----------------------------------------------------------------- Lua */

  /**
   * Atomic check-and-consume across BOTH scopes in a single call.
   *
   * KEYS (6, grouped by scope):
   *   1 customer concurrency   2 customer minute window   3 customer daily count
   *   4 key      concurrency   5 key      minute window   6 key      daily count
   *
   * ARGV:
   *   1 concLimit  2 concTtl  3 minuteLimit  4 nowMs  5 windowMs
   *   6 dayLimit   7 dayTtl   8 member
   *
   * Returns { allowed, reason, resetSec } where reason is one of
   *   'ok' | 'concurrency' | 'day' | 'minute'
   *
   * Order is deliberate. Concurrency is claimed first because a request that
   * cannot get a slot should not also write a rate-limit record. The daily
   * quota is checked before the minute window because it is a single O(1)
   * INCR, so a customer who is out of daily requests is rejected in constant
   * time rather than paying for a ZSET trim on every attempt.
   *
   * Scopes are processed customer-then-key so the reported reason is the one
   * a customer can act on (their own aggregate limit) when both are breached.
   *
   * Every rejection branch undoes its own increments before returning, so the
   * script is all-or-nothing across both scopes by construction.
   */
  private static readonly ADMIT_LUA = `
    local concLimit   = tonumber(ARGV[1])
    local concTtl     = tonumber(ARGV[2])
    local minuteLimit = tonumber(ARGV[3])
    local now         = tonumber(ARGV[4])
    local window      = tonumber(ARGV[5])
    local dayLimit    = tonumber(ARGV[6])
    local dayTtl      = tonumber(ARGV[7])
    local member      = ARGV[8]

    local touched = {}
    local ntouched = 0
    local minuteMembers = {}
    local nminuteMembers = 0

    -- Claim at a scope, undoing the claim if that scope is over budget.
    -- Returns allowed(0/1), reason, resetSec.
    local function claim(concKey, minuteKey, dayKey)
      local conc = redis.call('INCR', concKey)
      if conc == 1 then redis.call('EXPIRE', concKey, concTtl) end
      touched[ntouched + 1] = concKey
      ntouched = ntouched + 1
      if conc > concLimit then
        return 0, 'concurrency', 1
      end

      local dayCount = redis.call('INCR', dayKey)
      if dayCount == 1 then redis.call('EXPIRE', dayKey, dayTtl) end
      touched[ntouched + 1] = dayKey
      ntouched = ntouched + 1
      if dayCount > dayLimit then
        return 0, 'day', dayTtl
      end

      redis.call('ZREMRANGEBYSCORE', minuteKey, '-inf', now - window)
      local minuteCount = redis.call('ZCARD', minuteKey)
      if minuteCount >= minuteLimit then
        local reset = math.ceil(window / 1000)
        local oldest = redis.call('ZRANGE', minuteKey, 0, 0, 'WITHSCORES')
        if oldest[2] then
          reset = math.ceil((tonumber(oldest[2]) + window - now) / 1000)
        end
        return 0, 'minute', reset
      end
      redis.call('ZADD', minuteKey, now, member)
      minuteMembers[nminuteMembers + 1] = minuteKey
      nminuteMembers = nminuteMembers + 1
      redis.call('PEXPIRE', minuteKey, window)
      return 1, 'ok', 0
    end

    -- Release every counter this script consumed. Clamped at zero and the
    -- key deleted when it empties, so a rollback can never drive a counter
    -- negative and later over-admit.
    local function rollback()
      -- Minute windows first: an entry added at the first scope must not
      -- survive the rejection of the second. The member is unique to this
      -- call, so removing it can never drop another request's entry.
      for i = 1, nminuteMembers do
        redis.call('ZREM', minuteMembers[i], member)
      end
      for i = 1, ntouched do
        local key = touched[i]
        local cur = redis.call('GET', key)
        if cur then
          local n = tonumber(cur)
          if n and n <= 1 then
            redis.call('DEL', key)
          else
            redis.call('DECR', key)
          end
        end
      end
    end

    local ok1, reason1, reset1 = claim(KEYS[1], KEYS[2], KEYS[3])
    if ok1 ~= 1 then
      rollback()
      return {0, reason1, reset1}
    end

    local ok2, reason2, reset2 = claim(KEYS[4], KEYS[5], KEYS[6])
    if ok2 ~= 1 then
      -- The customer scope was admitted but the key scope was not: unwind
      -- BOTH, so a rejection cannot strand one scope while the other still
      -- holds counters it took during this same call.
      rollback()
      return {0, reason2, reset2}
    end

    return {1, 'ok', 0}
  `;

  /**
   * Concurrency release, clamped at zero.
   *
   * A plain DECR would let an unbalanced release drive the counter negative,
   * which in turn would grant more than `max_concurrent_requests` for the rest
   * of the key's TTL. Clamping (and deleting a key that has hit zero) keeps
   * the counter an accurate count of in-flight requests.
   */
  private static readonly CONCURRENT_RELEASE_LUA = `
    local key = KEYS[1]
    local cur = tonumber(redis.call('GET', key) or '0')
    if cur <= 1 then
      redis.call('DEL', key)
      return 0
    end
    return redis.call('DECR', key)
  `;

  /**
   * Adds token usage to a daily counter in one atomic step and returns the
   * resulting value, so two concurrent completions cannot both read the same
   * "used" figure and lose one increment. The TTL is stamped when the counter
   * is created, which is what makes the counter roll over at UTC midnight.
   */
  private static readonly TOKEN_ADD_LUA = `
    local key = KEYS[1]
    local amount = tonumber(ARGV[1])
    local ttl = tonumber(ARGV[2])
    local used = redis.call('INCRBY', key, amount)
    if used == amount then redis.call('EXPIRE', key, ttl) end
    return used
  `;

  /* ------------------------------------------------------------- admission */

  /**
   * Checks every limit and, on success, returns a lease holding the
   * concurrency slots taken at both scopes.
   *
   * The daily token quota is a pure read and is checked FIRST, before anything
   * is consumed. A customer who is out of tokens must not also burn a minute
   * slot and a daily request slot on every rejected request.
   *
   * `unlimited` customers skip every check (§50) and receive a lease that owes
   * nothing back. Their usage is still RECORDED by `recordTokens` — unlimited
   * means "not enforced", not "not measured".
   */
  async checkAndConsume(input: RateLimitInput): Promise<AdmissionLease> {
    if (input.unlimited) return NO_LEASE;

    const now = new Date();
    const nowMs = now.getTime();
    const ttlDay = RateLimitService.secondsUntilUtcMidnight(now);
    const [user, key] = this.targetsFor(input);

    // --- 1. daily token quota (read-only, cheapest to reject on) ---
    if (input.tokensPerDay > 0) {
      const reads = await Promise.all(
        [user.tokenKey, key.tokenKey].map(async (tokenKey) => {
          const raw = await this.redis.get(tokenKey);
          const n = Number(raw ?? 0);
          return Number.isFinite(n) ? n : 0;
        }),
      );
      if (reads.some((used) => used >= input.tokensPerDay)) {
        this.metrics?.rateLimitRejections.inc({ scope: 'daily_tokens' });
        throw quotaExceeded('Daily token quota exceeded', 'daily_token_quota_exceeded');
      }
    }

    // --- 2. consume both scopes atomically ---
    // A unique member keeps two requests in the same millisecond from
    // colliding in the ZSET and undercounting the window.
    const member = `${nowMs}-${randomUUID()}`;

    const res = (await this.redis.eval(
      RateLimitService.ADMIT_LUA,
      6,
      user.concurrencyKey,
      user.minuteKey,
      user.dayKey,
      key.concurrencyKey,
      key.minuteKey,
      key.dayKey,
      String(input.maxConcurrentRequests),
      String(RateLimitService.CONCURRENCY_TTL_SEC),
      String(input.requestsPerMinute),
      String(nowMs),
      '60000',
      String(input.requestsPerDay),
      String(ttlDay),
      member,
    )) as [number, string, number];

    if (res[0] !== 1) {
      // The Lua script names the limit that fired, so the counter is as
      // specific as the customer-facing error.
      this.metrics?.rateLimitRejections.inc({ scope: this.rejectionScope(res[1]) });
      throw this.toHttpError(res[1], res[2]);
    }

    let released = false;
    return {
      holdsConcurrency: true,
      release: async () => {
        // Idempotent: a stream that both completes and aborts releases once.
        if (released) return;
        released = true;
        await this.releaseAll([user, key]);
      },
    };
  }

  /**
   * The metric label for a rejection reason. Kept aligned with `toHttpError`:
   * a new branch in one without the other silently produces an unlabelled or
   * mislabelled counter.
   */
  private rejectionScope(reason: string): string {
    switch (reason) {
      case 'concurrency':
        return 'concurrency';
      case 'day':
        return 'daily_requests';
      case 'minute':
        return 'per_minute';
      default:
        return 'unknown';
    }
  }

  private toHttpError(reason: string, resetSec: number): HttpError {
    switch (reason) {
      case 'concurrency':
        return rateLimited('Too many concurrent requests', 1);
      case 'day':
        return quotaExceeded('Daily request quota exceeded', 'daily_request_quota_exceeded');
      case 'minute':
        return rateLimited('Rate limit exceeded (requests per minute)', resetSec || 60);
      default:
        return rateLimited('Rate limit exceeded');
    }
  }

  private async releaseAll(targets: ScopeTarget[]): Promise<void> {
    for (const t of targets) {
      try {
        await this.redis.eval(RateLimitService.CONCURRENT_RELEASE_LUA, 1, t.concurrencyKey);
      } catch (err) {
        this.logger.error('Failed to release concurrency slot', {
          scope: t.scope,
          error: err instanceof Error ? err.message : 'unknown',
        });
      }
    }
  }

  /**
   * Releases the concurrency slots for a key and, when the owner is known, for
   * the customer too. Prefer the lease returned by `checkAndConsume`; this
   * exists for recovery paths that hold only ids.
   */
  async releaseConcurrency(apiKeyId: string, userId?: string): Promise<void> {
    const targets = [this.target('key', apiKeyId)];
    if (userId) targets.push(this.target('user', userId));
    await this.releaseAll(targets);
  }

  /* --------------------------------------------------------------- tokens */

  /**
   * Adds real token usage to the daily counters at both scopes. Called after
   * the upstream response is known; it rejects nothing, so a failure here is
   * logged but never fails a customer request that already succeeded.
   *
   * Unlimited customers are counted too. Their quota is not ENFORCED, but the
   * dashboard and the database rollup must still show what they consumed, and
   * an admin who later removes unlimited mode needs real numbers to set a
   * limit against.
   */
  async recordTokens(input: RateLimitInput, totalTokens: number | null): Promise<void> {
    if (totalTokens === null || totalTokens <= 0) return;
    const ttl = RateLimitService.secondsUntilUtcMidnight(new Date());

    for (const t of this.targetsFor(input)) {
      try {
        const used = (await this.redis.eval(
          RateLimitService.TOKEN_ADD_LUA,
          1,
          t.tokenKey,
          String(Math.round(totalTokens)),
          String(ttl),
        )) as number;

        // Exceeding is only a warning: enforcement already happened at
        // admission, so this is reporting an overshoot, not refusing a request.
        if (!input.unlimited && input.tokensPerDay > 0 && used > input.tokensPerDay) {
          this.logger.warn('Customer exceeded daily token quota', {
            userId: input.userId,
            apiKeyId: input.apiKeyId,
            scope: t.scope,
            used,
            limit: input.tokensPerDay,
          });
        }
      } catch (err) {
        this.logger.error('Failed to record token usage', {
          scope: t.scope,
          error: err instanceof Error ? err.message : 'unknown',
        });
      }
    }
  }

  /**
   * Current daily token usage, for the dashboard and diagnostics.
   *
   * Each scope is read from its OWN counter. Reading the customer's total for
   * both would report the aggregate as the single key's usage, which is wrong
   * for any customer holding more than one key.
   */
  async tokenUsage(userId: string, apiKeyId?: string): Promise<TokenUsage> {
    const [customerRaw, keyRaw] = await Promise.all([
      this.redis.get(this.target('user', userId).tokenKey),
      apiKeyId
        ? this.redis.get(this.target('key', apiKeyId).tokenKey)
        : Promise.resolve<string | null>(null),
    ]);

    const toNumber = (v: string | null): number => {
      const n = Number(v ?? 0);
      return Number.isFinite(n) ? n : 0;
    };

    const customer = toNumber(customerRaw);
    return {
      customer,
      // With no key in context the customer total is the only figure there
      // is; reporting it for both keeps callers from inventing a split.
      key: apiKeyId ? toNumber(keyRaw) : customer,
    };
  }

  /**
   * Clears every counter for a customer (and optionally one key). Used by the
   * admin limits endpoint when quotas are raised or reset, and by the test
   * suite so a case does not inherit the previous case's consumption.
   */
  async reset(userId: string, apiKeyId?: string): Promise<void> {
    const targets = [this.target('user', userId)];
    if (apiKeyId) targets.push(this.target('key', apiKeyId));
    for (const t of targets) {
      await this.redis.del(t.minuteKey, t.dayKey, t.tokenKey, t.concurrencyKey);
    }
  }
}

/** Unlimited customers are admitted without touching Redis at all. */
const NO_LEASE: AdmissionLease = {
  holdsConcurrency: false,
  release: async () => {},
};
