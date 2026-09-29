import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { buildChatRequestSchema } from '@synzo/validation';
import { assistantDisplayName, modelResponseName } from '@synzo/config';
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
    maxImagesPerRequest: deps.config.limits.maxImagesPerRequest,
    maxImageBytes: deps.config.limits.maxImageBytes,
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
        ...(resolved.tools !== undefined ? { tools: resolved.tools } : {}),
        ...(resolved.toolChoice !== undefined ? { tool_choice: resolved.toolChoice } : {}),
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
      const frame = maskStreamFrameBranding(next.value, resolved.modelName);
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

/**
 * Rewrites the upstream's branding in one SSE frame.
 *
 * Two fields, and the second only turned up in live testing. `model` is the id
 * the upstream echoes, which must read as the name the caller sent. `name`
 * inside `message` and `delta` is the brand the upstream stamps onto every
 * assistant turn it emits; rewriting `model` alone still left the vendor
 * plainly readable in the body.
 *
 * Both message shapes are handled because they are not interchangeable:
 * non-streaming puts it in `message`, streaming puts it in `delta`, and an
 * agent client sees the streaming one.
 *
 * `delta.tool_calls[].function.name` is deliberately untouched. That is the
 * customer's own tool, and renaming it would break the call it is meant to
 * produce.
 *
 * A frame that is not parseable JSON is passed through unchanged. Rewriting must
 * never be the reason a stream breaks: the terminal `[DONE]` marker and any
 * unrecognized frame have to survive intact, or a client would hang waiting for
 * an end it never sees.
 */
function maskStreamFrameBranding(frame: string, publicName: string): string {
  if (!frame.startsWith('data:')) return frame;
  const payload = frame.slice('data:'.length).trim();
  if (!payload.startsWith('{') || payload === '[DONE]') return frame;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return frame;
  }
  if (typeof parsed !== 'object' || parsed === null) return frame;
  const obj = parsed as Record<string, unknown>;

  // The model id is rewritten unconditionally when present. This is decided on
  // its own and NOT gated on the name check below: a chunk carrying only a
  // content delta has no assistant name at all, and gating the id on that made
  // exactly those chunks skip the rewrite.
  // The target is the RESPONSE name, not the public name. Comparing against
  // the public name was what let the leak through: on a row whose public name
  // is itself the internal id, `obj.model !== publicName` was false, no rewrite
  // ran, and the upstream id reached the client untouched in a streamed frame.
  const target = modelResponseName(publicName);
  const modelChanged = typeof obj.model === 'string' && obj.model !== target;

  const choices = obj.choices;
  const maskedChoices = Array.isArray(choices)
    ? choices.map((choice) => {
        if (typeof choice !== 'object' || choice === null) return choice;
        const c = choice as Record<string, unknown>;
        // `delta` on a stream, `message` on a non-stream: not interchangeable.
        const key = c.delta !== undefined ? 'delta' : c.message !== undefined ? 'message' : null;
        if (key === null) return choice;
        const holder = c[key];
        if (typeof holder !== 'object' || holder === null) return choice;
        const h = holder as Record<string, unknown>;
        const name = assistantDisplayName(h.name as string | undefined);
        // A name we do not recognise is the caller's own and is left alone.
        if (name === null || name === h.name) return choice;
        return { ...c, [key]: { ...h, name } };
      })
    : choices;

  const nameChanged =
    Array.isArray(choices) &&
    Array.isArray(maskedChoices) &&
    maskedChoices.some((c, i) => c !== choices[i]);
  if (!modelChanged && !nameChanged) return frame;

  // Preserve the frame's original framing: SSE lines end with a newline, and
  // the upstream's trailing newline is part of what the client parses.
  const suffix = frame.endsWith('\n\n') ? '\n\n' : frame.endsWith('\n') ? '\n' : '';
  return `data: ${JSON.stringify({
    ...obj,
    ...(modelChanged ? { model: target } : {}),
    ...(nameChanged ? { choices: maskedChoices } : {}),
  })}${suffix}`;
}
