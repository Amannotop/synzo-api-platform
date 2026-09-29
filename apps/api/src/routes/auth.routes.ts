import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { loginSchema, registerSchema } from '@synzo/validation';
import type { AppConfig } from '@synzo/config';
import { LOCAL_ORIGIN, originContext, resolvePublicOrigin } from '../lib/public-origin.js';
import { conflict, badRequest, HttpError, notFound } from '../lib/errors.js';
import { fakePasswordHash, hashPassword, verifyPassword } from '../lib/crypto.js';
import { parseAllowedModels } from '../lib/allowed-models.js';
import type { SessionService } from '../middleware/session-auth.js';
import { requireSession } from '../middleware/session-auth.js';
import type { CreditRepository } from '../repositories/credit.repository.js';
import type { UserRepository } from '../repositories/user.repository.js';
import type { SessionRepository } from '../repositories/session.repository.js';
import type { AuditRepository } from '../repositories/audit.repository.js';
import type { Redis } from 'ioredis';
import type { RateLimitService } from '../services/rate-limit.service.js';
import type { AccountTokenService } from '../services/account-token.service.js';

interface AuthDeps {
  config: AppConfig;
  users: UserRepository;
  sessions: SessionRepository;
  sessionService: SessionService;
  audit: AuditRepository;
  redis: Redis;
  rateLimiter: RateLimitService;
  accountTokens: AccountTokenService;
  /**
   * Used only to grant the one-time free trial at activation, when the
   * deployment runs without an approval queue. See the call site for why the
   * grant cannot live in the repository's own `create`.
   */
  credits: CreditRepository;
}

/** Request facts recorded against audit rows and sessions. */
function meta(request: FastifyRequest) {
  return {
    ip: request.ip ?? null,
    userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
  };
}

/**
 * The origin the customer reached us on, so a reset or verification email
 * contains a link back to the domain they are actually using rather than a
 * hardcoded development address.
 */
function originFor(request: FastifyRequest, config: AppConfig): string {
  return resolvePublicOrigin(request, originContext(config), LOCAL_ORIGIN).origin;
}

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): Promise<void> {
  const { config, users, sessions, sessionService, audit, redis, rateLimiter, accountTokens, credits } = deps;

  /**
   * Brute-force protection keyed by email+IP (§31). A successful login clears
   * the counter, so a legitimate user who mistypes twice is not punished.
   */
  const attemptKey = (email: string, ip: string) => `login:${email}:${ip}`;
  const tooManyAttempts = async (key: string): Promise<number> => {
    const count = await redis.get(key);
    return count ? Number(count) : 0;
  };

  app.post('/api/auth/register', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!config.features.registrationEnabled) {
      throw new HttpError({
        statusCode: 403,
        message: 'Registration is currently disabled',
        type: 'permission_error',
        code: 'registration_disabled',
      });
    }

    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw badRequest(first?.message ?? 'Invalid registration payload', 'invalid_request', first?.path.join('.'));
    }
    const { email, password, name } = parsed.data;

    if (password.length > config.security.passwordMaxLength) {
      throw badRequest('Password is too long', 'invalid_request', 'password');
    }

    const existing = await users.findByEmail(email);
    if (existing.length > 0) {
      throw conflict('An account with that email already exists', 'email_taken');
    }

    const passwordHash = await hashPassword(password);
    /**
     * Whether a signup starts as 'pending' is deployment policy, so it is
     * decided here from APPROVAL_REQUIRED rather than inside the repository.
     * The repository overrides it for the founding admin, who has nobody to
     * approve them.
     *
     * Note the asymmetry: this only affects accounts registered from now on.
     * Nobody already using the API loses access, which is what makes the flag
     * safe to switch on in a live deployment.
     */
    const created = await users.create({
      email,
      passwordHash,
      name,
      status: config.credits.approvalRequired ? 'pending' : 'active',
    });

    /**
     * When approval is not required, the account is ALREADY active, and
     * activation is what grants the one-time free trial (see
     * CreditRepository.approveAccount). Without this the trial would only ever
     * be grantable by an admin, so a deployment running with
     * APPROVAL_REQUIRED=false would have no way for a customer to ever hold
     * credits and the API would be unusable for everyone.
     *
     * The trial still happens exactly once, at activation, and never for a
     * pending account — a 'pending' signup returns from `users.create` and
     * skips this entirely, so it receives no credits until an admin approves
     * it, which is the spec's explicit requirement.
     *
     * The founding admin is skipped too: they are exempt from credit
     * accounting by role, and the guard is here so a first-run deployment
     * does not hand the operator a customer-shaped balance.
     */
    let freeTrialGranted = false;
    if (created.status === 'active' && created.role !== 'admin') {
      const trial = await credits.approveAccount({
        userId: created.id,
        // Self-serve activation has no admin actor. Recorded as null rather
        // than as the account itself, so the ledger never implies a person
        // approved this — and because `actor_user_id` is a nullable uuid, null
        // is the only valid way to say "nobody".
        adminId: null,
        trialTokens: config.credits.freeTrialTokens,
        note: 'Self-serve activation (approval not required)',
      });
      freeTrialGranted = trial.ok && !trial.alreadyTrialed;
    }

    // A brand-new account is unverified. The verification token is the only
    // proof that whoever registered controls the address, so it is issued here
    // rather than waiting to be requested: a customer who never sees the email
    // still has Settings > Resend when they notice.
    await accountTokens.issue(
      { id: created.id, email },
      'email_verification',
      { ...meta(request), publicOrigin: originFor(request, config) },
    );

    await audit.record({
      actorUserId: created.id,
      action: 'user.registered',
      resourceType: 'user',
      resourceId: created.id,
      ...meta(request),
    });

    const { token, expiresAt } = await sessionService.issue(created.id, meta(request));
    reply.setCookie(config.security.sessionCookieName, token, sessionService.cookieOptions(expiresAt));

    return reply.status(201).send({
      user: { id: created.id, email, name, role: created.role, status: created.status },
      // A pending signup is a success, not a failure — the account was created
      // and a verification email was sent. Telling the client which of the two
      // states it is in lets the dashboard say "we will review your account"
      // instead of the ambiguous "check your email to continue".
      approvalRequired: created.status === 'pending',
      // Reported so the dashboard can say "here is your trial balance" on
      // arrival. False for a pending signup, which correctly has none yet.
      freeTrialGranted,
    });
  });

  app.post('/api/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('Email and password are required', 'invalid_request');
    }
    const { email, password } = parsed.data;
    const key = attemptKey(email, request.ip ?? 'unknown');

    const attempts = await tooManyAttempts(key);
    if (attempts >= config.bruteForce.maxAttempts) {
      throw new HttpError({
        statusCode: 429,
        message: 'Too many login attempts. Please try again later.',
        type: 'rate_limit_error',
        code: 'too_many_login_attempts',
      });
    }

    const found = await users.findByEmail(email);
    const user = found[0];

    if (!user) {
      // Burn comparable CPU so a missing account is not detectable by timing.
      await fakePasswordHash();
      await redis.incr(key);
      await redis.expire(key, config.bruteForce.attemptWindowSeconds);
      throw new HttpError({
        statusCode: 401,
        message: 'Invalid email or password',
        type: 'authentication_error',
        code: 'invalid_credentials',
      });
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      await redis.incr(key);
      await redis.expire(key, config.bruteForce.attemptWindowSeconds);
      await audit.record({
        actorUserId: user.id,
        action: 'auth.login_failed',
        resourceType: 'user',
        resourceId: user.id,
        ...meta(request),
      });
      throw new HttpError({
        statusCode: 401,
        message: 'Invalid email or password',
        type: 'authentication_error',
        code: 'invalid_credentials',
      });
    }

    /**
     * Each blocked state gets its own message, because the customer's next
     * action genuinely differs and a single "account disabled" tells them
     * nothing:
     *
     *  - pending  → wait for an administrator; nothing is wrong
     *  - rejected → contact support; a decision was made against them
     *  - suspended → an operator switched off a previously working account
     *
     * Sign-in itself is NOT refused for pending or rejected. They still get a
     * session, because the dashboard is where they read this status and reach
     * the paywall. The gate that matters is the API-key path.
     */
    if (user.status === 'suspended') {
      throw new HttpError({
        statusCode: 403,
        message: 'This account has been suspended',
        type: 'permission_error',
        code: 'account_suspended',
      });
    }

    await redis.del(key);
    await users.touchLastLogin(user.id);

    const { token, expiresAt } = await sessionService.issue(user.id, meta(request));
    reply.setCookie(config.security.sessionCookieName, token, sessionService.cookieOptions(expiresAt));

    await audit.record({
      actorUserId: user.id,
      action: 'auth.login',
      resourceType: 'user',
      resourceId: user.id,
      ...meta(request),
    });

    return reply.send({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        status: user.status,
      },
    });
  });

  app.post('/api/auth/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    const cookies = (request as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies;
    const token = cookies?.[config.security.sessionCookieName];
    const user = request.sessionUser;

    if (token) await sessionService.revoke(token);
    reply.clearCookie(config.security.sessionCookieName, { path: '/' });

    if (user) {
      await audit.record({
        actorUserId: user.userId,
        action: 'auth.logout',
        resourceType: 'user',
        resourceId: user.userId,
        ...meta(request),
      });
    }
    return reply.send({ ok: true });
  });

  app.get('/api/me', async (request: FastifyRequest) => {
    const user = requireSession(request);
    const record = await users.findById(user.userId);
    if (!record) throw notFound('Account not found');
    const [limits, tokenUsage] = await Promise.all([
      users.getLimits(user.userId),
      rateLimiter.tokenUsage(user.userId),
    ]);
    return {
      user: {
        id: record.id,
        email: record.email,
        name: record.name,
        role: record.role,
        status: record.status,
        emailVerified: record.emailVerified,
        createdAt: record.createdAt,
        lastLoginAt: record.lastLoginAt,
        unlimitedMode: record.unlimitedMode,
        allowLiveKeys: record.allowLiveKeys,
      },
      limits: {
        requestsPerMinute: limits.requestsPerMinute,
        requestsPerDay: limits.requestsPerDay,
        tokensPerDay: limits.tokensPerDay,
        maxConcurrentRequests: limits.maxConcurrentRequests,
        // Always an array on the wire; the JSON-string storage detail is not
        // the customer's problem.
        allowedModels: parseAllowedModels(limits.allowedModels),
      },
      // Today's consumption, so the dashboard can show real quota progress
      // instead of a number the customer has to guess at.
      usage: { tokensToday: tokenUsage.customer },
    };
  });

  /** Change password and invalidate every other session. */
  app.post('/api/me/password', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireSession(request);
    const schema = z.object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(10, 'newPassword must be at least 10 characters'),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) throw badRequest('A valid current and new password are required', 'invalid_request');

    const record = await users.findById(user.userId);
    if (!record) throw notFound('Account not found');
    if (!(await verifyPassword(parsed.data.currentPassword, record.passwordHash))) {
      throw new HttpError({
        statusCode: 401,
        message: 'Current password is incorrect',
        type: 'authentication_error',
        code: 'invalid_credentials',
      });
    }

    await users.updatePassword(user.userId, await hashPassword(parsed.data.newPassword));
    await sessions.destroyAllForUser(user.userId);
    await audit.record({
      actorUserId: user.userId,
      action: 'auth.password_changed',
      resourceType: 'user',
      resourceId: user.userId,
      ...meta(request),
    });

    reply.clearCookie(config.security.sessionCookieName, { path: '/' });
    return reply.send({ ok: true, reauthenticate: true });
  });
}
