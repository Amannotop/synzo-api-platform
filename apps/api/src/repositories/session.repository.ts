import { and, eq, gt, lt } from 'drizzle-orm';
import type { Database } from '@synzo/database';
import { sessions, users } from '@synzo/database';

/**
 * Server-side sessions. Only a SHA-256 of the token is stored, so a database
 * read cannot be replayed as a valid session cookie (§8, §31).
 */
export class SessionRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    userId: string;
    tokenHash: string;
    userAgent: string | null;
    ip: string | null;
    expiresAt: Date;
  }) {
    const rows = await this.db.insert(sessions).values(input).returning({ id: sessions.id });
    return rows[0] ?? null;
  }

  /** Resolves a live session to its user, refusing suspended accounts. */
  async resolve(tokenHash: string) {
    const rows = await this.db
      .select({
        sessionId: sessions.id,
        userId: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        status: users.status,
        unlimitedMode: users.unlimitedMode,
        allowLiveKeys: users.allowLiveKeys,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())))
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    /**
     * Suspended accounts lose their session immediately, so an operator's
     * suspension takes effect without waiting for a cookie to expire.
     *
     * Pending and rejected are NOT filtered out here. Both are states the
     * customer has to be able to read: the spec requires the approval status to
     * be visible in their dashboard and the paywall to be reachable, and
     * refusing the session would make an applicant unable to see anything at
     * all. The real gate on spending credits is the API-key path.
     */
    if (row.status === 'suspended') return null;
    return row;
  }

  async destroy(tokenHash: string): Promise<boolean> {
    const rows = await this.db
      .delete(sessions)
      .where(eq(sessions.tokenHash, tokenHash))
      .returning({ id: sessions.id });
    return rows.length > 0;
  }

  async destroyAllForUser(userId: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.userId, userId));
  }

  async purgeExpired(): Promise<number> {
    const rows = await this.db
      .delete(sessions)
      .where(lt(sessions.expiresAt, new Date()))
      .returning({ id: sessions.id });
    return rows.length;
  }
}
