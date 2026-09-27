import { buildConfig, loadEnv } from '@synzo/config';
import { createDatabase } from '@synzo/database';
import { createRedis } from './lib/redis.js';
import { createLogger } from './lib/logger.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const config = buildConfig(loadEnv());
  const logger = createLogger(config);

  logger.info('Starting Synzo API', {
    env: config.env,
    port: config.port,
    upstream: config.upstream.baseUrl,
    defaultModel: config.defaultModel,
  });

  const { db, close } = createDatabase(config.databaseUrl, { max: config.databasePoolMax });
  const redis = createRedis(config, logger);
  await redis.connect().catch((err) => {
    logger.error('Redis failed to connect', { error: err instanceof Error ? err.message : 'unknown' });
    process.exit(1);
  });

  const { app, health } = await buildApp({ config, db, redis });
  health.start();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('Shutting down', { signal });
    health.stop();
    try {
      await app.close();
      await redis.quit();
      await close();
    } catch (err) {
      logger.error('Error during shutdown', {
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
  logger.info('Synzo API listening', { url: `http://${config.host}:${config.port}` });
}

main().catch((err) => {
  // Config and bootstrap failures must be legible but never leak secrets.
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${JSON.stringify({ level: 'error', msg: 'Fatal startup error', error: message })}\n`);
  process.exit(1);
});
