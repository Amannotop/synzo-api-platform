/**
 * Development seed. Registers the OpenCode provider and the initial model from
 * the configured upstream and default model name.
 *
 * This is real configuration data, not demo content: it creates no customers,
 * no usage and no fake statistics, so a fresh production database shows zeros
 * exactly as specified.
 */
import { eq } from 'drizzle-orm';
import { buildConfig, loadEnv } from '@synzo/config';
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

    const existing = await db
      .select()
      .from(models)
      .where(eq(models.publicName, config.defaultModel))
      .limit(1);

    if (existing.length > 0) {
      console.log(`Model already present: ${config.defaultModel}`);
    } else {
      await db.insert(models).values({
        publicName: config.defaultModel,
        providerId: provider.id,
        upstreamModel: config.defaultModel,
        enabled: true,
      });
      console.log(`Created model: ${config.defaultModel}`);
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
