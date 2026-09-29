import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '@synzo/config';
import { sha256Hex } from '../lib/crypto.js';
import { HttpError } from '../lib/errors.js';
import type { SessionRepository } from '../repositories/session.repository.js';

export interface SessionUser {
  userId: string;
  email: string;
  name: string;
  role: string;
  sessionId: string;
  unlimitedMode: boolean;
  allowLiveKeys: boolean;
  /**
   * The account's approval state.
   *
   * Carried on the session because a PENDING or REJECTED customer has to be
   * able to sign in — they need somewhere to read why they cannot use the API
   * and to reach the paywall. Blocking them at sign-in would leave an
   * applicant with no way to learn anything, and the spec requires the status
   * to be VISIBLE in the customer dashboard.
   *
   * The gate that matters is therefore NOT here: it is in the API-key path,
   * which is the only thing that can actually spend credits.
   */
  status: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    sessionUser?: SessionUser;
  }
}

function unauthorized(): HttpError {
  return new HttpError({
    statusCode: 401,
    message: 'Authentication required',
    type: 'authentication_error',
    code: 'unauthenticated',
  });
}

function forbidden(): HttpError {
  return new HttpError({
    statusCode: 403,
    message: 'You do not have access to this resource',
    type: 'permission_error',
    code: 'forbidden',
  });
}

export class SessionService {
  constructor(
    private readonly config: AppConfig,
    private readonly sessions: SessionRepository,
  ) {}

  async issue(userId: string, meta: { userAgent: string | null; ip: string | null }) {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = sha256Hex(token);
    const expiresAt = new Date(Date.now() + this.config.security.sessionTtlHours * 3600_000);
    await this.sessions.create({ userId, tokenHash, expiresAt, ...meta });
    return { token, expiresAt };
  }

  async revoke(token: string): Promise<void> {
    await this.sessions.destroy(sha256Hex(token));
  }

  cookieOptions(expiresAt: Date) {
    return {
      httpOnly: true,
      secure: this.config.security.sessionCookieSecure,
      sameSite: 'lax' as const,
      path: '/',
      expires: expiresAt,
    };
  }
}

/**
 * Reads and validates the session cookie, attaching the user when valid.
 * The cookie name is taken from config rather than hard-coded, so a deployment
 * that renames SESSION_COOKIE_NAME keeps resolving sessions.
 */
export function createSessionResolver(sessions: SessionRepository, cookieName: string) {
  return async function resolveSession(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const cookies = (request as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies;
    const token = cookies?.[cookieName];
    if (!token) return;
    const resolved = await sessions.resolve(sha256Hex(token));
    if (!resolved) return;
    request.sessionUser = {
      userId: resolved.userId,
      email: resolved.email,
      name: resolved.name,
      role: resolved.role,
      sessionId: resolved.sessionId,
      unlimitedMode: resolved.unlimitedMode,
      allowLiveKeys: resolved.allowLiveKeys,
      status: resolved.status,
    };
  };
}

/** Rejects the request unless a valid session is present. */
export function requireSession(request: FastifyRequest): SessionUser {
  if (!request.sessionUser) throw unauthorized();
  return request.sessionUser;
}

/**
 * Requires a signed-in account that is not suspended.
 *
 * 'pending' and 'rejected' are allowed through: both are states a customer is
 * expected to SEE and act on (read their balance, buy credits, read why they
 * are blocked), and the routes that must be closed to them are closed by their
 * own handlers. 'suspended' is not, because suspending an existing working
 * account is a deliberate operator action and the whole point of it is that the
 * account stops working immediately.
 */
export function requireActiveAccount(request: FastifyRequest): SessionUser {
  const user = requireSession(request);
  if (user.status === 'suspended') throw forbidden();
  return user;
}

/** Rejects the request unless the caller is an admin (§24). */
export function requireAdmin(request: FastifyRequest): SessionUser {
  const user = requireSession(request);
  if (user.role !== 'admin') throw forbidden();
  return user;
}
