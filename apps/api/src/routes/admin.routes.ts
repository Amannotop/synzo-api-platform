import type { FastifyInstance, FastifyRequest } from 'fastify';
import { adminUpdateLimitsSchema, adminUpdateUserSchema } from '@synzo/validation';
import { badRequest, conflict, notFoundOrForbidden } from '../lib/errors.js';
import { requireAdmin } from '../middleware/session-auth.js';
import { parseAllowedModels } from '../lib/allowed-models.js';
import { summarizeMetrics } from '../metrics/summary.js';
import type { UserRepository } from '../repositories/user.repository.js';
import type { ModelRepository } from '../repositories/model.repository.js';
import type { RequestRepository } from '../repositories/request.repository.js';
import type { AuditRepository } from '../repositories/audit.repository.js';
import type { ProviderHealthMonitor } from '../services/provider-health.service.js';
import type { Metrics } from '../metrics/registry.js';
import type { AppConfig } from '@synzo/config';
import type { CreditRepository } from '../repositories/credit.repository.js';
import type { TelegramService } from '../services/telegram.service.js';
import { registerAdminCreditRoutes } from './admin-credits.routes.js';

interface AdminDeps {
  config: AppConfig;
  users: UserRepository;
  models: ModelRepository;
  requestsRepo: RequestRepository;
  audit: AuditRepository;
  health: ProviderHealthMonitor;
  /** The in-process registry, for the live operational summary. */
  metrics: Metrics;
  /** Credit, payment and billing management. */
  credits: CreditRepository;
  telegram: TelegramService;
}

function fail(issues: { message: string; path: (string | number)[] }[]): never {
  const first = issues[0];
  throw badRequest(first?.message ?? 'Invalid request', 'invalid_request', first?.path.join('.') || undefined);
}

/**
 * The stored allowlist is a JSON string; the API always speaks arrays so the
 * dashboard never has to parse (or guess at) a string shape. A malformed
 * stored value becomes an empty allowlist rather than a 500.
 */
function presentLimits(limits: {
  userId: string;
  requestsPerMinute: number;
  requestsPerDay: number;
  tokensPerDay: number;
  maxConcurrentRequests: number;
  allowedModels: string | null;
}) {
  return {
    userId: limits.userId,
    requestsPerMinute: limits.requestsPerMinute,
    requestsPerDay: limits.requestsPerDay,
    tokensPerDay: limits.tokensPerDay,
    maxConcurrentRequests: limits.maxConcurrentRequests,
    allowedModels: parseAllowedModels(limits.allowedModels),
  };
}

function meta(request: FastifyRequest) {
  return {
    ip: request.ip ?? null,
    userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
  };
}

/**
 * Admin surface (§24). Every handler calls requireAdmin first, and the whole
 * group is registered behind a preHandler so no route can be added by mistake
 * without inheriting the check.
 *
 * Admins see key METADATA only — never a secret, which is unrecoverable by
 * design.
 */
export async function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): Promise<void> {
  // Encapsulated in its own plugin scope. Adding the hook to the root instance
  // would apply the admin gate to every route in the app, including /health.
  await app.register(async (admin) => {
    admin.addHook('preHandler', async (request) => {
      requireAdmin(request);
    });

    /**
     * The credit/payment surface is registered INSIDE this scope, so it
     * inherits the `requireAdmin` hook above. Registering it at the top level
     * would leave it reachable by any signed-in customer, which is exactly the
     * privilege-escalation the spec is about.
     */
    await registerAdminCreditRoutes(admin, {
      config: deps.config,
      credits: deps.credits,
      telegram: deps.telegram,
      users: deps.users,
      audit: deps.audit,
    });

    await registerRoutes(admin, deps);
  });
}

async function registerRoutes(app: FastifyInstance, deps: AdminDeps): Promise<void> {
  app.get('/api/admin/customers', async (request: FastifyRequest) => {
    const query = request.query as { limit?: string; offset?: string; q?: string };
    const limit = Math.min(Number(query.limit ?? 100) || 100, 500);
    const offset = Number(query.offset ?? 0) || 0;

    // `q` narrows the list to accounts whose name or email contains the term,
    // case-insensitively. It is capped so a pathological query string cannot
    // be turned into an expensive unbounded scan, and a blank term is treated
    // as no search at all so the default view is byte-for-byte the old one.
    const rawTerm = (query.q ?? '').slice(0, 120);
    const term = rawTerm.trim();

    // A search must resolve fast enough to type into, so the result set is
    // capped independently of the page size. An admin scanning for a Gmail
    // address does not need 500 rows, and a slow response here is what makes a
    // search feel broken.
    const searchLimit = term ? Math.min(limit, 50) : limit;

    const [customers, matched, total] = await Promise.all([
      term
        ? deps.users.searchCustomers(term, searchLimit, offset)
        : deps.users.listCustomers(limit, offset),
      term ? deps.users.countCustomersMatching(term) : Promise.resolve(0),
      deps.users.countCustomers(),
    ]);
    return {
      customers: customers.map((c) => ({
        id: c.id,
        email: c.email,
        name: c.name,
        role: c.role,
        status: c.status,
        unlimitedMode: c.unlimitedMode,
        allowLiveKeys: c.allowLiveKeys,
        createdAt: c.createdAt,
        lastLoginAt: c.lastLoginAt,
      })),
      total,
      // `matched` is the number of accounts the current search found, so the
      // dashboard can say "3 of 128" and tell a short result set apart from an
      // empty one. It equals `total` when no search is active.
      matched: term ? matched : total,
      query: term,
      limit: searchLimit,
      offset,
    };
  });

  app.get('/api/admin/customers/:id/limits', async (request: FastifyRequest) => {
    const { id } = request.params as { id: string };
    const target = await deps.users.findById(id);
    if (!target) throw notFoundOrForbidden();
    return { limits: presentLimits(await deps.users.getLimits(id)) };
  });

  app.patch('/api/admin/customers/:id/limits', async (request: FastifyRequest) => {
    const admin = requireAdmin(request);
    const { id } = request.params as { id: string };
    const parsed = adminUpdateLimitsSchema.safeParse(request.body);
    if (!parsed.success) fail(parsed.error.issues);

    const target = await deps.users.findById(id);
    if (!target) throw notFoundOrForbidden();

    // The allowlist is a JSON array in the database; the wire format is an
    // array so the dashboard does not have to hand-roll JSON.parse.
    const { allowedModels, ...numeric } = parsed.data;
    const fields: Parameters<UserRepository['updateLimits']>[1] = {
      ...numeric,
      ...(allowedModels !== undefined
        ? { allowedModels: allowedModels === null ? null : JSON.stringify(allowedModels) }
        : {}),
    };
    await deps.users.updateLimits(id, fields);
    await deps.audit.record({
      actorUserId: admin.userId,
      action: 'admin.limits_changed',
      resourceType: 'user',
      resourceId: id,
      metadata: fields,
      ...meta(request),
    });
    return { limits: presentLimits(await deps.users.getLimits(id)) };
  });

  app.patch('/api/admin/customers/:id', async (request: FastifyRequest) => {
    const admin = requireAdmin(request);
    const { id } = request.params as { id: string };
    const parsed = adminUpdateUserSchema.safeParse(request.body);
    if (!parsed.success) fail(parsed.error.issues);

    const target = await deps.users.findById(id);
    if (!target) throw notFoundOrForbidden();

    // An admin must not be able to demote or suspend themselves into a state
    // where nobody can administer the platform.
    if (id === admin.userId) {
      if (parsed.data.role === 'customer') {
        throw conflict('You cannot remove your own admin role', 'self_demotion_blocked');
      }
      if (parsed.data.status === 'suspended') {
        throw conflict('You cannot suspend your own account', 'self_suspension_blocked');
      }
    }

    if (parsed.data.status) await deps.users.updateStatus(id, parsed.data.status);
    const rest = {
      ...(parsed.data.unlimitedMode !== undefined ? { unlimitedMode: parsed.data.unlimitedMode } : {}),
      ...(parsed.data.allowLiveKeys !== undefined ? { allowLiveKeys: parsed.data.allowLiveKeys } : {}),
      ...(parsed.data.role ? { role: parsed.data.role } : {}),
    };
    if (Object.keys(rest).length > 0) await deps.users.updateAdminFields(id, rest);

    await deps.audit.record({
      actorUserId: admin.userId,
      action: 'admin.customer_updated',
      resourceType: 'user',
      resourceId: id,
      metadata: { ...parsed.data },
      ...meta(request),
    });

    const updated = await deps.users.findById(id);
    return {
      customer: updated && {
        id: updated.id,
        email: updated.email,
        name: updated.name,
        role: updated.role,
        status: updated.status,
        unlimitedMode: updated.unlimitedMode,
        allowLiveKeys: updated.allowLiveKeys,
      },
    };
  });

  app.get('/api/admin/models', async () => {
    return { models: await deps.models.listAll(), providers: await deps.models.listProviders() };
  });

  app.patch('/api/admin/models/:id', async (request: FastifyRequest) => {
    const admin = requireAdmin(request);
    const { id } = request.params as { id: string };
    const body = request.body as { enabled?: boolean };
    if (typeof body?.enabled !== 'boolean') {
      throw badRequest('enabled must be a boolean', 'invalid_request', 'enabled');
    }
    const ok = await deps.models.setEnabled(id, body.enabled);
    if (!ok) throw notFoundOrForbidden();

    await deps.audit.record({
      actorUserId: admin.userId,
      action: body.enabled ? 'model.enabled' : 'model.disabled',
      resourceType: 'model',
      resourceId: id,
      ...meta(request),
    });
    return { ok: true, enabled: body.enabled };
  });

  app.get('/api/admin/system/usage', async () => {
    const [totals, customers, models] = await Promise.all([
      deps.requestsRepo.platformTotals(),
      deps.users.countCustomers(),
      deps.models.listAll(),
    ]);
    return { totals, customers, modelCount: models.length };
  });

  app.get('/api/admin/errors', async (request: FastifyRequest) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(Number(query.limit ?? 50) || 50, 200);
    return { errors: await deps.requestsRepo.recentErrors(limit) };
  });

  app.get('/api/admin/providers/health', async () => ({ health: deps.health.getAll() }));

  /**
   * Live operational counters, summarised from the same registry that backs
   * `GET /metrics`. The dashboard reads this instead of parsing the Prometheus
   * text format in the browser, so p95 here means what it means in a panel.
   */
  app.get('/api/admin/metrics', async () => {
    const summary = await summarizeMetrics(deps.metrics);
    return { summary, providers: deps.health.getAll() };
  });

  app.get('/api/admin/audit', async (request: FastifyRequest) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(Number(query.limit ?? 200) || 200, 1000);
    return { entries: await deps.audit.listRecent(limit) };
  });
}
