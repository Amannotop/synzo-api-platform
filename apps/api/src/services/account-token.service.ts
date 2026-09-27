import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { AppConfig } from '@synzo/config';
import type { Database } from '@synzo/database';
import { accountTokens, users } from '@synzo/database';
import type { Logger } from '../lib/logger.js';
import type { AccountTokenPurpose } from './account-token.types.js';

export interface IssuedToken {
  /** The raw token. Returned once, to be emailed. Never stored. */
  raw: string;
  expiresAt: Date;
}

export interface AccountTokenServiceDeps {
  db: Database;
  config: AppConfig;
  logger: Logger;
  /**
   * Hands the raw token to the customer. In production this sends an email;
   * in development and test it returns the token so the flow is exercisable
   * without a mail server. It must never be logged.
   */
  deliver: (args: {
    userId: string;
    email: string;
    purpose: AccountTokenPurpose;
    raw: string;
    expiresAt: Date;
    /**
     * The public origin this request arrived on, resolved from the request
     * unless the operator pinned one. Passed in rather than looked up from
     * config so the link matches whichever domain the customer is using.
     */
    publicOrigin: string;
  }) => Promise<void>;
}

/** Expiry windows: long enough to be usable, short enough to limit exposure. */
const TTL_MINUTES: Record<AccountTokenPurpose, number> = {
  password_reset: 60,
  email_verification: 24 * 60,
};

/**
 * Issues and consumes the one-time tokens behind password reset and email
 * verification (§8).
 *
 * Design points that matter for security:
 *
 *  - Only the SHA-256 digest is persisted. A dump of the table yields no
 *    working reset links.
 *  - Issuing a new token revokes every outstanding one for the same purpose,
 *    so the most recent request is always the only valid one.
 *  - Consumption is a single conditional UPDATE ... WHERE consumed_at IS NULL,
 *    which makes a double-submit race resolve to exactly one winner rather
 *    than two.
 *  - Requesting a reset for an unknown address does not create anything, and
 *    the caller responds identically either way, so this endpoint cannot be
 *    used to enumerate registered emails.
 */
export class AccountTokenService {
  constructor(private readonly deps: AccountTokenServiceDeps) {}

  private hash(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  async issue(
    user: { id: string; email: string },
    purpose: AccountTokenPurpose,
    meta: { ip: string | null; userAgent: string | null; publicOrigin: string },
  ): Promise<IssuedToken> {
    // Any earlier outstanding token for this purpose is now superseded.
    await this.deps.db
      .update(accountTokens)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(accountTokens.userId, user.id),
          eq(accountTokens.purpose, purpose),
          isNull(accountTokens.consumedAt),
        ),
      );

    const raw = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + TTL_MINUTES[purpose] * 60_000);

    await this.deps.db.insert(accountTokens).values({
      userId: user.id,
      tokenHash: this.hash(raw),
      purpose,
      expiresAt,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    await this.deps.deliver({
      userId: user.id,
      email: user.email,
      purpose,
      raw,
      expiresAt,
      publicOrigin: meta.publicOrigin,
    });

    this.deps.logger.info('Account token issued', {
      userId: user.id,
      purpose,
      expiresAt: expiresAt.toISOString(),
    });

    return { raw, expiresAt };
  }

  /**
   * Atomically consumes a token, returning the user it belongs to.
   *
   * Returns null for an unknown, already-used, expired, or wrong-purpose
   * token — all four are indistinguishable to the caller, so probing cannot
   * tell a valid token from an invalid one.
   */
  async consume(
    raw: string,
    purpose: AccountTokenPurpose,
  ): Promise<{ userId: string; email: string } | null> {
    const rows = await this.deps.db
      .update(accountTokens)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(accountTokens.tokenHash, this.hash(raw)),
          eq(accountTokens.purpose, purpose),
          isNull(accountTokens.consumedAt),
          sql`${accountTokens.expiresAt} > now()`,
        ),
      )
      .returning({ userId: accountTokens.userId });

    const row = rows[0];
    if (!row) return null;

    const found = await this.deps.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1);

    const user = found[0];
    return user ? { userId: user.id, email: user.email } : null;
  }

  /** Removes rows that expired long ago. Safe to call on a timer. */
  async purgeExpired(olderThan: Date): Promise<number> {
    const rows = await this.deps.db
      .delete(accountTokens)
      .where(sql`${accountTokens.expiresAt} < ${olderThan}`)
      .returning({ id: accountTokens.id });
    return rows.length;
  }
}
