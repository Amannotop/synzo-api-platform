import type { ApiErrorBody, ApiErrorType } from '@synzo/types';

/**
 * Every error surfaced to a customer is constructed here so the wire format is
 * always identical and never leaks internals (§33): no stack traces, no file
 * paths, no env values, no provider credentials, no SQL.
 */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly type: ApiErrorType;
  readonly code: string;
  readonly param: string | null;
  /** Server-side only. Logged, never returned to the client. */
  readonly internal?: unknown;

  constructor(opts: {
    statusCode: number;
    message: string;
    type: ApiErrorType;
    code: string;
    param?: string | null;
    internal?: unknown;
  }) {
    super(opts.message);
    this.name = 'HttpError';
    this.statusCode = opts.statusCode;
    this.type = opts.type;
    this.code = opts.code;
    this.param = opts.param ?? null;
    this.internal = opts.internal;
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        message: this.message,
        type: this.type,
        code: this.code,
        ...(this.param ? { param: this.param } : {}),
      },
    };
  }
}

/* ----------------------------------------------------- auth (indistinguishable) */

/**
 * Every API-key failure returns this identical error. The caller must not be
 * able to distinguish "key unknown" from "key revoked" / "expired" / "owner
 * suspended" (§6).
 */
export function invalidApiKey(): HttpError {
  return new HttpError({
    statusCode: 401,
    message: 'Invalid API key',
    type: 'authentication_error',
    code: 'invalid_api_key',
  });
}

/* ------------------------------------------------------------ request errors */

export function badRequest(message: string, code = 'invalid_request', param?: string): HttpError {
  return new HttpError({
    statusCode: 400,
    message,
    type: 'invalid_request_error',
    code,
    param,
  });
}

export function notFound(message = 'Not found', code = 'not_found'): HttpError {
  return new HttpError({ statusCode: 404, message, type: 'not_found_error', code });
}

/**
 * Cross-tenant access is reported as 404, not 403, so a customer cannot probe
 * for the existence of another customer's ids (§7).
 */
export function notFoundOrForbidden(): HttpError {
  return notFound('Not found', 'not_found');
}

export function rateLimited(message = 'Rate limit exceeded', retryAfterSec?: number): HttpError {
  const err = new HttpError({
    statusCode: 429,
    message,
    type: 'rate_limit_error',
    code: 'rate_limit_exceeded',
  });
  if (retryAfterSec !== undefined) {
    (err as HttpError & { retryAfter?: number }).retryAfter = retryAfterSec;
  }
  return err;
}

export function quotaExceeded(message: string, code = 'quota_exceeded'): HttpError {
  return new HttpError({
    statusCode: 429,
    message,
    type: 'quota_exceeded_error',
    code,
  });
}

export function payloadTooLarge(message = 'Request body is too large'): HttpError {
  return new HttpError({
    statusCode: 413,
    message,
    type: 'invalid_request_error',
    code: 'payload_too_large',
  });
}

export function conflict(message: string, code = 'conflict'): HttpError {
  return new HttpError({
    statusCode: 409,
    message,
    type: 'invalid_request_error',
    code,
  });
}

/* ------------------------------------------------------------------ upstream */

export function upstreamError(
  message = 'The upstream provider could not complete this request',
  code = 'upstream_error',
): HttpError {
  return new HttpError({
    statusCode: 502,
    message,
    type: 'upstream_error',
    code,
  });
}

export function upstreamTimeout(message = 'The upstream provider timed out'): HttpError {
  return new HttpError({
    statusCode: 504,
    message,
    type: 'timeout_error',
    code: 'upstream_timeout',
  });
}

export function serviceUnavailable(message = 'Service temporarily unavailable'): HttpError {
  return new HttpError({
    statusCode: 503,
    message,
    type: 'api_error',
    code: 'service_unavailable',
  });
}

export function internalError(internal?: unknown): HttpError {
  return new HttpError({
    statusCode: 500,
    message: 'An internal error occurred',
    type: 'api_error',
    code: 'internal_error',
    internal,
  });
}
