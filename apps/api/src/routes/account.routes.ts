import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '@synzo/config';
import type { Redis } from 'ioredis';
import { HttpError, badRequest, notFound } from '../lib/errors.js';
import { hashPassword } from '../lib/crypto.js';
import type { UserRepository } from '../repositories/user.repository.js';
import type { SessionRepository } from '../repositories/session.repository.js';
import type { AuditRepository } from '../repositories/audit.repository.js';
import type { AccountTokenService } from '../services/account-token.service.js';
import type { SessionService } from '../middleware/session-auth.js';

interface AccountDeps {
  config: AppConfig;
  users: UserRepository;
  sessions: SessionRepository;
  sessionService: SessionService;
  accountTokens: AccountTokenService;
  audit: AuditRepository;
  redis: Redis;
}

function meta(request: FastifyRequest) {
  return {
    ip: request.ip ?? null,
    userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
  };
}

/**
 * Password reset and email verification (§8).
 *
 * The two request endpoints are deliberately indistinguishable between "no
 * such account" and "account found, email sent": both answer 202 with the same
 * body. Anything else turns these into an account-enumeration oracle, which is
 * exactly the kind of thing a password-reset form should not be.
 */
export async function registerAccountRoutes(app: FastifyInstance, deps: AccountDeps): Promise<void> {
  const { config, users, sessions, sessionService, accountTokens, audit, redis } = deps;

  const genericAck = { ok: true, message: 'If that account exists, an email is on its way.' };

  // Brute-force protection, keyed separately from login because a reset token
  // is a credential too: an unlimited guessing loop against the consume
  // endpoint is otherwise possible.
  const requestKey = (email: string, ip: string) => `pwreset-request:${email}:${ip}`;
  /**
   * Keyed by user id, not IP. The abuse being prevented here is a signed-in
   * customer mailing their own address over and over, and that actor is
   * identified by the session — keying on IP instead would make every customer
   * behind a shared egress address (office NAT, a CI runner, a mobile carrier)
   * spend one common budget of three and lock each other out of a mail that is
   * legitimately theirs.
   */
  const verifyKey = (userId: string) => `email-verify:${userId}`;

  app.post('/api/auth/password/forgot', async (request: FastifyRequest, reply) => {
    const parsed = z.object({ email: z.string().trim().toLowerCase().pipe(z.string().email()) }).safeParse(request.body);
    if (!parsed.success) throw badRequest('A valid email is required', 'invalid_request', 'email');
    const { email } = parsed.data;
    const ip = request.ip ?? 'unknown';

    const key = requestKey(email, ip);
    const attempts = Number((await redis.get(key)) ?? 0);
    if (attempts >= config.bruteForce.maxAttempts) {
      // Same response as success. A rate limit here would itself reveal
      // nothing about account existence, but the generic body keeps it simple
      // and matches the "always the same answer" contract.
      return reply.status(202).send(genericAck);
    }

    const found = await users.findByEmail(email);
    if (found.length > 0) {
      const user = found[0];
      if (user && user.status === 'active') {
        await accountTokens.issue(
          { id: user.id, email: user.email },
          'password_reset',
          meta(request),
        );
        await audit.record({
          actorUserId: user.id,
          action: 'auth.password_reset_requested',
          resourceType: 'user',
          resourceId: user.id,
          ...meta(request),
        });
      }
    }

    await redis.incr(key);
    await redis.expire(key, config.bruteForce.attemptWindowSeconds);
    return reply.status(202).send(genericAck);
  });

  app.post('/api/auth/password/reset', async (request: FastifyRequest) => {
    const parsed = z
      .object({
        token: z.string().min(10),
        password: z.string().min(10, 'password must be at least 10 characters'),
      })
      .safeParse(request.body);
    if (!parsed.success) throw badRequest('A valid token and password are required', 'invalid_request');

    const consumed = await accountTokens.consume(parsed.data.token, 'password_reset');
    if (!consumed) {
      throw new HttpError({
        statusCode: 400,
        message: 'This reset link is invalid or has expired',
        type: 'invalid_request_error',
        code: 'invalid_reset_token',
      });
    }

    if (parsed.data.password.length > config.security.passwordMaxLength) {
      throw badRequest('Password is too long', 'invalid_request', 'password');
    }

    await users.updatePassword(consumed.userId, await hashPassword(parsed.data.password));
    // A password reset must evict every existing session; otherwise a stolen
    // session survives the very action taken to lock the attacker out.
    await sessions.destroyAllForUser(consumed.userId);
    await audit.record({
      actorUserId: consumed.userId,
      action: 'auth.password_reset',
      resourceType: 'user',
      resourceId: consumed.userId,
      ...meta(request),
    });

    return { ok: true, reauthenticate: true };
  });

  app.post('/api/auth/email/verify', async (request: FastifyRequest, reply) => {
    const parsed = z.object({ token: z.string().min(10) }).safeParse(request.body);
    if (!parsed.success) throw badRequest('A valid token is required', 'invalid_request');

    const consumed = await accountTokens.consume(parsed.data.token, 'email_verification');
    if (!consumed) {
      throw new HttpError({
        statusCode: 400,
        message: 'This verification link is invalid or has expired',
        type: 'invalid_request_error',
        code: 'invalid_verification_token',
      });
    }

    await users.markEmailVerified(consumed.userId);
    await audit.record({
      actorUserId: consumed.userId,
      action: 'auth.email_verified',
      resourceType: 'user',
      resourceId: consumed.userId,
      ...meta(request),
    });

    // Verification is a "get them into the product" moment, so it signs them in
    // rather than making them type a password they just created. The session
    // comes from the consumed token, never from the request alone.
    const { token, expiresAt } = await sessionService.issue(consumed.userId, meta(request));
    reply.setCookie(config.security.sessionCookieName, token, sessionService.cookieOptions(expiresAt));

    return { ok: true, emailVerified: true };
  });

  /**
   * Re-sends a verification email to the signed-in customer, for the
   * "still unverified" banner in the dashboard. Limited per account so a
   * signed-in customer cannot use it to mail-bomb their own address.
   */
  app.post('/api/auth/email/resend', async (request: FastifyRequest) => {
    const session = (request as FastifyRequest & { sessionUser?: { userId: string } }).sessionUser;
    if (!session) {
      throw new HttpError({
        statusCode: 401,
        message: 'Sign in to resend a verification email',
        type: 'authentication_error',
        code: 'unauthenticated',
      });
    }

    const record = await users.findById(session.userId);
    if (!record) throw notFound('Account not found');
    if (record.emailVerified) return { ok: true, emailVerified: true, resent: false };

    const key = verifyKey(record.id);
    const attempts = Number((await redis.get(key)) ?? 0);
    if (attempts >= config.bruteForce.maxAttempts) {
      throw new HttpError({
        statusCode: 429,
        message: 'Too many verification emails requested. Try again shortly.',
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded',
      });
    }

    await accountTokens.issue(
      { id: record.id, email: record.email },
      'email_verification',
      meta(request),
    );
    await redis.incr(key);
    await redis.expire(key, config.bruteForce.attemptWindowSeconds);

    return { ok: true, emailVerified: false, resent: true };
  });
}
