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
import { createMetrics, type Metrics } from './metrics/registry.js';
import { registerMetricsRoutes } from './routes/metrics.routes.js';
import { registerDocsRoutes } from './routes/docs.routes.js';
import { registerStaticRoutes } from './routes/static.routes.js';
import { RetentionService } from './services/retention.service.js';

export interface AppDeps {
  config: AppConfig;
  db: Database;
  redis: Redis;
}

export interface BuiltApp {
  app: FastifyInstance;
  logger: Logger;
  health: ProviderHealthMonitor;
  metrics: Metrics;
  retention: RetentionService;
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

  const metrics = createMetrics();

  const app = Fastify({
    logger: false, // we emit structured JSON ourselves
    trustProxy: config.security.trustProxy,
    bodyLimit: config.limits.maxBodyBytes,
    genReqId: () => `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
  });

  await app.register(cookie, { secret: config.security.sessionSecret });

  /**
   * CORS is load-bearing only for the browser. Serving the dashboard from this
   * process makes the dashboard same-origin, so the interesting case is a
   * customer calling the API from their own web app.
   *
   * The security rule that matters: `credentials: true` alongside a reflected
   * wildcard origin means any site on the internet can make a request that
   * carries the dashboard's session cookie and read the response. That is a
   * cross-site data theft primitive, not a permissive setting.
   *
   * So the two are decided together. With an explicit allowlist, those origins
   * are trusted and get credentials. With `*`, the caller is assumed to be
   * authenticating with an API key — which is not ambient and is not sent
   * automatically by the browser — and credentials are withheld, because
   * withholding them is what makes a reflected origin safe.
   */
  await app.register(cors, {
    /**
     * `*` cannot be combined with credentials: browsers ignore a literal
     * wildcard on credentialed requests. Reflecting the caller's own origin is
     * the standard substitute and still keeps the response tied to the request
     * that made it. With a concrete allowlist we keep the strict array, and an
     * empty list disables CORS entirely (same-origin only).
     */
    origin: config.cors.allowAny
      ? true
      : config.cors.allowList.length > 0
        ? config.cors.allowList
        : false,
    credentials: config.cors.allowCredentials,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.register(helmet, {
    /**
     * A Content-Security-Policy is a genuine hardening measure here: this is a
     * credentialed, cookie-authenticated surface that renders untrusted
     * strings, so a strict policy blocks whole classes of injection.
     *
     * It is enforced only when the SPA is served from this process. In dev the
     * dashboard runs on Vite's own origin with its own HMR client, and a
     * policy written for the built bundle would only get in the way.
     *
     * `script-src 'self'` with no `unsafe-inline` and no CDN is the part that
     * matters: it is what stops an injected <script> from running, and it is
     * why Swagger UI's assets are served from this origin rather than pulled
     * from a public CDN.
     */
    contentSecurityPolicy: config.serving.dashboard
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            // Vite emits a small inline style block for its CSS variables, and
            // Swagger UI sets inline styles on the elements it builds.
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:'],
            connectSrc: ["'self'"],
            // Nothing here needs frames, objects or workers.
            frameSrc: ["'none'"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
          },
        }
      : false,
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
  const rateLimiter = new RateLimitService(redis, logger, metrics);
  const sessionService = new SessionService(config, sessions);
  const health = new ProviderHealthMonitor(config, providers, logger);
  const mailer = createMailer(config);
  const accountTokens = new AccountTokenService({
    db,
    config,
    logger,
    deliver: async ({ email, purpose, raw, expiresAt, publicOrigin }) => {
      // Delivery failures must not surface as "we emailed you" when we did not,
      // and must not take the request down either: the row is already written
      // and the customer can retry.
      try {
        await mailer.send(
          accountTokenMail(config, { to: email, purpose, raw, expiresAt, publicOrigin }),
        );
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
    metrics,
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
  await registerAdminRoutes(app, { users, models, requestsRepo, audit, health, metrics });
  await registerMetricsRoutes(app, { config, metrics, health });
  await registerDocsRoutes(app, { config });

  // The dashboard is registered last so every API route above wins the match.
  // An unmatched path then falls through to the SPA rather than the reverse.
  await registerStaticRoutes(app, { config });

  const retention = new RetentionService({
    config,
    logger,
    db,
    sessions,
    accountTokens,
  });
  retention.start();

  // Request/response logging that is guaranteed not to include secrets.
  app.addHook('onResponse', async (request, reply) => {
    // `routeOptions.url` is the pattern, so /v1/chat/completions does not
    // explode into one time series per request id.
    const route = request.routeOptions?.url ?? 'unmatched';
    const labels = {
      method: request.method,
      route,
      status: String(reply.statusCode),
    };
    metrics.httpRequests.inc(labels);
    metrics.httpDuration.observe(labels, reply.elapsedTime / 1000);

    logger.info('request', {
      requestId: request.id,
      method: request.method,
      path: request.url,
      route,
      status: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    });
  });

  app.addHook('onClose', async () => {
    retention.stop();
  });

  return { app, logger, health, metrics, retention };
}
