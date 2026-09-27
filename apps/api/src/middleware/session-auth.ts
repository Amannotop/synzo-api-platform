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

/** Reads and validates the session cookie, attaching the user when valid. */
export function createSessionResolver(sessions: SessionRepository) {
  return async function resolveSession(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const cookies = (request as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies;
    const token = cookies?.synzo_session;
    if (!token) return;
    const resolved = await sessions.resolve(sha256Hex(token));
    if (!resolved) return;
    request.sessionUser = {
      userId: resolved.userId,
      email: resolved.email,
      name: resolved.name,
      role: resolved.role,
      sessionId: resolved.sessionId,
    };
  };
}

/** Rejects the request unless a valid session is present. */
export function requireSession(request: FastifyRequest): SessionUser {
  if (!request.sessionUser) throw unauthorized();
  return request.sessionUser;
}

/** Rejects the request unless the caller is an admin (§24). */
export function requireAdmin(request: FastifyRequest): SessionUser {
  const user = requireSession(request);
  if (user.role !== 'admin') throw forbidden();
  return user;
}
