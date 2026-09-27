import type { FastifyInstance } from 'fastify';
import { HttpError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';

/**
 * Single exit point for errors.
 *
 * Known `HttpError`s are returned as-is (they are already client-safe).
 * Anything else becomes a generic 500 — an unexpected exception must never
 * leak a stack trace, SQL fragment, file path or env value to a customer (§33).
 */
export function registerErrorHandler(app: FastifyInstance, logger: Logger): void {
  app.setErrorHandler((rawError, request, reply) => {
    const error = rawError as Error & { code?: string; statusCode?: number };
    const requestId = (request.id as string) ?? 'unknown';

    if (error instanceof HttpError) {
      const retryAfter = (error as HttpError & { retryAfter?: number }).retryAfter;
      if (retryAfter !== undefined) reply.header('Retry-After', String(retryAfter));
      if (error.internal !== undefined) {
        logger.error('Request failed', {
          requestId,
          code: error.code,
          error: error.internal instanceof Error ? error.internal.message : String(error.internal),
        });
      }
      return reply.status(error.statusCode).send(error.toBody());
    }

    // Fastify's own errors: body too large, malformed JSON, etc.
    const code = (error as { code?: string }).code;
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE' || (error as { statusCode?: number }).statusCode === 413) {
      return reply.status(413).send({
        error: { message: 'Request body is too large', type: 'invalid_request_error', code: 'payload_too_large' },
      });
    }
    // FST_ERR_CTP_INVALID_JSON_BODY is what Fastify 5 raises for a truncated or
    // otherwise malformed body; EMPTY_JSON_BODY covers a completely empty one.
    if (
      code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ||
      code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
      error instanceof SyntaxError
    ) {
      return reply.status(400).send({
        error: { message: 'Request body is not valid JSON', type: 'invalid_request_error', code: 'invalid_json' },
      });
    }
    if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply.status(415).send({
        error: { message: 'Content-Type must be application/json', type: 'invalid_request_error', code: 'invalid_content_type' },
      });
    }
    if ((error as { statusCode?: number }).statusCode === 429) {
      return reply.status(429).send({
        error: { message: 'Rate limit exceeded', type: 'rate_limit_error', code: 'rate_limit_exceeded' },
      });
    }

    logger.error('Unhandled error', {
      requestId,
      path: request.url,
      method: request.method,
      error: error.message,
      stack: error.stack,
    });
    return reply.status(500).send({
      error: { message: 'An internal error occurred', type: 'api_error', code: 'internal_error' },
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: { message: `Route ${request.method} ${request.url} not found`, type: 'not_found_error', code: 'not_found' },
    }),
  );
}
