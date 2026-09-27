import { Redis } from 'ioredis';
import type { AppConfig } from '@synzo/config';
import type { Logger } from './logger.js';

/**
 * Redis backs distributed rate limiting and concurrency tracking so limits hold
 * across multiple API instances (§21, §30).
 *
 * AI responses are NEVER cached here: they can contain customer-private data
 * and caching them would leak across tenants.
 */
export function createRedis(config: AppConfig, logger: Logger): Redis {
  const client = new Redis(config.redisUrl, {
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true,
    lazyConnect: true,
    retryStrategy: (times: number) => Math.min(times * 200, 2000),
  });

  client.on('error', (err: Error) => {
    logger.error('Redis connection error', { error: err.message });
  });
  client.on('connect', () => logger.info('Redis connected'));

  return client;
}
