import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '@synzo/config';
import { hashApiKey } from '../lib/crypto.js';
import { invalidApiKey } from '../lib/errors.js';
import type { ApiKeyRepository } from '../repositories/api-key.repository.js';
import type { UserRepository } from '../repositories/user.repository.js';

export interface ApiKeyContext {
  keyId: string;
  userId: string;
  projectId: string;
  environment: 'live' | 'test';
  limits: {
    requestsPerMinute: number;
    requestsPerDay: number;
    tokensPerDay: number;
    maxConcurrentRequests: number;
    allowedModels: string | null;
    /**
     * Images this customer may attach per request. `null` means unlimited at
     * the plan level, and is still subject to the platform ceiling enforced by
     * the request schema.
     */
    maxImages: number | null;
    /**
     * When the plan lapses, carried so the image counter can be given exactly
     * that lifetime rather than outliving the subscription it belongs to.
     */
    planExpiresAt: Date | null;
  };
  unlimited: boolean;
  allowLiveKeys: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: ApiKeyContext;
  }
}

/**
 * Extracts the bearer token. Any malformed Authorization header is treated
 * exactly like a wrong key — the caller must not learn which it was (§6).
 */
function readBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = (match[1] ?? '').trim();
  if (!token) return null;
  // Reject absurd lengths early; real keys are 48 chars.
  if (token.length > 512) return null;
  return token;
}

/**
 * Authenticates an API key and attaches the tenant context.
 *
 * Every failure path returns the identical `401 invalid_api_key`, whether the
 * key was absent, malformed, unknown, revoked, disabled, expired, or owned by
 * a suspended account. No distinguishing detail is returned or logged at a
 * level a customer could observe.
 */
export function createApiKeyAuth(config: AppConfig, keys: ApiKeyRepository, users: UserRepository) {
  return async function apiKeyAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const token = readBearer(request.headers.authorization);
    if (!token) throw invalidApiKey();

    // Validate the shape before touching the database, but still answer with
    // the same generic error.
    if (!/^sk_(live|test)_[A-Za-z0-9]{8,}$/.test(token)) throw invalidApiKey();

    const keyHash = hashApiKey(token, config.security.apiKeyPepper);
    const found = await keys.findValidKey(keyHash);
    if (!found) throw invalidApiKey();

    const limits = await users.getLimits(found.userId);
    const user = await users.findById(found.userId);
    if (!user || user.status !== 'active') throw invalidApiKey();

    /**
     * A paid plan that has run out serves the base grant instead of the paid
     * one, resolved here rather than by a background sweep so a 7-day tier stops
     * on the 7th day rather than up to a day later.
     *
     * The paid values stay on the row, so a renewal restores access and the
     * customer does not re-purchase anything.
     */
    const planExpired =
      limits.planExpiresAt !== null && limits.planExpiresAt.getTime() <= Date.now();
    const effective = planExpired
      ? { allowedModels: limits.baseAllowedModels, maxImages: limits.baseMaxImages }
      : { allowedModels: limits.allowedModels, maxImages: limits.maxImages };

    request.apiKey = {
      keyId: found.keyId,
      userId: found.userId,
      projectId: found.projectId,
      environment: found.environment,
      limits: {
        requestsPerMinute: limits.requestsPerMinute,
        requestsPerDay: limits.requestsPerDay,
        tokensPerDay: limits.tokensPerDay,
        maxConcurrentRequests: limits.maxConcurrentRequests,
        allowedModels: effective.allowedModels,
        maxImages: effective.maxImages,
        planExpiresAt: limits.planExpiresAt,
      },
      unlimited: user.unlimitedMode,
      allowLiveKeys: user.allowLiveKeys,
    };
  };
}
