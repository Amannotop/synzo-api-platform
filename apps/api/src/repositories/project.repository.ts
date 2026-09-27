import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '@synzo/database';
import { apiKeys, projects, requests } from '@synzo/database';

/**
 * Every method here takes userId and includes it in the WHERE clause. There is
 * no unscoped accessor, so a cross-tenant read is not merely discouraged by
 * convention — it is unreachable through this layer (§7).
 */
export class ProjectRepository {
  constructor(private readonly db: Database) {}

  async listForUser(userId: string) {
    return this.db
      .select({
        id: projects.id,
        name: projects.name,
        description: projects.description,
        createdAt: projects.createdAt,
        keyCount: sql<number>`(
          select count(*)::int from ${apiKeys} k where k.project_id = ${projects.id}
        )`,
        requestCount: sql<number>`(
          select count(*)::int from ${requests} r where r.project_id = ${projects.id}
        )`,
      })
      .from(projects)
      .where(eq(projects.userId, userId))
      .orderBy(desc(projects.createdAt));
  }

  async findOwned(userId: string, projectId: string) {
    const rows = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async create(userId: string, input: { name: string; description?: string }) {
    const rows = await this.db.insert(projects).values({ userId, ...input }).returning();
    return rows[0] ?? null;
  }

  async updateOwned(
    userId: string,
    projectId: string,
    input: { name?: string; description?: string | null },
  ) {
    const rows = await this.db
      .update(projects)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .returning();
    return rows[0] ?? null;
  }

  async deleteOwned(userId: string, projectId: string): Promise<boolean> {
    const rows = await this.db
      .delete(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .returning({ id: projects.id });
    return rows.length > 0;
  }

  async countForUser(userId: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(projects)
      .where(eq(projects.userId, userId));
    return rows[0]?.n ?? 0;
  }
}
