import { and, eq } from 'drizzle-orm';
import type { Database } from '@synzo/database';
import { models, providers } from '@synzo/database';

/**
 * The model registry (§10). Requests resolve a public name to a provider and
 * an upstream model name through this table — never through a hard-coded
 * switch — so adding a model is a data change, not a code change.
 */
export class ModelRepository {
  constructor(private readonly db: Database) {}

  async findEnabled(publicName: string) {
    const rows = await this.db
      .select({
        id: models.id,
        publicName: models.publicName,
        upstreamModel: models.upstreamModel,
        provider: providers.name,
        providerEnabled: providers.enabled,
      })
      .from(models)
      .innerJoin(providers, eq(models.providerId, providers.id))
      .where(and(eq(models.publicName, publicName), eq(models.enabled, true)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Any model by name, enabled or not — used to distinguish 404 from 403. */
  async findAny(publicName: string) {
    const rows = await this.db
      .select({ id: models.id, enabled: models.enabled, provider: providers.name })
      .from(models)
      .innerJoin(providers, eq(models.providerId, providers.id))
      .where(eq(models.publicName, publicName))
      .limit(1);
    return rows[0] ?? null;
  }

  async listEnabled() {
    return this.db
      .select({
        id: models.id,
        publicName: models.publicName,
        provider: providers.name,
        created: models.createdAt,
      })
      .from(models)
      .innerJoin(providers, eq(models.providerId, providers.id))
      .where(and(eq(models.enabled, true), eq(providers.enabled, true)))
      .orderBy(models.publicName);
  }

  async listAll() {
    return this.db
      .select({
        id: models.id,
        publicName: models.publicName,
        provider: providers.name,
        upstreamModel: models.upstreamModel,
        enabled: models.enabled,
        createdAt: models.createdAt,
      })
      .from(models)
      .innerJoin(providers, eq(models.providerId, providers.id))
      .orderBy(models.publicName);
  }

  async setEnabled(modelId: string, enabled: boolean): Promise<boolean> {
    const rows = await this.db
      .update(models)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(models.id, modelId))
      .returning({ id: models.id });
    return rows.length > 0;
  }

  async setProviderEnabled(providerName: string, enabled: boolean): Promise<boolean> {
    const rows = await this.db
      .update(providers)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(providers.name, providerName))
      .returning({ name: providers.name });
    return rows.length > 0;
  }

  async listProviders() {
    return this.db.select().from(providers).orderBy(providers.name);
  }
}
