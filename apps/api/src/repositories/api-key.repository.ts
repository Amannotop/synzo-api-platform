import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '@synzo/database';
import { apiKeys, projects, users } from '@synzo/database';

export class ApiKeyRepository {
  constructor(private readonly db: Database) {}

  /**
   * Resolves a presented key to its owner in ONE indexed lookup.
   *
   * This is the only path used for authentication. Any miss — unknown hash,
   * revoked, disabled, expired, or a suspended owner — yields null, and the
   * caller converts that into a single indistinguishable 401. A suspended user
   * is included in the join so their keys stop working the moment they are
   * suspended (§6, §24).
   */
  async findValidKey(keyHash: string) {
    const rows = await this.db
      .select({
        keyId: apiKeys.id,
        userId: users.id,
        projectId: apiKeys.projectId,
        environment: apiKeys.environment,
        status: apiKeys.status,
        expiresAt: apiKeys.expiresAt,
        userStatus: users.status,
      })
      .from(apiKeys)
      .innerJoin(users, eq(apiKeys.userId, users.id))
      .where(eq(apiKeys.keyHash, keyHash))
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    if (row.status !== 'active') return null;
    if (row.userStatus !== 'active') return null;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
    return row;
  }

  /**
   * Best-effort `last_used_at` update. Throttled to at most once per key per
   * minute so a hot key does not issue a write on every request.
   */
  async touchLastUsed(keyId: string): Promise<void> {
    await this.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(and(eq(apiKeys.id, keyId), sql`${apiKeys.lastUsedAt} is null or ${apiKeys.lastUsedAt} < now() - interval '1 minute'`));
  }

  async create(input: {
    userId: string;
    projectId: string;
    name: string;
    keyPrefix: string;
    keyHash: string;
    environment: 'live' | 'test';
    expiresAt: Date | null;
  }) {
    const rows = await this.db.insert(apiKeys).values(input).returning();
    return rows[0] ?? null;
  }

  /** Scoped to a single customer: a foreign id simply does not match. */
  async listForUser(userId: string) {
    return this.db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        environment: apiKeys.environment,
        status: apiKeys.status,
        projectId: apiKeys.projectId,
        projectName: projects.name,
        lastUsedAt: apiKeys.lastUsedAt,
        expiresAt: apiKeys.expiresAt,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .innerJoin(projects, eq(apiKeys.projectId, projects.id))
      .where(eq(apiKeys.userId, userId))
      .orderBy(desc(apiKeys.createdAt));
  }

  async findOwned(userId: string, keyId: string) {
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async setStatus(userId: string, keyId: string, status: 'active' | 'disabled' | 'revoked') {
    const rows = await this.db
      .update(apiKeys)
      .set({
        status,
        revokedAt: status === 'revoked' ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId)))
      .returning({ id: apiKeys.id });
    return rows.length > 0;
  }

  async deleteOwned(userId: string, keyId: string): Promise<boolean> {
    const rows = await this.db
      .delete(apiKeys)
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId)))
      .returning({ id: apiKeys.id });
    return rows.length > 0;
  }

  /** Per-key request counts for the dashboard. Tenant-scoped. */
  async usageCountsForUser(userId: string) {
    return this.db
      .select({
        keyId: apiKeys.id,
        requests: sql<number>`coalesce((
          select count(*)::int from ${sql.identifier('requests')} r where r.api_key_id = ${apiKeys.id}
        ), 0)`,
      })
      .from(apiKeys)
      .where(eq(apiKeys.userId, userId));
  }
}
