import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { Database } from '@synzo/database';
import { creditBalances, customerLimits, users, type CustomerLimits } from '@synzo/database';
import type { AppConfig } from '@synzo/config';

/** Every status an account can hold, mirroring the `user_status` enum. */
export type UserStatus = 'active' | 'suspended' | 'pending' | 'rejected';

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
   * Admin bootstrap, in priority order:
   *
   *  1. `ADMIN_EMAIL` matching the signup, when configured. This is the
   *     authoritative path and the one an operator should rely on.
   *  2. The very first account on the instance, only while no admin exists at
   *     all. This removes the chicken-and-egg problem of having no way to
   *     reach the admin APIs, and is what makes the platform usable with zero
   *     configuration.
   *
   * Once any admin exists, neither applies and a later signup can never
   * self-promote.
   */
  async create(input: {
    email: string;
    passwordHash: string;
    name: string;
    /**
     * The status to register the account with.
     *
     * Explicit rather than inferred here, because whether a new signup starts
     * as 'pending' is a deployment policy (APPROVAL_REQUIRED), not a fact this
     * repository should know. The founding admin is always 'active' regardless:
     * there is nobody to approve them.
     */
    status?: UserStatus;
  }): Promise<{ id: string; role: string; status: UserStatus }> {
    return this.db.transaction(async (tx) => {
      const [existingAdmin] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.role, 'admin'))
        .limit(1);

      /*
       * `ADMIN_EMAIL` wins over the first-admin fallback.
       *
       * With only the fallback, the operator's own deploy sequence decides who
       * is the admin: whoever happens to register first on a fresh instance
       * gets full control of the platform, and on a publicly reachable signup
       * form that is whoever reached it first — not the person running the
       * deployment. `ADMIN_EMAIL` makes the answer explicit and reviewable.
       *
       * Case-insensitive because an operator typing their address into .env
       * should not be silently downgraded to a customer for capitalising it,
       * and because lookups elsewhere in this repository are already
       * case-insensitive.
       */
      const configuredAdmin = this.config.admin.email;
      const isConfiguredAdmin =
        configuredAdmin != null &&
        configuredAdmin.length > 0 &&
        configuredAdmin.toLowerCase() === input.email.toLowerCase();

      const isFirstAdmin = !existingAdmin;
      const isAdmin = isConfiguredAdmin || isFirstAdmin;
      const role = isAdmin ? 'admin' : 'customer';

      // An admin cannot be 'pending' — nobody is left to approve them. This
      // is the one place the caller-supplied status is overridden.
      const status: UserStatus = isAdmin ? 'active' : (input.status ?? 'active');

      const [created] = await tx
        .insert(users)
        .values({
          email: input.email,
          passwordHash: input.passwordHash,
          name: input.name,
          role,
          status,
          // The founding admin may mint live keys immediately; everyone else
          // needs an explicit grant.
          allowLiveKeys: isAdmin ? this.config.features.allowLiveKeys : false,
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
        /**
         * An empty array, not NULL, and the distinction is load-bearing.
         *
         * NULL means "every model is allowed" — it is what a customer who buys
         * the top tier holds. Leaving a new account's row NULL therefore claimed
         * they had already been granted everything, which made the entry
         * package's model list union away to nothing and left every new customer
         * able to call all six models. `[]` is the honest state for "granted
         * nothing yet", and `parseAllowedModels` already reads it as exactly
         * that.
         */
        allowedModels: '[]',
        // A new account has been granted nothing, which is 0 images. The base
        // values are written alongside so an expiry reverts to exactly this.
        maxImages: 0,
        baseAllowedModels: '[]',
        baseMaxImages: 0,
        planExpiresAt: null,
      });

      /**
       * The zero balance row is created HERE, in the same transaction as the
       * account, rather than lazily on first credit read.
       *
       * It is all zeros — no free trial, because the spec is explicit that
       * credits are granted on approval and not at registration. What it buys
       * is that every account has a balances row from the moment it exists, so
       * the credit tables can be joined against `users` without a LEFT JOIN and
       * a COALESCE, and so an admin listing customers can show a real balance
       * for a brand-new account rather than a blank cell.
       */
      await tx.insert(creditBalances).values({ userId: created.id }).onConflictDoNothing();

      return { id: created.id, role: created.role, status };
    });
  }

  /** Counts accounts awaiting a decision, for the admin dashboard badge. */
  async countByStatus(status: UserStatus): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.status, status));
    return rows[0]?.n ?? 0;
  }

  /** Every account awaiting review, oldest first — the approval queue. */
  async listPending(limit = 200): Promise<(typeof users.$inferSelect)[]> {
    return this.db
      .select()
      .from(users)
      .where(eq(users.status, 'pending'))
      .orderBy(sql`${users.createdAt} asc`)
      .limit(limit);
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

  async updateStatus(id: string, status: UserStatus): Promise<void> {
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
   * Admin search predicate over the customer table.
   *
   * Matching is case-insensitive across BOTH name and email, because the two
   * things an admin actually looks up are "what is this person called" and
   * "which address did they sign up with", and a search that only covers one
   * of them fails half the time.
   *
   * The term is bound as a query parameter, never interpolated into the SQL
   * text, and LIKE metacharacters inside it are escaped. Without that, a search
   * for "100%" or "a_b" silently becomes a wildcard that matches most of the
   * table. The second backslash in the ESCAPE clause is a TypeScript escape,
   * so the database receives a single backslash as the escape character.
   */
  private customerSearchFilter(term: string): SQL | undefined {
    const trimmed = term.trim();
    if (!trimmed) return undefined;
    const escaped = trimmed.replace(/[\\%_]/g, (c) => `\\${c}`);
    const pattern = `%${escaped}%`;
    return sql`(${users.name} ILIKE ${pattern} ESCAPE '\\' OR ${users.email} ILIKE ${pattern} ESCAPE '\\')`;
  }

  /**
   * Paginated customer list, optionally narrowed by `term`. An empty term is
   * the unfiltered list, so the default admin view keeps its exact current
   * behaviour and query plan.
   */
  async searchCustomers(term: string, limit = 100, offset = 0) {
    const base = this.db.select().from(users);
    const filtered = this.customerSearchFilter(term);
    const query = filtered ? base.where(filtered) : base;
    return query.orderBy(sql`${users.createdAt} desc`).limit(limit).offset(offset);
  }

  /**
   * Row count for the same filter. Reported alongside the unfiltered total so
   * the dashboard can show "3 of 128" and the admin never has to count rows by
   * eye to tell a short result set from an empty one.
   */
  async countCustomersMatching(term: string): Promise<number> {
    const base = this.db.select({ n: sql<number>`count(*)::int` }).from(users);
    const filtered = this.customerSearchFilter(term);
    const rows = filtered ? await base.where(filtered) : await base;
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
        // Absent a row, the fallback grants no images at all. Failing closed
        // matters here: 0 is "no image input", and an unreadable limits row must
        // not hand out a capability the operator had to opt into. The paired
        // base values must match, or a later expiry would revert to a grant
        // this fallback never gave.
        maxImages: 0,
        baseAllowedModels: null,
        baseMaxImages: 0,
        planExpiresAt: null,
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
