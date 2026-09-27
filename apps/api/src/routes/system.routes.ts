import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '@synzo/config';
import { createApiKeyAuth } from '../middleware/api-key-auth.js';
import { filterByAllowedModels, parseAllowedModels } from '../lib/allowed-models.js';
import type { ApiKeyRepository } from '../repositories/api-key.repository.js';
import type { UserRepository } from '../repositories/user.repository.js';
import type { ModelRepository } from '../repositories/model.repository.js';
import type { ProviderHealthMonitor } from '../services/provider-health.service.js';
import type { Redis } from 'ioredis';
import type { Database } from '@synzo/database';
import { sql } from 'drizzle-orm';

const VERSION = '1.0.0';
const STARTED_AT = new Date().toISOString();

interface SystemDeps {
  config: AppConfig;
  db: Database;
  redis: Redis;
  models: ModelRepository;
  apiKeys: ApiKeyRepository;
  users: UserRepository;
  health: ProviderHealthMonitor;
}

/**
 * Public/OpenAI-compatible routes plus operational endpoints.
 *
 * `GET /health` is a liveness probe that never touches a dependency, so an
 * orchestrator does not restart a healthy process just because the database
 * is briefly unreachable. `GET /ready` is the dependency check.
 */
export async function registerSystemRoutes(app: FastifyInstance, deps: SystemDeps): Promise<void> {
  const { config, db, redis, models, health } = deps;

  app.get('/health', async () => ({
    status: 'ok',
    version: VERSION,
    uptime: Math.round(process.uptime()),
    startedAt: STARTED_AT,
  }));

  app.get('/ready', async (_request, reply) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    let ready = true;

    try {
      await db.execute(sql`select 1`);
      checks.database = { ok: true };
    } catch (err) {
      ready = false;
      checks.database = { ok: false, detail: err instanceof Error ? err.message : 'unreachable' };
    }

    try {
      const pong = await redis.ping();
      checks.redis = { ok: pong === 'PONG' };
      if (pong !== 'PONG') ready = false;
    } catch (err) {
      ready = false;
      checks.redis = { ok: false, detail: err instanceof Error ? err.message : 'unreachable' };
    }

    const providerHealth = health.getAll();
    checks.providers = {
      ok: providerHealth.length === 0 || providerHealth.every((p) => p.healthy),
    };

    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks });
  });

  app.get('/version', async () => ({
    version: VERSION,
    environment: config.env,
    startedAt: STARTED_AT,
    node: process.version,
  }));

  // OpenAI-compatible model listing, restricted to models the customer may use.
  const auth = createApiKeyAuth(config, deps.apiKeys, deps.users);

  app.get('/v1/models', { preHandler: auth }, async (request) => {
    const ctx = request.apiKey;
    const all = await models.listEnabled();
    const allowed = filterByAllowedModels(
      all,
      parseAllowedModels(ctx?.limits.allowedModels),
      (m) => m.publicName,
    );
    return {
      object: 'list',
      data: allowed.map((m) => ({
        id: m.publicName,
        object: 'model',
        created: Math.floor(new Date(m.created).getTime() / 1000),
        owned_by: m.provider,
      })),
    };
  });

  app.get('/v1/models/:model', { preHandler: auth }, async (request, reply) => {
    const { model } = request.params as { model: string };
    const found = await models.findEnabled(model);
    if (!found) {
      return reply.status(404).send({
        error: {
          message: `The model \`${model}\` does not exist`,
          type: 'invalid_request_error',
          code: 'invalid_model',
          param: 'model',
        },
      });
    }
    return {
      id: found.publicName,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: found.provider,
    };
  });
}
