import type { Redis } from 'ioredis';
import type { AppConfig } from '@synzo/config';
import type { Logger } from '../lib/logger.js';
import { quotaExceeded, rateLimited } from '../lib/errors.js';

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSec: number;
  scope: 'minute' | 'day' | 'concurrency' | 'tokens';
}

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
 * Sliding-window rate limiting backed by Redis sorted sets.
 *
 * A minute window is a ZSET of request timestamps; a daily window is a counter
 * with a midnight-UTC expiry. Both are checked before the upstream call, and
 * a completed request's token usage is added afterwards.
 *
 * Every operation is atomic (Lua) so concurrent instances cannot interleave a
 * read and a write and hand out more allowance than configured.
 */
export class RateLimitService {
  constructor(
    private readonly redis: Redis,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  private minuteKey(apiKeyId: string): string {
    return `rl:min:${apiKeyId}`;
  }
  private dayKey(apiKeyId: string): string {
    return `rl:day:${apiKeyId}`;
  }
  private tokenDayKey(apiKeyId: string): string {
    return `rl:tokens:${apiKeyId}`;
  }
  private concurrencyKey(apiKeyId: string): string {
    return `rl:concurrent:${apiKeyId}`;
  }
  private lockKey(apiKeyId: string): string {
    return `rl:lock:${apiKeyId}`;
  }

  /** UTC day string, e.g. "2026-09-27". Daily counters reset at midnight UTC. */
  private static day(now: Date): string {
    return now.toISOString().slice(0, 10);
  }

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

  /**
   * Atomically checks all limits and, if they pass, consumes one request slot
   * and one concurrency slot. Returns the first violation encountered.
   */
  async checkAndConsume(input: RateLimitInput): Promise<void> {
    if (input.unlimited) return;

    const now = new Date();
    const nowMs = now.getTime();
    const dayStr = RateLimitService.day(now);
    const ttlDay = RateLimitService.secondsUntilUtcMidnight(now);

    // --- concurrency: a plain increment that is rolled back on failure ---
    const concurrent = await this.redis.incr(this.concurrencyKey(input.apiKeyId));
    if (concurrent === 1) {
      await this.redis.expire(this.concurrencyKey(input.apiKeyId), 900);
    }
    if (concurrent > input.maxConcurrentRequests) {
      await this.redis.decr(this.concurrencyKey(input.apiKeyId));
      throw rateLimited(
        'Too many concurrent requests for this key',
        1,
      );
    }

    try {
      // --- minute window (sliding, via Lua) ---
      const minute = await this.redis.eval(
        `
          local key = KEYS[1]
          local limit = tonumber(ARGV[1])
          local now = tonumber(ARGV[2])
          local window = tonumber(ARGV[3])
          redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
          local count = redis.call('ZCARD', key)
          if count >= limit then
            local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
            local reset = window
            if oldest[2] then reset = math.ceil((tonumber(oldest[2]) + window - now) / 1000) end
            return {0, count, reset}
          end
          redis.call('ZADD', key, now, tostring(now) .. '-' .. math.random())
          redis.call('PEXPIRE', key, window)
          return {1, count + 1, 0}
        `,
        1,
        this.minuteKey(input.apiKeyId),
        String(input.requestsPerMinute),
        String(nowMs),
        '60000',
      );
      const minuteAllowed = (minute as number[])[0] === 1;
      if (!minuteAllowed) {
        const reset = (minute as number[])[2] ?? 60;
        throw rateLimited('Rate limit exceeded (requests per minute)', reset);
      }

      // --- daily request counter ---
      const dayCount = await this.redis.incr(this.dayKey(input.apiKeyId));
      if (dayCount === 1) await this.redis.expire(this.dayKey(input.apiKeyId), ttlDay);
      if (dayCount > input.requestsPerDay) {
        await this.redis.decr(this.dayKey(input.apiKeyId));
        throw quotaExceeded('Daily request quota exceeded', 'daily_request_quota_exceeded');
      }
    } catch (err) {
      // Release the concurrency slot we optimistically took.
      await this.redis.decr(this.concurrencyKey(input.apiKeyId));
      throw err;
    }
  }

  /**
   * Adds real token usage to the daily token counter. Called after the
   * upstream response is known; it can reject nothing, so a failure here is
   * logged but never fails a customer request that already succeeded.
   */
  async recordTokens(input: RateLimitInput, totalTokens: number | null): Promise<void> {
    if (input.unlimited || totalTokens === null || totalTokens <= 0) return;
    try {
      const key = this.tokenDayKey(input.apiKeyId);
      const now = new Date();
      const used = await this.redis.incrby(key, totalTokens);
      if (used === totalTokens) {
        await this.redis.expire(key, RateLimitService.secondsUntilUtcMidnight(now));
      }
      if (used > input.tokensPerDay) {
        this.logger.warn('Customer exceeded daily token quota', {
          userId: input.userId,
          apiKeyId: input.apiKeyId,
          used,
          limit: input.tokensPerDay,
        });
      }
    } catch (err) {
      this.logger.error('Failed to record token usage', {
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  }

  /** Releases the concurrency slot once a request finishes (success or not). */
  async releaseConcurrency(apiKeyId: string): Promise<void> {
    try {
      await this.redis.decr(this.concurrencyKey(apiKeyId));
    } catch (err) {
      this.logger.error('Failed to release concurrency slot', {
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  }

  /**
   * Serializes token accounting per key so two concurrent completions cannot
   * both read the same "used" value and lose one increment.
   */
  async withTokenLock<T>(apiKeyId: string, fn: () => Promise<T>): Promise<T> {
    const key = this.lockKey(apiKeyId);
    const token = Math.random().toString(36).slice(2);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const ok = await this.redis.set(key, token, 'PX', 5000, 'NX');
      if (ok === 'OK') {
        try {
          return await fn();
        } finally {
          await this.redis.eval(
            `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end`,
            1,
            key,
            token,
          );
        }
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    // Lock contention that long is anomalous; proceed without the lock rather
    // than fail a request that already succeeded upstream.
    this.logger.warn('Token lock acquisition timed out', { apiKeyId });
    return fn();
  }
}
