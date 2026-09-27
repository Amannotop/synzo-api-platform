import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  createApiKeySchema,
  createProjectSchema,
  requestsQuerySchema,
  updateKeyStatusSchema,
  updateProjectSchema,
  usageQuerySchema,
} from '@synzo/validation';
import type { AppConfig } from '@synzo/config';
import { badRequest, conflict, notFoundOrForbidden, HttpError } from '../lib/errors.js';
import { deriveKeyPrefix, generateApiKeySecret, hashApiKey } from '../lib/crypto.js';
import { requireSession } from '../middleware/session-auth.js';
import type { ProjectRepository } from '../repositories/project.repository.js';
import type { ApiKeyRepository } from '../repositories/api-key.repository.js';
import type { RequestRepository } from '../repositories/request.repository.js';
import type { UserRepository } from '../repositories/user.repository.js';
import type { AuditRepository } from '../repositories/audit.repository.js';
import type { ModelRepository } from '../repositories/model.repository.js';

interface CustomerDeps {
  config: AppConfig;
  projects: ProjectRepository;
  apiKeys: ApiKeyRepository;
  requestsRepo: RequestRepository;
  users: UserRepository;
  audit: AuditRepository;
  models: ModelRepository;
}

function meta(request: FastifyRequest) {
  return {
    ip: request.ip ?? null,
    userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
  };
}

function fail(issues: { message: string; path: (string | number)[] }[]): never {
  const first = issues[0];
  throw badRequest(first?.message ?? 'Invalid request', 'invalid_request', first?.path.join('.') || undefined);
}

function rangeToDates(range: string, from?: string, to?: string): { from: Date; to: Date } {
  if (range === 'custom' && from && to) {
    return { from: new Date(from), to: new Date(to) };
  }
  const to_ = new Date();
  const from_ = new Date();
  const days = range === 'today' ? 0 : range === '7d' ? 7 : range === '90d' ? 90 : 30;
  if (days === 0) from_.setUTCHours(0, 0, 0, 0);
  else from_.setUTCDate(from_.getUTCDate() - days);
  return { from: from_, to: to_ };
}

export async function registerCustomerRoutes(app: FastifyInstance, deps: CustomerDeps): Promise<void> {
  const { config, projects, apiKeys, requestsRepo, users, audit } = deps;

  /* ------------------------------------------------------------ projects */

  app.get('/api/projects', async (request: FastifyRequest) => {
    const user = requireSession(request);
    return { projects: await projects.listForUser(user.userId) };
  });

  app.post('/api/projects', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireSession(request);
    const parsed = createProjectSchema.safeParse(request.body);
    if (!parsed.success) fail(parsed.error.issues);

    const project = await projects.create(user.userId, parsed.data);
    await audit.record({
      actorUserId: user.userId,
      action: 'project.created',
      resourceType: 'project',
      resourceId: project?.id,
      metadata: { name: parsed.data.name },
      ...meta(request),
    });
    return reply.status(201).send({ project });
  });

  app.get('/api/projects/:id', async (request: FastifyRequest) => {
    const user = requireSession(request);
    const { id } = request.params as { id: string };
    const project = await projects.findOwned(user.userId, id);
    if (!project) throw notFoundOrForbidden();
    return { project };
  });

  app.patch('/api/projects/:id', async (request: FastifyRequest) => {
    const user = requireSession(request);
    const { id } = request.params as { id: string };
    const parsed = updateProjectSchema.safeParse(request.body);
    if (!parsed.success) fail(parsed.error.issues);

    const project = await projects.updateOwned(user.userId, id, parsed.data);
    if (!project) throw notFoundOrForbidden();
    return { project };
  });

  app.delete('/api/projects/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireSession(request);
    const { id } = request.params as { id: string };
    const ok = await projects.deleteOwned(user.userId, id);
    if (!ok) throw notFoundOrForbidden();

    await audit.record({
      actorUserId: user.userId,
      action: 'project.deleted',
      resourceType: 'project',
      resourceId: id,
      ...meta(request),
    });
    return reply.status(204).send();
  });

  /* ------------------------------------------------------------ api keys */

  app.get('/api/keys', async (request: FastifyRequest) => {
    const user = requireSession(request);
    const [keys, counts] = await Promise.all([
      apiKeys.listForUser(user.userId),
      apiKeys.usageCountsForUser(user.userId),
    ]);
    const countMap = new Map(counts.map((c) => [c.keyId, c.requests]));
    return {
      keys: keys.map((k) => ({ ...k, requestCount: countMap.get(k.id) ?? 0 })),
      canCreateLiveKeys: user.role === 'admin' || user.allowLiveKeys,
    };
  });

  app.post('/api/keys', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireSession(request);
    const parsed = createApiKeySchema.safeParse(request.body);
    if (!parsed.success) fail(parsed.error.issues);
    const input = parsed.data;

    // The project must belong to this customer, or the id simply does not resolve.
    const project = await projects.findOwned(user.userId, input.projectId);
    if (!project) throw notFoundOrForbidden();

    if (input.environment === 'live') {
      const record = await users.findById(user.userId);
      const allowed = user.role === 'admin' || config.features.allowLiveKeys || record?.allowLiveKeys;
      if (!allowed) {
        throw new HttpError({
          statusCode: 403,
          message: 'Live API keys are not enabled for your account. Contact support to enable them.',
          type: 'permission_error',
          code: 'live_keys_not_allowed',
        });
      }
    }

    const secret = generateApiKeySecret(input.environment);
    const keyHash = hashApiKey(secret, config.security.apiKeyPepper);
    const expiresAt = input.expiresInDays
      ? new Date(Date.now() + input.expiresInDays * 86_400_000)
      : null;

    const created = await apiKeys.create({
      userId: user.userId,
      projectId: input.projectId,
      name: input.name,
      keyPrefix: deriveKeyPrefix(secret),
      keyHash,
      environment: input.environment,
      expiresAt,
    });

    await audit.record({
      actorUserId: user.userId,
      action: 'apikey.created',
      resourceType: 'api_key',
      resourceId: created?.id,
      metadata: { name: input.name, environment: input.environment },
      ...meta(request),
    });

    // The ONLY time the secret is ever returned. It is not recoverable later.
    return reply.status(201).send({
      key: {
        id: created?.id,
        name: created?.name,
        keyPrefix: created?.keyPrefix,
        environment: created?.environment,
        projectId: created?.projectId,
        createdAt: created?.createdAt,
        expiresAt: created?.expiresAt,
        status: created?.status,
      },
      secret,
      warning: 'Copy this secret now. It will not be shown again.',
    });
  });

  app.delete('/api/keys/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireSession(request);
    const { id } = request.params as { id: string };
    const ok = await apiKeys.deleteOwned(user.userId, id);
    if (!ok) throw notFoundOrForbidden();
    await audit.record({
      actorUserId: user.userId,
      action: 'apikey.deleted',
      resourceType: 'api_key',
      resourceId: id,
      ...meta(request),
    });
    return reply.status(204).send();
  });

  app.post('/api/keys/:id/revoke', async (request: FastifyRequest) => {
    const user = requireSession(request);
    const { id } = request.params as { id: string };
    const ok = await apiKeys.setStatus(user.userId, id, 'revoked');
    if (!ok) throw notFoundOrForbidden();
    await audit.record({
      actorUserId: user.userId,
      action: 'apikey.revoked',
      resourceType: 'api_key',
      resourceId: id,
      ...meta(request),
    });
    return { ok: true };
  });

  app.post('/api/keys/:id/status', async (request: FastifyRequest) => {
    const user = requireSession(request);
    const { id } = request.params as { id: string };
    const parsed = updateKeyStatusSchema.safeParse(request.body);
    if (!parsed.success) fail(parsed.error.issues);

    const existing = await apiKeys.findOwned(user.userId, id);
    if (!existing) throw notFoundOrForbidden();
    if (existing.status === 'revoked') {
      throw conflict('A revoked key cannot be re-enabled. Create a new key instead.', 'key_revoked');
    }

    const ok = await apiKeys.setStatus(user.userId, id, parsed.data.status);
    if (!ok) throw notFoundOrForbidden();
    await audit.record({
      actorUserId: user.userId,
      action: parsed.data.status === 'active' ? 'apikey.enabled' : 'apikey.disabled',
      resourceType: 'api_key',
      resourceId: id,
      ...meta(request),
    });
    return { ok: true, status: parsed.data.status };
  });

  /* ------------------------------------------------------------- usage */

  app.get('/api/usage', async (request: FastifyRequest) => {
    const user = requireSession(request);
    const parsed = usageQuerySchema.safeParse(request.query);
    if (!parsed.success) fail(parsed.error.issues);
    const { from, to } = rangeToDates(parsed.data.range, parsed.data.from, parsed.data.to);

    const [stats, series, byModel] = await Promise.all([
      requestsRepo.statsForUser(user.userId, from, to),
      requestsRepo.dailySeries(user.userId, from, to),
      requestsRepo.usageByModel(user.userId, from, to),
    ]);

    return { range: { from, to }, stats, series, byModel };
  });

  /* ---------------------------------------------------------- requests */

  app.get('/api/requests', async (request: FastifyRequest) => {
    const user = requireSession(request);
    const parsed = requestsQuerySchema.safeParse(request.query);
    if (!parsed.success) fail(parsed.error.issues);
    const q = parsed.data;
    const { from, to } = rangeToDates(q.range, q.from, q.to);

    const [rows, total] = await Promise.all([
      requestsRepo.listForUser(user.userId, {
        from,
        to,
        limit: q.limit,
        offset: q.offset,
        ...(q.status ? { status: q.status } : {}),
        ...(q.model ? { model: q.model } : {}),
        ...(q.projectId ? { projectId: q.projectId } : {}),
      }),
      requestsRepo.countForUser(user.userId, { from, to }),
    ]);

    return { requests: rows, total, limit: q.limit, offset: q.offset };
  });

  /* --------------------------------------------------------- overview */

  app.get('/api/overview', async (request: FastifyRequest) => {
    const user = requireSession(request);
    const [stats, keyList, enabledModels, projectList] = await Promise.all([
      requestsRepo.statsForUser(user.userId),
      apiKeys.listForUser(user.userId),
      deps.models.listEnabled(),
      projects.listForUser(user.userId),
    ]);

    return {
      stats,
      activeKeys: keyList.filter((k) => k.status === 'active').length,
      totalKeys: keyList.length,
      projects: projectList.length,
      models: enabledModels.map((m) => m.publicName),
    };
  });
}
