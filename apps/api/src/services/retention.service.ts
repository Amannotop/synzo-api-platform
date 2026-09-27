import { sql } from 'drizzle-orm';
import type { AppConfig } from '@synzo/config';
import type { Database } from '@synzo/database';
import { rateLimits, requests } from '@synzo/database';
import type { Logger } from '../lib/logger.js';
import type { SessionRepository } from '../repositories/session.repository.js';
import type { AccountTokenService } from './account-token.service.js';

export interface RetentionDeps {
  config: AppConfig;
  logger: Logger;
  db: Database;
  sessions: SessionRepository;
  accountTokens: AccountTokenService;
}

export interface RetentionSweepResult {
  /** `requests` rows deleted, all of them older than the cutoff. */
  requestsDeleted: number;
  /** Sessions deleted because they had already expired. */
  sessionsDeleted: number;
  /** Account tokens deleted; spent and time-expired rows both count. */
  accountTokensDeleted: number;
  /** Daily rate-limit counters for days that can no longer be reported. */
  rateLimitsDeleted: number;
  /** The cutoff that was applied. */
  cutoff: Date;
  durationMs: number;
}

/**
 * How long to keep a spent account token before removing it entirely.
 *
 * A consumed token is already unusable, so this only governs how long an
 * incident trail of "this reset was requested and completed" survives.
 */
const SPENT_TOKEN_GRACE_DAYS = 7;

/** Rows per DELETE. Large enough to be quick, small enough to stay lock-free. */
const RETENTION_BATCH_SIZE = 5_000;

/**
 * Keeps the database from growing without bound.
 *
 * `requests` is the only table that grows with traffic — one row per customer
 * call, forever — and it was the one table with no pruning at all. The rest of
 * this is housekeeping on rows that are already dead weight: sessions past
 * their expiry cannot authenticate anyone, and account tokens that are
 * consumed or expired can never be redeemed again.
 *
 * What is deliberately NOT touched:
 *
 *  - `usage_daily`. It is the durable aggregate the dashboard and invoicing
 *    read from, and a `requests` row is only the raw material for it. Pruning
 *    the source must never change a number a customer has already been
 *    billed, so aggregates outlive the rows they were built from.
 *  - `audit_logs`. Small, and the record of who changed what.
 *  - rate-limit counters inside the retention window, since the dashboard can
 *    still ask about them.
 */
export class RetentionService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: RetentionDeps) {}

  /**
   * Deletes one bounded batch of each prunable table and reports the counts.
   *
   * The `requests` delete is a sub-select on the primary key rather than a
   * bare predicate: Postgres then removes exactly the ids listed, and the
   * table's foreign keys are checked against `batchSize` rows rather than
   * against everything that matches.
   */
  private async deleteBatch(cutoff: Date): Promise<Omit<RetentionSweepResult, 'durationMs'>> {
    const { db, sessions, accountTokens } = this.deps;

    /**
     * The cutoff is bound as an ISO string, not as a Date.
     *
     * A raw `sql` template hands its parameters straight to postgres.js, which
     * rejects a Date with "The \"string\" argument must be of type string or an
     * instance of Buffer or ArrayBuffer" before the query is ever sent. Drizzle's
     * own helpers (`lt`, `gt`, `eq`) serialize dates correctly, which is why
     * the other prunes worked and this one did not — it would have thrown on
     * every sweep, and the `requests` table would have grown forever, which is
     * the exact problem the retention job exists to solve.
     *
     * `created_at` is `timestamptz`, and Postgres parses an ISO 8601 string
     * into it unambiguously, including its offset.
     */
    const cutoffIso = cutoff.toISOString();
    const staleRequests = await db
      .delete(requests)
      .where(
        sql`${requests.id} in (
          select r.id from ${requests} r
          where r.created_at < ${cutoffIso}::timestamptz
          order by r.created_at asc
          limit ${RETENTION_BATCH_SIZE}
        )`,
      )
      .returning({ id: requests.id });

    const sessionsDeleted = await sessions.purgeExpired();

    // Expired tokens, plus consumed ones older than the grace window. Both are
    // unredeemable, so neither can interrupt a customer mid-flow.
    const accountTokensDeleted = await accountTokens.purgeStale(
      new Date(Date.now() - SPENT_TOKEN_GRACE_DAYS * 86_400_000),
    );

    // Daily counters for days the API can no longer report on.
    const rateLimitCutoff = new Date(
      Date.now() - this.deps.config.retention.requestDays * 86_400_000,
    );
    const rateLimitsDeleted = await this.deleteOldRateLimits(rateLimitCutoff);

    return {
      requestsDeleted: staleRequests.length,
      sessionsDeleted,
      accountTokensDeleted,
      rateLimitsDeleted,
      cutoff,
    };
  }

  /**
   * Deletes daily rate-limit counters for days the API can no longer report on.
   *
   * `day` is a `varchar` holding a YYYY-MM-DD string, not a date column, so
   * the comparison is on the string. The cast is explicit because without it
   * Postgres reads the right-hand side as a timestamp and rejects the whole
   * statement with "operator does not exist: character varying < timestamp" —
   * which made this sweep throw on every run rather than prune anything.
   *
   * An ISO date string sorts lexicographically in the same order it sorts
   * chronologically, so the string comparison is the correct one.
   */
  private async deleteOldRateLimits(cutoff: Date): Promise<number> {
    const day = cutoff.toISOString().slice(0, 10);
    const rows = await this.deps.db
      .delete(rateLimits)
      .where(sql`${rateLimits.day} < ${day}::text`)
      .returning({ id: rateLimits.id });
    return rows.length;
  }

  /**
   * Runs one full sweep. Safe to call directly — the timer calls it, and an
   * operator or a test can too.
   */
  async sweepNow(): Promise<RetentionSweepResult> {
    const startedAt = Date.now();
    const cutoff = new Date(
      Date.now() - this.deps.config.retention.requestDays * 86_400_000,
    );

    let totals = { requestsDeleted: 0, sessionsDeleted: 0, accountTokensDeleted: 0, rateLimitsDeleted: 0 };

    // A single broad DELETE can hold locks long enough to stall live traffic,
    // so rows go out in bounded batches until one comes back short.
    for (;;) {
      const batch = await this.deleteBatch(cutoff);
      totals = {
        requestsDeleted: totals.requestsDeleted + batch.requestsDeleted,
        sessionsDeleted: totals.sessionsDeleted + batch.sessionsDeleted,
        accountTokensDeleted: totals.accountTokensDeleted + batch.accountTokensDeleted,
        rateLimitsDeleted: totals.rateLimitsDeleted + batch.rateLimitsDeleted,
      };
      if (batch.requestsDeleted < RETENTION_BATCH_SIZE) break;
    }

    const result: RetentionSweepResult = { ...totals, cutoff, durationMs: Date.now() - startedAt };
    this.deps.logger.info('Retention sweep complete', {
      requestsDeleted: totals.requestsDeleted,
      sessionsDeleted: totals.sessionsDeleted,
      accountTokensDeleted: totals.accountTokensDeleted,
      rateLimitsDeleted: totals.rateLimitsDeleted,
      cutoff: cutoff.toISOString(),
      durationMs: result.durationMs,
    });
    return result;
  }

  start(): void {
    const { enabled, intervalMs } = this.deps.config.retention;
    if (!enabled || this.timer) return;
    this.timer = setInterval(() => void this.runGuarded(), intervalMs);
    // Never hold the event loop open for housekeeping: closing the app in a
    // test must not hang on this timer.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** A failed sweep must never kill the process, or silence every later one. */
  private async runGuarded(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.sweepNow();
    } catch (err) {
      this.deps.logger.error('Retention sweep failed', {
        error: err instanceof Error ? err.message : 'unknown',
      });
    } finally {
      this.running = false;
    }
  }
}
