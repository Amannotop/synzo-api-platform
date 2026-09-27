import { desc, eq, sql } from 'drizzle-orm';
import type { Database } from '@synzo/database';
import { auditLogs } from '@synzo/database';

/**
 * Structured audit trail for security-relevant actions (§49).
 * Never receives secrets — callers pass ids, names and counts only.
 */
export class AuditRepository {
  constructor(private readonly db: Database) {}

  async record(input: {
    actorUserId: string | null;
    action: string;
    resourceType?: string;
    resourceId?: string;
    metadata?: Record<string, unknown>;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<void> {
    await this.db.insert(auditLogs).values({
      actorUserId: input.actorUserId,
      action: input.action,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      ip: input.ip ?? null,
      userAgent: input.userAgent?.slice(0, 500) ?? null,
    });
  }

  async listForUser(actorUserId: string, limit = 100) {
    return this.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.actorUserId, actorUserId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit);
  }

  async listRecent(limit = 200) {
    return this.db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(limit);
  }
}
