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
    // Balances ride along only for the one error that has them. Reading them
    // off the instance rather than threading them through the constructor keeps
    // every other error's body byte-identical to what it was.
    const balances = this as HttpError & { freeRemaining?: number; paidRemaining?: number };
    // Same for an exhausted image allowance: the plan's limit and what the
    // request actually carried are the only two numbers a client can act on, and
    // without them it has to guess how many images to drop.
    const images = this as HttpError & { imageLimit?: number | null; imagesSent?: number };
    return {
      error: {
        message: this.message,
        type: this.type,
        code: this.code,
        ...(this.param ? { param: this.param } : {}),
        ...(balances.freeRemaining !== undefined
          ? {
              freeRemaining: balances.freeRemaining,
              paidRemaining: balances.paidRemaining ?? 0,
            }
          : {}),
        ...(images.imagesSent !== undefined
          ? { imageLimit: images.imageLimit ?? null, imagesSent: images.imagesSent }
          : {}),
      },
    } as ApiErrorBody;
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

/**
 * The customer has no credits left and must buy more to continue.
 *
 * A distinct `type` and `code` because this is the one API error a client is
 * expected to BRANCH on: it is the signal to show a paywall, not a transient
 * failure to retry. It is also the only error that carries spendable balances
 * in its body, so a client can render "you have N credits left" without a
 * second call — and so the numbers the client shows come from the same
 * transaction that rejected the request, rather than from a read that may
 * already be stale.
 */
export function creditExhausted(input: {
  freeRemaining: number;
  paidRemaining: number;
}): HttpError {
  const err = new HttpError({
    statusCode: 402,
    message:
      'Your credit balance is exhausted. Purchase more credits to continue making API requests.',
    type: 'quota_exceeded_error',
    code: 'credit_exhausted',
  });
  (err as HttpError & { freeRemaining?: number; paidRemaining?: number }).freeRemaining =
    input.freeRemaining;
  (err as HttpError & { freeRemaining?: number; paidRemaining?: number }).paidRemaining =
    input.paidRemaining;
  return err;
}

/**
 * The request carried an image and this customer's plan does not include it.
 *
 * 403 rather than 400: the request is well-formed and the platform is willing
 * to serve it, this particular plan is simply not entitled to. The code is
 * distinct from `invalid_model` so a client can tell "that model is not on
 * your plan" from "your plan has no image support" and upgrade accordingly.
 */
export function imageSupportRequired(): HttpError {
  return new HttpError({
    statusCode: 403,
    message:
      'Image input is not included in your plan. Upgrade to a package with image support to send images.',
    type: 'permission_error',
    code: 'image_support_required',
  });
}

/**
 * The request carried more images than this customer's plan allows.
 *
 * Distinct from `image_support_required` (no images at all) because the fix
 * differs: one needs an upgrade, the other needs a smaller request. The limit
 * is echoed so a client can split the batch without a round trip, which is the
 * only thing it can do with the number.
 *
 * `null` means the plan itself has no cap, so reaching this is always the
 * platform ceiling rather than a plan limit.
 */
export function imageLimitExceeded(input: { limit: number | null; sent: number }): HttpError {
  const err = new HttpError({
    statusCode: 403,
    message:
      input.limit === null
        ? `This request carries ${input.sent} images, over the platform maximum of one request.`
        : `This request carries ${input.sent} images but your plan allows ${input.limit}. Split the images across requests, or upgrade for more.`,
    type: 'permission_error',
    code: 'image_limit_exceeded',
  });
  (err as HttpError & { imageLimit?: number | null; imagesSent?: number }).imageLimit =
    input.limit;
  (err as HttpError & { imageLimit?: number | null; imagesSent?: number }).imagesSent =
    input.sent;
  return err;
}

/** The account is registered but an admin has not approved it yet. */export function accountPending(): HttpError {
  return new HttpError({
    statusCode: 403,
    message:
      'Your account is awaiting administrator approval. You will be able to use the API once it is approved.',
    type: 'permission_error',
    code: 'account_pending_approval',
  });
}

/** The account was reviewed and turned away. */
export function accountRejected(): HttpError {
  return new HttpError({
    statusCode: 403,
    message:
      'Your account was not approved. Contact support if you believe this is a mistake.',
    type: 'permission_error',
    code: 'account_rejected',
  });
}
