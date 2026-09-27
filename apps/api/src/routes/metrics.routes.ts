import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '@synzo/config';
import type { Metrics } from '../metrics/registry.js';
import type { ProviderHealthMonitor } from '../services/provider-health.service.js';
import { HttpError } from '../lib/errors.js';

interface MetricsDeps {
  config: AppConfig;
  metrics: Metrics;
  health: ProviderHealthMonitor;
}

/**
 * Loopback in IPv4, IPv6, and the IPv4-mapped form Node hands back.
 *
 * 127.0.0.0/8 is the whole IPv4 loopback block, and Node hands back the
 * IPv4-mapped form for IPv4 clients arriving on a dual-stack socket.
 */
const LOOPBACK = new Set(['::1', '::ffff:127.0.0.1']);

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.');
}

function unauthorized(): HttpError {
  return new HttpError({
    statusCode: 401,
    message: 'Metrics access requires a loopback address, an admin session, or a valid token',
    type: 'authentication_error',
    code: 'metrics_unauthorized',
  });
}

/**
 * The tunnel makes the port public, so "unauthenticated" cannot mean
 * "readable by anyone on the internet". Three ways in, in order:
 *
 *  1. a loopback caller — a local Prometheus, or an operator's curl, which
 *     must be both a local peer and a local Host (see isLoopback);
 *  2. a signed-in admin session — how the dashboard reads it;
 *  3. `METRICS_TOKEN` as a bearer token — for a scrape from another host.
 *
 * With no token configured, only 1 and 2 work. That is the safe default: it is
 * never accidentally public, and setting the token is the deliberate act that
 * opens it up.
 */
/**
 * True only for a genuinely local caller.
 *
 * The socket address alone is not enough, and that distinction is the whole
 * reason this function is not a one-liner.
 *
 * ngrok's edge connects to this process from 127.0.0.1, so with a tunnel open
 * *every* internet visitor reaches this app with `socket.remoteAddress` of
 * 127.0.0.1. Judging locality by the peer address alone would therefore make
 * `/metrics` world-readable the moment the tunnel is up — the exact situation
 * the endpoint is exposed over.
 *
 * The Host header is the discriminator. A local operator's curl sends
 * `localhost:3000` or `127.0.0.1:3000`; a request arriving through the tunnel
 * carries the public hostname, and `Host` is set by the client to the name it
 * dialled, so it cannot be made to look local by a remote caller. Requiring
 * both a loopback peer and a loopback Host means each half has to be true, and
 * a forwarded request fails the Host check even though it passes the peer one.
 *
 * `hostname` is the Host value with any port stripped, so `:3000` and the
 * bare form both match.
 */
function isLoopback(request: FastifyRequest): boolean {
  const peer = request.socket.remoteAddress;
  if (!isLoopbackAddress(peer)) return false;
  if (LOOPBACK.has(peer ?? '')) return true;

  // Bracketed IPv6 literal, e.g. [::1]:3000.
  const host = (request.hostname ?? '').replace(/^\[(.*)\]/, '$1');
  return isLoopbackAddress(host) || host === 'localhost';
}

/** Constant-time compare, so a token cannot be recovered by timing. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, and the length of a correct
  // token is not itself a secret.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function metricsAccessAllowed(
  request: FastifyRequest,
  config: AppConfig,
): boolean {
  if (isLoopback(request)) return true;
  if (request.sessionUser?.role === 'admin') return true;
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  return (
    config.metrics.token !== undefined &&
    bearer !== undefined &&
    tokenMatches(bearer, config.metrics.token)
  );
}

/**
 * The Prometheus scrape target.
 *
 * The dashboard-facing summary lives in admin.routes.ts, inside the admin
 * scope, so it inherits the requireAdmin gate rather than re-implementing it.
 */
export async function registerMetricsRoutes(app: FastifyInstance, deps: MetricsDeps): Promise<void> {
  const { config, metrics, health } = deps;
  if (!config.metrics.enabled) return;

  /**
   * Pushes the last observed provider health into the gauge. Without this the
   * gauge reads 0 for every provider until something fails, which looks like
   * "everything is down" rather than "nothing has been checked yet".
   */
  const refresh = (): void => metrics.setProviderHealth(health.getAll());

  app.get('/metrics', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!metricsAccessAllowed(request, config)) throw unauthorized();
    refresh();
    return reply
      .header('Content-Type', metrics.registry.contentType)
      .header('Cache-Control', 'no-store')
      .send(await metrics.registry.metrics());
  });
}
