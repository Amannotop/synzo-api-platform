import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import type { AppConfig } from '@synzo/config';
import type { Database } from '@synzo/database';
import type { Redis } from 'ioredis';
import { createLogger, type Logger } from './lib/logger.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { createSessionResolver, SessionService } from './middleware/session-auth.js';
import { ProviderRegistry } from './providers/provider.registry.js';
import { AccountTokenService } from './services/account-token.service.js';
import { accountTokenMail, createMailer } from './lib/mailer.js';
import { RateLimitService } from './services/rate-limit.service.js';
import { ChatService } from './services/chat.service.js';
import { ProviderHealthMonitor } from './services/provider-health.service.js';
import { AuditRepository } from './repositories/audit.repository.js';
import { ApiKeyRepository } from './repositories/api-key.repository.js';
import { ModelRepository } from './repositories/model.repository.js';
import { ProjectRepository } from './repositories/project.repository.js';
import { RequestRepository } from './repositories/request.repository.js';
import { SessionRepository } from './repositories/session.repository.js';
import { UserRepository } from './repositories/user.repository.js';
import { registerAuthRoutes } from './routes/auth.routes.js';
import { registerCustomerRoutes } from './routes/customer.routes.js';
import { registerAdminRoutes } from './routes/admin.routes.js';
import { registerChatRoutes } from './routes/chat.routes.js';
import { registerSystemRoutes } from './routes/system.routes.js';
import { registerAccountRoutes } from './routes/account.routes.js';

export interface AppDeps {
  config: AppConfig;
  db: Database;
  redis: Redis;
}

export interface BuiltApp {
  app: FastifyInstance;
  logger: Logger;
  health: ProviderHealthMonitor;
}

/**
 * Composes the application: plugins, repositories, services, routes.
 *
 * Dependencies are injected rather than imported as singletons so tests can
 * build an app against a real database and Redis without patching modules.
 */
export async function buildApp(deps: AppDeps): Promise<BuiltApp> {
  const { config, db, redis } = deps;
  const logger = createLogger(config);

  const app = Fastify({
    logger: false, // we emit structured JSON ourselves
    trustProxy: config.security.trustProxy,
    bodyLimit: config.limits.maxBodyBytes,
    genReqId: () => `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
  });

  await app.register(cookie, { secret: config.security.sessionSecret });

  await app.register(cors, {
    origin: config.cors.allowList.length > 0 ? config.cors.allowList : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.register(helmet, {
    // The dashboard is a separate origin, so a strict CSP here would break it.
    // This CSP applies to JSON responses and is intentionally permissive for
    // the SPA, which is served separately.
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });

  registerErrorHandler(app, logger);

  // Repositories
  const users = new UserRepository(db, config);
  const projects = new ProjectRepository(db);
  const apiKeys = new ApiKeyRepository(db);
  const requestsRepo = new RequestRepository(db);
  const models = new ModelRepository(db);
  const sessions = new SessionRepository(db);
  const audit = new AuditRepository(db);

  // Services
  const providers = new ProviderRegistry(config);
  const rateLimiter = new RateLimitService(redis, logger);
  const sessionService = new SessionService(config, sessions);
  const health = new ProviderHealthMonitor(config, providers, logger);
  const mailer = createMailer(config);
  const accountTokens = new AccountTokenService({
    db,
    config,
    logger,
    deliver: async ({ email, purpose, raw, expiresAt }) => {
      // Delivery failures must not surface as "we emailed you" when we did not,
      // and must not take the request down either: the row is already written
      // and the customer can retry.
      try {
        await mailer.send(accountTokenMail(config, { to: email, purpose, raw, expiresAt }));
      } catch (err) {
        logger.error('Failed to deliver account token email', {
          purpose,
          error: err instanceof Error ? err.message : 'unknown',
        });
      }
    },
  });
  const chatService = new ChatService({
    config,
    logger,
    models,
    providers,
    requestsRepo,
    rateLimiter,
  });

  // Attach the authenticated session to every request before routing.
  const resolveSession = createSessionResolver(sessions, config.security.sessionCookieName);
  app.addHook('preHandler', resolveSession);

  await registerSystemRoutes(app, { config, db, redis, models, apiKeys, users, health });
  await registerChatRoutes(app, { config, logger, chatService, apiKeys, users, models });
  await registerAuthRoutes(app, {
    config,
    users,
    sessions,
    sessionService,
    audit,
    redis,
    rateLimiter,
    accountTokens,
  });
  await registerAccountRoutes(app, {
    config,
    users,
    sessions,
    sessionService,
    accountTokens,
    audit,
    redis,
  });
  await registerCustomerRoutes(app, { config, projects, apiKeys, requestsRepo, users, audit, models });
  await registerAdminRoutes(app, { users, models, requestsRepo, audit, health });

  // Request/response logging that is guaranteed not to include secrets.
  app.addHook('onResponse', async (request, reply) => {
    logger.info('request', {
      requestId: request.id,
      method: request.method,
      path: request.url,
      status: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    });
  });

  return { app, logger, health };
}
