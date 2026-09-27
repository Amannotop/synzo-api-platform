/**
 * Development seed. Registers the OpenCode provider and the initial model from
 * the configured upstream and default model name.
 *
 * This is real configuration data, not demo content: it creates no customers,
 * no usage and no fake statistics, so a fresh production database shows zeros
 * exactly as specified.
 */
import { eq, sql } from 'drizzle-orm';
import { buildConfig, loadEnv, MODEL_TIERS } from '@synzo/config';
import { createDatabase } from './client.js';
import { models, providers } from './schema.js';

async function seed(): Promise<void> {
  const config = buildConfig(loadEnv());
  const { db, close } = createDatabase(config.databaseUrl, { max: 2 });

  try {
    const providerName = config.upstream.baseUrl.includes('opencode') ? 'opencode' : 'custom';

    let provider = (await db.select().from(providers).where(eq(providers.name, providerName)).limit(1))[0];
    if (!provider) {
      [provider] = await db
        .insert(providers)
        .values({ name: providerName, enabled: true })
        .returning();
      console.log(`Created provider: ${providerName}`);
    } else {
      console.log(`Provider already present: ${providerName}`);
    }
    if (!provider) throw new Error('Failed to resolve provider');

    // Seed the full tier catalogue, not just the default. Each row maps a
    // public tier name to the upstream model that serves it, so the default is
    // guaranteed to exist along with everything else. ON CONFLICT keeps the
    // seed idempotent and refreshes an upstream id that has since been
    // corrected, rather than leaving a stale mapping behind.
    const inserted = await db
      .insert(models)
      .values(
        MODEL_TIERS.map((t) => ({
          publicName: t.tier,
          providerId: provider.id,
          upstreamModel: t.upstreamModel,
          enabled: true,
        })),
      )
      .onConflictDoUpdate({
        target: models.publicName,
        set: {
          upstreamModel: sql.raw('excluded.upstream_model'),
          enabled: true,
          updatedAt: new Date(),
        },
      })
      .returning({ publicName: models.publicName });

    for (const row of inserted) console.log(`Seeded model: ${row.publicName}`);

    if (!inserted.some((m) => m.publicName === config.defaultModel)) {
      throw new Error(
        `DEFAULT_MODEL="${config.defaultModel}" is not one of the seeded tiers (${MODEL_TIERS.map((t) => t.tier).join(', ')}).`,
      );
    }
  } finally {
    await close();
  }
}

seed()
  .then(() => console.log('Seed complete'))
  .catch((err) => {
    console.error('Seed failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
