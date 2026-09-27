import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { buildChatRequestSchema } from '@synzo/validation';
import type { AppConfig } from '@synzo/config';
import type { ChatService } from '../services/chat.service.js';
import { createApiKeyAuth, type ApiKeyContext } from '../middleware/api-key-auth.js';
import type { HttpError } from '../lib/errors.js';
import { badRequest } from '../lib/errors.js';
import type { ApiKeyRepository } from '../repositories/api-key.repository.js';
import type { UserRepository } from '../repositories/user.repository.js';
import type { ModelRepository } from '../repositories/model.repository.js';
import type { Logger } from '../lib/logger.js';
import type { NormalizedUsage } from '../providers/provider.interface.js';

interface ChatDeps {
  config: AppConfig;
  logger: Logger;
  chatService: ChatService;
  apiKeys: ApiKeyRepository;
  users: UserRepository;
  models: ModelRepository;
}

function validationError(err: z.ZodError): HttpError {
  const first = err.issues[0];
  const path = first?.path.join('.') ?? '';
  return badRequest(
    first?.message ?? 'Invalid request',
    'invalid_request',
    path || undefined,
  );
}

export async function registerChatRoutes(app: FastifyInstance, deps: ChatDeps): Promise<void> {
  const schema = buildChatRequestSchema({
    maxMessages: deps.config.limits.maxMessages,
    maxMessageChars: deps.config.limits.maxMessageChars,
    maxContentTokensHardCap: deps.config.limits.maxContentTokensHardCap,
  });
  const auth = createApiKeyAuth(deps.config, deps.apiKeys, deps.users);

  app.post(
    '/v1/chat/completions',
    { preHandler: auth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const ctx = request.apiKey as ApiKeyContext;
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) throw validationError(parsed.error);

      const startedAt = Date.now();
      const resolved = await deps.chatService.prepare(ctx, parsed.data);

      // Mark the key used without blocking the response on a write.
      void deps.apiKeys.touchLastUsed(ctx.keyId).catch(() => {});

      if (!resolved.stream) {
        const result = await deps.chatService.complete(ctx, resolved, requestAbortSignal(request, reply));
        return reply.status(200).send(result.body);
      }

      return streamResponse(request, reply, deps, ctx, resolved, startedAt);
    },
  );
}

/**
 * Bridges Fastify's connection lifecycle to an AbortSignal.
 *
 * If the client disconnects mid-stream, `reply.raw` emits 'close' and we abort,
 * which tears down the upstream fetch rather than letting it keep streaming
 * into a dead socket (§16).
 */
function requestAbortSignal(request: FastifyRequest, reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  const raw = reply.raw;
  const onClose = () => {
    if (!raw.writableEnded) controller.abort(new Error('client_disconnected'));
  };
  raw.once('close', onClose);
  request.raw.once('aborted', onClose);
  return controller.signal;
}

async function streamResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: ChatDeps,
  ctx: ApiKeyContext,
  resolved: Awaited<ReturnType<ChatService['prepare']>>,
  startedAt: number,
): Promise<FastifyReply> {
  const raw = reply.raw;

  reply.hijack();
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Tells nginx not to buffer, which would defeat streaming entirely.
    'X-Accel-Buffering': 'no',
  });
  // Flush headers immediately so the client sees the stream open.
  raw.flushHeaders?.();

  const controller = new AbortController();
  const onClientClose = () => {
    if (!raw.writableEnded) controller.abort(new Error('client_disconnected'));
  };
  raw.once('close', onClientClose);

  let usage: NormalizedUsage | null = null;
  let outcome: 'success' | 'error' | 'cancelled' = 'success';
  let errorCode: string | undefined;

  try {
    const iterator = resolved.provider.streamChat(
      {
        model: resolved.upstreamModel,
        messages: resolved.messages,
        stream: true,
        ...(resolved.maxTokens !== undefined ? { max_tokens: resolved.maxTokens } : {}),
      },
      controller.signal,
    );

    // Drive the iterator manually rather than with `for await...of`.
    // `for await` calls generator.return() on normal completion, which throws
    // away the return value — and that value is where the collected stream
    // usage lives, so accounting would silently record nothing.
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        usage = next.value ?? null;
        break;
      }
      if (controller.signal.aborted) break;
      const frame = next.value;
      const ok = raw.write(frame);
      if (!ok) {
        // Respect backpressure: wait for drain before pulling the next frame.
        await new Promise<void>((resolve) => raw.once('drain', resolve));
      }
    }
  } catch (err) {
    if (controller.signal.aborted) {
      outcome = 'cancelled';
    } else {
      outcome = 'error';
      errorCode = 'upstream_stream_failed';
    }
    deps.logger.warn('Stream failed', {
      requestId: resolved.requestId,
      error: err instanceof Error ? err.message : 'unknown',
    });
  } finally {
    raw.removeListener('close', onClientClose);
    if (!raw.writableEnded) raw.end();
    await deps.chatService.recordStreamOutcome(
      ctx,
      resolved,
      { usage, status: outcome, ...(errorCode ? { errorCode } : {}) },
      startedAt,
    );
  }

  return reply;
}
