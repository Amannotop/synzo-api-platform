import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '@synzo/database';
import { customerLimits, users, type CustomerLimits } from '@synzo/database';
import type { AppConfig } from '@synzo/config';

export class UserRepository {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {}

  async findByEmail(email: string) {
    return this.db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = lower(${email})`)
      .limit(1);
  }

  async findById(id: string) {
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async adminExists(): Promise<boolean> {
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, 'admin'))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Creates a user together with their default limits in one transaction, so a
   * customer can never exist without a limits row.
   *
   * The very first account becomes admin, which removes the chicken-and-egg
   * problem of having no way to reach the admin APIs. Once any admin exists
   * this no longer applies, so a later signup can never self-promote.
   */
  async create(input: {
    email: string;
    passwordHash: string;
    name: string;
  }): Promise<{ id: string; role: string }> {
    return this.db.transaction(async (tx) => {
      const [existingAdmin] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.role, 'admin'))
        .limit(1);

      const isFirstAdmin = !existingAdmin;
      const role = isFirstAdmin ? 'admin' : 'customer';

      const [created] = await tx
        .insert(users)
        .values({
          email: input.email,
          passwordHash: input.passwordHash,
          name: input.name,
          role,
          // The founding admin may mint live keys immediately; everyone else
          // needs an explicit grant.
          allowLiveKeys: isFirstAdmin ? this.config.features.allowLiveKeys : false,
        })
        .returning({ id: users.id, role: users.role });

      if (!created) throw new Error('Failed to create user');

      const d = this.config.defaults;
      await tx.insert(customerLimits).values({
        userId: created.id,
        requestsPerMinute: d.requestsPerMinute,
        requestsPerDay: d.requestsPerDay,
        tokensPerDay: d.tokensPerDay,
        maxConcurrentRequests: d.maxConcurrentRequests,
      });

      return { id: created.id, role: created.role };
    });
  }

  async touchLastLogin(id: string): Promise<void> {
    await this.db.update(users).set({ lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(users.id, id));
  }

  async updatePassword(id: string, passwordHash: string): Promise<void> {
    await this.db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, id));
  }

  async markEmailVerified(id: string): Promise<void> {
    await this.db
      .update(users)
      .set({ emailVerified: true, updatedAt: new Date() })
      .where(eq(users.id, id));
  }

  async updateStatus(id: string, status: 'active' | 'suspended'): Promise<void> {
    await this.db.update(users).set({ status, updatedAt: new Date() }).where(eq(users.id, id));
  }

  async updateAdminFields(
    id: string,
    fields: { unlimitedMode?: boolean; allowLiveKeys?: boolean; role?: 'customer' | 'admin' },
  ): Promise<void> {
    await this.db
      .update(users)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(users.id, id));
  }

  async listCustomers(limit = 100, offset = 0) {
    return this.db.select().from(users).orderBy(sql`${users.createdAt} desc`).limit(limit).offset(offset);
  }

  async countCustomers(): Promise<number> {
    const rows = await this.db.select({ n: sql<number>`count(*)::int` }).from(users);
    return rows[0]?.n ?? 0;
  }

  /**
   * Effective limits for a customer: their own row, falling back to platform
   * defaults if the row is somehow absent.
   */
  async getLimits(userId: string): Promise<CustomerLimits> {
    const rows = await this.db
      .select()
      .from(customerLimits)
      .where(eq(customerLimits.userId, userId))
      .limit(1);
    const row = rows[0];
    const d = this.config.defaults;
    // Both branches return the full table row shape so callers never have to
    // handle a partially-shaped fallback.
    return (
      row ?? {
        userId,
        requestsPerMinute: d.requestsPerMinute,
        requestsPerDay: d.requestsPerDay,
        tokensPerDay: d.tokensPerDay,
        maxConcurrentRequests: d.maxConcurrentRequests,
        allowedModels: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
    );
  }

  async updateLimits(
    userId: string,
    fields: Partial<{
      requestsPerMinute: number;
      requestsPerDay: number;
      tokensPerDay: number;
      maxConcurrentRequests: number;
      allowedModels: string | null;
    }>,
  ): Promise<void> {
    await this.db
      .update(customerLimits)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(customerLimits.userId, userId));
  }

  /** The customer and their project, verified together in a single query. */
  async getUserWithProject(userId: string, projectId: string) {
    const { projects } = await import('@synzo/database');
    return this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .limit(1);
  }
}
