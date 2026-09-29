import { randomUUID } from 'node:crypto';
import type { AppConfig } from '@synzo/config';
import { assistantDisplayName, buildIdentityInstruction, modelExternalName, modelResponseName, resolveModelAlias } from '@synzo/config';
import type { ChatMessage } from '@synzo/types';
import { countImageParts } from '@synzo/types';
import {
  HttpError,
  imageLimitExceeded,
  imageSupportRequired,
  notFound,
  upstreamTimeout,
} from '../lib/errors.js';
import { parseAllowedModels } from '../lib/allowed-models.js';
import type { Logger } from '../lib/logger.js';
import type { AIProvider, ChatTool, NormalizedUsage, ToolChoice } from '../providers/provider.interface.js';
import type { ProviderRegistry } from '../providers/provider.registry.js';
import type { ModelRepository } from '../repositories/model.repository.js';
import type { RequestRepository, RecordRequestInput } from '../repositories/request.repository.js';
import type { AdmissionLease, RateLimitInput, RateLimitService } from './rate-limit.service.js';
import type { ApiKeyContext } from '../middleware/api-key-auth.js';
import type { Metrics } from '../metrics/registry.js';
import type { CreditService } from './credit.service.js';
import type { Reservation } from '../repositories/credit.repository.js';

export interface ChatServiceDeps {
  config: AppConfig;
  logger: Logger;
  models: ModelRepository;
  providers: ProviderRegistry;
  requestsRepo: RequestRepository;
  rateLimiter: RateLimitService;
  /**
   * Credit accounting. Optional so a caller that only exercises the model
   * resolution path does not have to construct a balance table; when it is
   * absent the service behaves exactly as it did before credits existed.
   */
  credits?: CreditService;
  /** Optional: a caller that only needs completions need not build a registry. */
  metrics?: Metrics;
}

export interface ResolvedChatRequest {
  requestId: string;
  /**
   * The public model name the customer asked for. This is what usage is
   * recorded and reported against, so dashboards and invoices show the name
   * the customer recognises.
   */
  modelName: string;
  /**
   * The provider's identifier for that model. This, and NOT `modelName`, is
   * what gets sent upstream. The two differ whenever a public name is an alias
   * for a provider model, which is the normal case for tiered catalogues.
   */
  upstreamModel: string;
  modelId: string;
  provider: AIProvider;
  messages: ChatMessage[];
  stream: boolean;
  maxTokens: number | undefined;
  /**
   * The customer's tools, carried through untouched. They are deliberately
   * NOT part of requestContent: that column stores what the customer sent for
   * audit, and a 128-tool schema dump would push the actual conversation out
   * of the captured prefix for no benefit.
   */
  tools: ChatTool[] | undefined;
  toolChoice: ToolChoice | undefined;
  requestContent: string | null;
  /**
   * The rate-limit admission granted for this request. Whoever finishes the
   * request (success, error, or client disconnect) must release it exactly
   * once; `release()` is idempotent so overlapping paths are safe.
   */
  lease: AdmissionLease;
  /**
   * The credits this request claimed before the upstream was called, or null
   * for an account exempt from credit accounting.
   *
   * Whoever finishes the request must settle or release it exactly once. The
   * repository makes both idempotent, so the streaming path, the non-streaming
   * path and a client disconnect can each arrive here without any of them
   * being able to double-spend or double-refund.
   */
  reservation: Reservation | null;
  /**
   * Image allowance claimed by this request, for a hand-back on a failure path.
   * 0 when the request carried no images or the plan is unlimited.
   *
   * The user id travels with it because `release()` is called from the streaming
   * and disconnect paths, which do not carry the auth context.
   */
  claimedImages: number;
  claimedImagesUserId: string;
}

/**
 * How long the image counter should live: the time left on the plan.
 *
 * A trial has no expiry, so it gets a long finite life. A TTL is used rather
 * than "no expiry" so the key cannot outlive the deployment, and so a customer
 * who later buys a real plan starts from a clean counter.
 */
function imageTtlSeconds(planExpiresAt: Date | null): number {
  const YEAR = 365 * 24 * 60 * 60;
  if (!planExpiresAt) return YEAR;
  const remaining = (planExpiresAt.getTime() - Date.now()) / 1000;
  return Math.max(60, remaining);
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
  async resolveModel(ctx: ApiKeyContext, requestedName: string) {
    // A customer may address a model by its display name ("GPT-6 Astra") or by
    // its tier ("max"). Both resolve to the same row; everything downstream
    // then works in public names only, so usage is recorded under one name and
    // an alias cannot split a customer's history across two series.
    const modelName = resolveModelAlias(requestedName);
    const model = await this.deps.models.findEnabled(modelName);
    if (!model) throw notFound(`Model "${requestedName}" does not exist or is not available`, 'invalid_model');
    if (!model.providerEnabled) {
      throw notFound(`Model "${modelExternalName(modelName)}" is not currently available`, 'invalid_model');
    }

    const allow = parseAllowedModels(ctx.limits.allowedModels);
    if (allow !== null && !allow.includes(modelName)) {
      throw notFound(`Model "${modelExternalName(modelName)}" is not available on your plan`, 'invalid_model');
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

  private limitInput(ctx: ApiKeyContext): RateLimitInput {
    return {
      userId: ctx.userId,
      apiKeyId: ctx.keyId,
      requestsPerMinute: ctx.limits.requestsPerMinute,
      requestsPerDay: ctx.limits.requestsPerDay,
      tokensPerDay: ctx.limits.tokensPerDay,
      maxConcurrentRequests: ctx.limits.maxConcurrentRequests,
      unlimited: ctx.unlimited,
    };
  }

  /**
   * Prepends the identity instruction to the conversation.
   *
   * Inserted as a system message ahead of everything the customer sent, so a
   * caller-supplied system message cannot sit in front of it and undercut it.
   * The customer's own system message is kept and follows ours, which preserves
   * their intended behaviour while leaving our instruction with the leading
   * position the model weights most heavily.
   *
   * Applied once in `prepare`, rather than at each call site, so the streaming
   * and non-streaming paths cannot drift apart — they both read
   * `resolved.messages`, and this is the only place that field is populated.
   *
   * The customer's own content is what gets recorded and billed as
   * `requestContent`; the instruction is not part of what they sent, so it is
   * not stored or counted as theirs.
   */
  private withIdentityInstruction(publicName: string, messages: ChatMessage[]): ChatMessage[] {
    const instruction: ChatMessage = {
      role: 'system',
      content: buildIdentityInstruction(publicName),
    };
    return [instruction, ...messages];
  }

  async prepare(
    ctx: ApiKeyContext,
    body: {
      model: string;
      messages: ChatMessage[];
      stream?: boolean;
      max_tokens?: number;
      tools?: ChatTool[];
      tool_choice?: ToolChoice;
    },
  ): Promise<ResolvedChatRequest> {
    const model = await this.resolveModel(ctx, body.model);
    const provider = this.deps.providers.getOrThrow(model.provider);
    const stream = body.stream === true;

    /**
     * Image entitlement is checked before the rate-limit slot is taken, and for
     * the same reason the model lookup is: a request that can never be served
     * must not consume admission, and must not reach the credit reservation
     * either. A customer on a text-only plan can send images all day and be
     * refused every time without ever touching a rate-limit counter.
     *
     * The allowance is a TOTAL for the subscription period, not a per-request
     * cap — a plan that includes three images has three images for the length of
     * the plan. It is therefore CLAIMED, not merely compared, so concurrent
     * requests cannot each observe room for themselves and jointly overspend.
     *
     * `maxImages` is per plan: 0 = none, a number = that many for the period,
     * null = unlimited. The platform ceiling in the request schema still applies
     * above it, so null means "as many as the platform will accept".
     *
     * Checked after the model, so a request for a model that is not on the plan
     * reports `invalid_model` and discloses nothing about the image rule.
     */
    const images = countImageParts(body.messages);
    let claimedImages = 0;
    if (images > 0) {
      const { maxImages } = ctx.limits;
      if (maxImages === 0) throw imageSupportRequired();
      if (maxImages !== null) {
        const ok = await this.deps.rateLimiter.consumeImageAllowance({
          userId: ctx.userId,
          count: images,
          allowance: maxImages,
          /**
           * The counter lives only as long as the plan does. A trial never
           * expires, so the key is given a long-but-finite life: long enough
           * that it is never the thing that resets, short enough that a key
           * cannot outlive the deployment by much.
           */
          ttlSeconds: imageTtlSeconds(ctx.limits.planExpiresAt),
        });
        if (!ok) throw imageLimitExceeded({ limit: maxImages, sent: images });
        claimedImages = images;
      }
    }

    // Admission is the LAST thing prepare does. If the model is unknown the
    // customer is not charged a rate-limit slot for a request that could
    // never have been served.
    const lease = await this.deps.rateLimiter.checkAndConsume(this.limitInput(ctx));

    const requestId = generateRequestId();

    /**
     * Credits are claimed after admission and before the provider is ever
     * called. That ordering is the guarantee: a request that cannot be paid
     * for is refused here, so no tokens are spent upstream on a response the
     * customer is not entitled to. Claiming worst-case rather than waiting for
     * real usage is what makes concurrent requests unable to overspend.
     *
     * If this throws (the balance is exhausted), the rate-limit slot taken
     * above has to go back, or a customer who is out of credits would also
     * slowly exhaust their request quota by trying.
     */
    let reservation: Reservation | null = null;
    if (this.deps.credits) {
      const estimate = this.deps.credits.estimateMaxTokens({
        messages: body.messages,
        maxTokens: body.max_tokens,
      });
      try {
        reservation = await this.deps.credits.reserve(
          { userId: ctx.userId, unlimited: ctx.unlimited },
          requestId,
          estimate,
        );
      } catch (err) {
        await lease.release();
        throw err;
      }
    }

    return {
      requestId,
      modelName: model.publicName,
      upstreamModel: model.upstreamModel,
      modelId: model.id,
      provider,
      messages: this.withIdentityInstruction(model.publicName, body.messages),
      stream,
      maxTokens: body.max_tokens,
      tools: body.tools,
      toolChoice: body.tool_choice,
      requestContent: this.captureContent(body.messages),
      lease,
      reservation,
      claimedImages,
      claimedImagesUserId: ctx.userId,
    };
  }

  /**
   * Releases the admission taken in `prepare`. Safe to call more than once and
   * safe for unlimited customers, who hold no slots at all.
   */
  async release(resolved: ResolvedChatRequest): Promise<void> {
    await resolved.lease.release();
    if (resolved.claimedImages > 0) {
      await this.deps.rateLimiter.releaseImageAllowance(
        resolved.claimedImagesUserId,
        resolved.claimedImages,
      );
    }
    if (this.deps.credits) {
      await this.deps.credits.release(
        { userId: resolved.reservation?.userId ?? '', unlimited: false },
        resolved.reservation,
      );
    }
  }

  private baseRecord(
    ctx: ApiKeyContext,
    resolved: ResolvedChatRequest,
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

  /**
   * Records a failed request. Never throws — accounting must not mask the real
   * error.
   *
   * The reservation is released here rather than settled. A request that
   * errored produced no usable output, so charging for the worst case would
   * bill the customer for a response they never received. If the upstream
   * partly answered before failing, the operator can reconcile from the
   * `requests` row; the alternative — freezing the worst-case estimate
   * indefinitely — is strictly worse for the customer.
   */
  private async recordQuietly(
    record: RecordRequestInput,
    ctx: ApiKeyContext,
    resolved: ResolvedChatRequest,
  ): Promise<void> {
    try {
      await this.deps.requestsRepo.record(record);
    } catch (err) {
      this.deps.logger.error('Failed to record request', {
        requestId: record.requestId,
        error: err instanceof Error ? err.message : 'unknown',
      });
    } finally {
      await this.deps.credits?.release(
        { userId: ctx.userId, unlimited: ctx.unlimited },
        resolved.reservation,
      );
      await this.returnImages(resolved, ctx);
      await resolved.lease.release();
    }
  }

  /**
   * Hands back image allowance claimed by a request that was never served.
   *
   * The images were not processed, so charging for them would be billing a
   * failure. Best effort by design: the alternative is failing the customer's
   * error handling over a counter that is already being released.
   */
  private async returnImages(resolved: ResolvedChatRequest, ctx: ApiKeyContext): Promise<void> {
    if (resolved.claimedImages <= 0) return;
    await this.deps.rateLimiter.releaseImageAllowance(ctx.userId, resolved.claimedImages);
  }

  /** Converts the reservation into real usage. Never throws; see CreditService. */
  private async settleReservation(
    ctx: ApiKeyContext,
    resolved: ResolvedChatRequest,
    usage: { totalTokens: number | null } | null,
  ): Promise<void> {
    if (!this.deps.credits) return;
    await this.deps.credits.settle(
      { userId: ctx.userId, unlimited: ctx.unlimited },
      resolved.reservation,
      usage,
    );
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
    /**
     * An upstream 401/403 is a misconfiguration, not a customer problem and
     * not a network fault. This is what a missing or rejected UPSTREAM_API_KEY
     * looks like, and it previously fell through to the generic 502 that reads
     * like the provider was merely unavailable — which sent the operator
     * looking at the network instead of at their own configuration.
     *
     * The message says what is wrong at the level an operator needs and stops
     * there: no upstream body, no key, no header. The customer is told the
     * service is misconfigured, which is the truth and is not a disclosure.
     */
    if (e?.httpStatus === 401 || e?.httpStatus === 403) {
      this.deps.logger.error('Upstream rejected our credentials', {
        provider: 'upstream',
        httpStatus: e.httpStatus,
      });
      this.deps.metrics?.upstreamErrors.inc({ kind: 'authentication' });
      return new HttpError({
        statusCode: 502,
        message: 'The upstream provider rejected our credentials. This is a server configuration issue.',
        type: 'upstream_error',
        code: 'upstream_authentication_failed',
      });
    }
    if (e?.httpStatus && e.httpStatus >= 500) {
      this.deps.metrics?.upstreamErrors.inc({ kind: 'unavailable' });
      return new HttpError({
        statusCode: 502,
        message: 'The upstream provider is currently unavailable',
        type: 'upstream_error',
        code: 'upstream_unavailable',
      });
    }
    this.deps.metrics?.upstreamErrors.inc({ kind: 'unknown' });
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
    const record = this.baseRecord(ctx, resolved);

    try {
      const result = await resolved.provider.chat(
        {
          model: resolved.upstreamModel,
          messages: resolved.messages,
          stream: false,
          ...(resolved.maxTokens !== undefined ? { max_tokens: resolved.maxTokens } : {}),
          ...(resolved.tools !== undefined ? { tools: resolved.tools } : {}),
          ...(resolved.toolChoice !== undefined ? { tool_choice: resolved.toolChoice } : {}),
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

      this.observeChat(resolved, 'success', result.latencyMs);
      await this.deps.requestsRepo.record(record);
      // The token increment is a single atomic Lua INCRBY, so concurrent
      // completions cannot lose an update and no read-modify-write lock is
      // needed around it.
      await this.deps.rateLimiter.recordTokens(this.limitInput(ctx), result.usage.totalTokens);
      // Settled before the lease is released so the ordering in the database
      // matches the order the customer experienced: tokens spent, then the
      // concurrency slot freed. Settling is idempotent, so a duplicate call
      // here costs nothing.
      await this.settleReservation(ctx, resolved, result.usage);
      await resolved.lease.release();

      // The upstream echoes the id it was asked for. Rewrite it to the public
      // name so a client that sent `max` sees `max` come back, and the
      // provider's internal model naming stays an implementation detail.
      return {
        body: this.maskUpstreamBranding(result.body, resolved.modelName),
        httpStatus: 200,
      };
    } catch (err) {
      const httpError = this.normalizeProviderError(err);
      record.status = signal.aborted ? 'cancelled' : 'error';
      record.httpStatus = httpError.statusCode;
      record.errorType = httpError.type;
      record.errorCode = httpError.code;
      record.latencyMs = Date.now() - startedAt;
      this.observeChat(
        resolved,
        signal.aborted ? 'cancelled' : 'error',
        record.latencyMs,
      );
      await this.recordQuietly(record, ctx, resolved);
      throw httpError;
    }
  }

  /**
   * Rewrites the upstream's own branding in a response body before the client
   * sees it.
   *
   * Two fields leak the provider, and they leak on different paths. `model` is
   * rewritten on both. `message.name` is the one found during live testing: the
   * upstream stamps its brand onto every assistant turn it produces, so a
   * request that never mentioned identity came back stamped anyway. Rewriting
   * `model` alone left the vendor plainly readable in the body.
   *
   * Only the first choice is walked, and only `name` is touched. A tool call's
   * `function.name` is the customer's own tool, not ours to rename, and
   * rewriting it would break the call.
   */
  private maskUpstreamBranding(
    body: Record<string, unknown>,
    publicName: string,
  ): Record<string, unknown> {
    // Not the display name: a caller that sent `max` must get `max` back.
    // The public name is echoed as-is because a tier discloses nothing, and is
    // replaced only on a row where it IS the internal id — the one case where
    // echoing it would republish exactly what this masking exists to hide.
    const masked: Record<string, unknown> = { ...body, model: modelResponseName(publicName) };
    const choices = body.choices;
    if (!Array.isArray(choices)) return masked;

    masked.choices = choices.map((choice) => {
      if (typeof choice !== 'object' || choice === null) return choice;
      const c = choice as Record<string, unknown>;
      const message = c.message;
      if (typeof message !== 'object' || message === null) return choice;
      const m = message as Record<string, unknown>;
      const name = assistantDisplayName(m.name as string | undefined);
      if (name === null || name === m.name) return choice;
      return { ...c, message: { ...m, name } };
    });
    return masked;
  }

  /**
   * Records one chat outcome in the metrics registry.
   *
   * Both the streaming and non-streaming paths call this, so a dashboard can
   * compare the two without reasoning about which handler ran. `model` is the
   * public tier name, never the upstream id, so an internal rename does not
   * split a customer's history across two series.
   */
  private observeChat(
    resolved: ResolvedChatRequest,
    status: 'success' | 'error' | 'cancelled',
    latencyMs: number,
  ): void {
    const metrics = this.deps.metrics;
    if (!metrics) return;
    const labels = {
      model: resolved.modelName,
      status,
      stream: String(resolved.stream),
    };
    metrics.chatRequests.inc(labels);
    metrics.chatDuration.observe(
      { model: resolved.modelName, stream: String(resolved.stream) },
      latencyMs / 1000,
    );
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
    const record = this.baseRecord(ctx, resolved);
    record.status = outcome.status;
    record.httpStatus = outcome.status === 'success' ? 200 : outcome.status === 'cancelled' ? 499 : 502;
    record.errorCode = outcome.errorCode ?? null;
    record.errorType = outcome.errorCode ? 'upstream_error' : null;
    record.latencyMs = Date.now() - startedAt;
    this.observeChat(resolved, outcome.status, record.latencyMs);

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
        await this.deps.rateLimiter.recordTokens(this.limitInput(ctx), streamUsage.totalTokens);
      }
      /**
       * Only a completed stream is charged. A stream that errored or was cut
       * short by a client disconnect releases its reservation instead, and a
       * stream whose provider never sent a usage frame releases too — the
       * customer was sent no billable output in either case.
       */
      if (outcome.status === 'success') {
        await this.settleReservation(ctx, resolved, outcome.usage);
      } else {
        await this.deps.credits?.release(
          { userId: ctx.userId, unlimited: ctx.unlimited },
          resolved.reservation,
        );
      }
    } catch (err) {
      this.deps.logger.error('Failed to record stream outcome', {
        requestId: record.requestId,
        error: err instanceof Error ? err.message : 'unknown',
      });
      // The catch above can swallow a failed settle, which would strand the
      // reservation. Releasing on the way out guarantees the tokens come back
      // even when the ledger write is what broke.
      await this.deps.credits?.release(
        { userId: ctx.userId, unlimited: ctx.unlimited },
        resolved.reservation,
      );
    } finally {
      await resolved.lease.release();
    }
  }
}
