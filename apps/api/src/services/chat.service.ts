import { randomUUID } from 'node:crypto';
import type { AppConfig } from '@synzo/config';
import type { ChatMessage } from '@synzo/types';
import { HttpError, badRequest, notFound, upstreamTimeout } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { AIProvider, NormalizedUsage } from '../providers/provider.interface.js';
import type { ProviderRegistry } from '../providers/provider.registry.js';
import type { ModelRepository } from '../repositories/model.repository.js';
import type { RequestRepository, RecordRequestInput } from '../repositories/request.repository.js';
import type { RateLimitService } from './rate-limit.service.js';
import type { ApiKeyContext } from '../middleware/api-key-auth.js';

export interface ChatServiceDeps {
  config: AppConfig;
  logger: Logger;
  models: ModelRepository;
  providers: ProviderRegistry;
  requestsRepo: RequestRepository;
  rateLimiter: RateLimitService;
}

export interface ResolvedChatRequest {
  requestId: string;
  modelName: string;
  modelId: string;
  provider: AIProvider;
  messages: ChatMessage[];
  stream: boolean;
  maxTokens: number | undefined;
  requestContent: string | null;
}

export function generateRequestId(): string {
  return `req_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/**
 * Owns the end-to-end lifecycle of a chat request: resolve model, enforce
 * per-customer limits, call the provider, and record exactly what happened.
 * Both the streaming and non-streaming paths funnel through here so accounting
 * and limit accounting can never diverge between them.
 */
export class ChatService {
  constructor(private readonly deps: ChatServiceDeps) {}

  /**
   * Validates the model against the registry and the customer's allowlist.
   *
   * A model that does not exist and a model the customer may not use both
   * return 404, so probing cannot enumerate the platform's model catalog.
   */
  async resolveModel(ctx: ApiKeyContext, modelName: string) {
    const model = await this.deps.models.findEnabled(modelName);
    if (!model) throw notFound(`Model "${modelName}" does not exist or is not available`, 'invalid_model');
    if (!model.providerEnabled) {
      throw notFound(`Model "${modelName}" is not currently available`, 'invalid_model');
    }

    const allow = ctx.limits.allowedModels;
    if (allow) {
      let allowed: string[];
      try {
        const parsed: unknown = JSON.parse(allow);
        allowed = Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        allowed = [];
      }
      if (!allowed.includes(modelName)) {
        throw notFound(`Model "${modelName}" is not available on your plan`, 'invalid_model');
      }
    }
    return model;
  }

  /** Serializes message content for optional storage. Null unless explicitly enabled. */
  private captureContent(messages: ChatMessage[]): string | null {
    const { logRequestContent, logRequestContentMaxChars } = this.deps.config.logging;
    if (!logRequestContent || logRequestContentMaxChars <= 0) return null;
    const serialized = JSON.stringify(messages);
    return serialized.slice(0, logRequestContentMaxChars);
  }

  async prepare(
    ctx: ApiKeyContext,
    body: { model: string; messages: ChatMessage[]; stream?: boolean; max_tokens?: number },
  ): Promise<ResolvedChatRequest> {
    const model = await this.resolveModel(ctx, body.model);
    const provider = this.deps.providers.getOrThrow(model.provider);
    const stream = body.stream === true;

    await this.deps.rateLimiter.checkAndConsume({
      userId: ctx.userId,
      apiKeyId: ctx.keyId,
      requestsPerMinute: ctx.limits.requestsPerMinute,
      requestsPerDay: ctx.limits.requestsPerDay,
      tokensPerDay: ctx.limits.tokensPerDay,
      maxConcurrentRequests: ctx.limits.maxConcurrentRequests,
      unlimited: ctx.unlimited,
    });

    return {
      requestId: generateRequestId(),
      modelName: model.publicName,
      modelId: model.id,
      provider,
      messages: body.messages,
      stream,
      maxTokens: body.max_tokens,
      requestContent: this.captureContent(body.messages),
    };
  }

  /**
   * Releases the concurrency slot acquired in `prepare`. Safe to call more than
   * once; the limiter treats a negative counter as zero.
   */
  async release(ctx: ApiKeyContext): Promise<void> {
    await this.deps.rateLimiter.releaseConcurrency(ctx.keyId);
  }

  private baseRecord(
    ctx: ApiKeyContext,
    resolved: ResolvedChatRequest,
    startedAt: number,
  ): RecordRequestInput {
    return {
      requestId: resolved.requestId,
      userId: ctx.userId,
      projectId: ctx.projectId,
      apiKeyId: ctx.keyId,
      modelId: resolved.modelId,
      modelName: resolved.modelName,
      provider: resolved.provider.name,
      status: 'error',
      httpStatus: 500,
      stream: resolved.stream,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      upstreamCost: null,
      currency: null,
      latencyMs: 0,
      requestContent: resolved.requestContent,
    };
  }

  /** Records a failed request. Never throws — accounting must not mask the real error. */
  private async recordQuietly(record: RecordRequestInput, ctx: ApiKeyContext): Promise<void> {
    try {
      await this.deps.requestsRepo.record(record);
    } catch (err) {
      this.deps.logger.error('Failed to record request', {
        requestId: record.requestId,
        error: err instanceof Error ? err.message : 'unknown',
      });
    } finally {
      await this.deps.rateLimiter.releaseConcurrency(ctx.keyId);
    }
  }

  /** Maps a provider throw into a client-safe HttpError. */
  private normalizeProviderError(err: unknown): HttpError {
    if (err instanceof HttpError) return err;
    const e = err as { httpStatus?: number; code?: string; type?: string; message?: string; name?: string };

    if (e?.name === 'AbortError' || (err instanceof Error && /abort/i.test(err.message))) {
      return upstreamTimeout();
    }
    if (e?.httpStatus === 404 || e?.code === 'invalid_model') {
      return notFound('The requested model is not available', 'invalid_model');
    }
    if (e?.httpStatus === 429) {
      return new HttpError({
        statusCode: 429,
        message: 'The upstream provider is rate limiting requests. Please retry shortly.',
        type: 'rate_limit_error',
        code: 'upstream_rate_limited',
      });
    }
    if (e?.httpStatus && e.httpStatus >= 500) {
      return new HttpError({
        statusCode: 502,
        message: 'The upstream provider is currently unavailable',
        type: 'upstream_error',
        code: 'upstream_unavailable',
      });
    }
    // Never echo an arbitrary upstream message that we have not vetted.
    return new HttpError({
      statusCode: 502,
      message: 'The upstream provider could not complete this request',
      type: 'upstream_error',
      code: 'upstream_error',
    });
  }

  async complete(
    ctx: ApiKeyContext,
    resolved: ResolvedChatRequest,
    signal: AbortSignal,
  ): Promise<{ body: Record<string, unknown>; httpStatus: number }> {
    const startedAt = Date.now();
    const record = this.baseRecord(ctx, resolved, startedAt);

    try {
      const result = await resolved.provider.chat(
        {
          model: resolved.modelName,
          messages: resolved.messages,
          stream: false,
          ...(resolved.maxTokens !== undefined ? { max_tokens: resolved.maxTokens } : {}),
        },
        signal,
      );

      record.status = 'success';
      record.httpStatus = 200;
      record.promptTokens = result.usage.promptTokens;
      record.completionTokens = result.usage.completionTokens;
      record.totalTokens = result.usage.totalTokens;
      record.upstreamCost = result.usage.upstreamCost;
      record.currency = result.usage.currency;
      record.latencyMs = result.latencyMs;

      await this.deps.requestsRepo.record(record);
      await this.deps.rateLimiter.withTokenLock(ctx.keyId, () =>
        this.deps.rateLimiter.recordTokens(
          {
            userId: ctx.userId,
            apiKeyId: ctx.keyId,
            requestsPerMinute: ctx.limits.requestsPerMinute,
            requestsPerDay: ctx.limits.requestsPerDay,
            tokensPerDay: ctx.limits.tokensPerDay,
            maxConcurrentRequests: ctx.limits.maxConcurrentRequests,
            unlimited: ctx.unlimited,
          },
          result.usage.totalTokens,
        ),
      );
      // Release via releaseConcurrency exactly once on the success path too.
      await this.deps.rateLimiter.releaseConcurrency(ctx.keyId);

      return { body: result.body, httpStatus: 200 };
    } catch (err) {
      const httpError = this.normalizeProviderError(err);
      record.status = signal.aborted ? 'cancelled' : 'error';
      record.httpStatus = httpError.statusCode;
      record.errorType = httpError.type;
      record.errorCode = httpError.code;
      record.latencyMs = Date.now() - startedAt;
      await this.recordQuietly(record, ctx);
      throw httpError;
    }
  }

  /**
   * Records the outcome of a finished stream. Called once the response has
   * been fully flushed (or the client vanished).
   */
  async recordStreamOutcome(
    ctx: ApiKeyContext,
    resolved: ResolvedChatRequest,
    outcome: { usage: NormalizedUsage | null; status: 'success' | 'error' | 'cancelled'; errorCode?: string },
    startedAt: number,
  ): Promise<void> {
    const record = this.baseRecord(ctx, resolved, startedAt);
    record.status = outcome.status;
    record.httpStatus = outcome.status === 'success' ? 200 : outcome.status === 'cancelled' ? 499 : 502;
    record.errorCode = outcome.errorCode ?? null;
    record.errorType = outcome.errorCode ? 'upstream_error' : null;
    record.latencyMs = Date.now() - startedAt;

    if (outcome.usage) {
      record.promptTokens = outcome.usage.promptTokens;
      record.completionTokens = outcome.usage.completionTokens;
      record.totalTokens = outcome.usage.totalTokens;
      record.upstreamCost = outcome.usage.upstreamCost;
      record.currency = outcome.usage.currency;
    }

    try {
      await this.deps.requestsRepo.record(record);
      const streamUsage = outcome.usage;
      if (streamUsage?.totalTokens) {
        await this.deps.rateLimiter.withTokenLock(ctx.keyId, () =>
          this.deps.rateLimiter.recordTokens(
            {
              userId: ctx.userId,
              apiKeyId: ctx.keyId,
              requestsPerMinute: ctx.limits.requestsPerMinute,
              requestsPerDay: ctx.limits.requestsPerDay,
              tokensPerDay: ctx.limits.tokensPerDay,
              maxConcurrentRequests: ctx.limits.maxConcurrentRequests,
              unlimited: ctx.unlimited,
            },
            streamUsage.totalTokens,
          ),
        );
      }
    } catch (err) {
      this.deps.logger.error('Failed to record stream outcome', {
        requestId: record.requestId,
        error: err instanceof Error ? err.message : 'unknown',
      });
    } finally {
      await this.deps.rateLimiter.releaseConcurrency(ctx.keyId);
    }
  }
}
