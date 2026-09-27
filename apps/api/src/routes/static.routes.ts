import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '@synzo/config';
import { assertDirectoryWithIndex, resolveFromRepo } from '../lib/paths.js';

interface StaticDeps {
  config: AppConfig;
}

/**
 * Exact paths that must keep returning JSON even when the SPA is served.
 *
 * These are routes the API owns. Most are always registered, but `/metrics`
 * is conditional on METRICS_ENABLED: with metrics off, nothing handles it, and
 * without this list the SPA fallback would answer it with index.html and a
 * 200. A monitoring system pointed at a disabled endpoint would then see a
 * healthy scrape full of HTML instead of a 404, and the disabled state would
 * be invisible from the outside.
 *
 * `/metrics` is a prefix in spirit but an exact path in practice, so it is
 * matched exactly below rather than as a prefix.
 */
const API_PATHS = new Set(['/metrics', '/openapi.json']);

/**
 * Prefixes that must keep returning JSON even when the SPA is served.
 *
 * The SPA fallback answers any unmatched GET with index.html, which is right
 * for a deep link like /usage and catastrophic for /api/usage: a dashboard
 * bug would surface as an HTML parse error in the client instead of a 404, and
 * a customer probing the API would get a 200 page of HTML. These prefixes are
 * excluded from the fallback and get a JSON 404 instead.
 */
const API_PREFIXES = ['/api', '/v1'] as const;

/**
 * Hashed asset filenames are immutable, so they can be cached hard. The entry
 * document is not: index.html must always be revalidated or a deploy would
 * leave browsers pinned to a stale bundle reference.
 */
const IMMUTABLE_ASSET_CACHE = 'public, max-age=31536000, immutable';
const HTML_CACHE = 'no-cache';

function isApiPath(url: string): boolean {
  const [path] = url.split('?');
  const pathname = path ?? '/';
  if (API_PATHS.has(pathname)) return true;
  return API_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Serves the built dashboard from the API process.
 *
 * The dashboard was reachable only because Vite's dev server proxied /api and
 * /v1 to the API. That is a development affordance, and it is why a /health
 * request through the tunnel once returned dashboard HTML: the SPA fallback
 * answered a route the API owned. Owning both from one process makes the
 * routing unambiguous, means a tunnel needs a single forward, and stops CORS
 * from being load-bearing for the dashboard at all.
 */
export async function registerStaticRoutes(app: FastifyInstance, deps: StaticDeps): Promise<void> {
  const { config } = deps;
  if (!config.serving.dashboard) return;

  const root = resolveFromRepo(config.serving.dashboardDist);
  // Thrown before the first request rather than discovered by a customer
  // staring at a blank page.
  assertDirectoryWithIndex(root, 'Dashboard build');

  await app.register(fastifyStatic, {
    root,
    // The SPA's own router owns path resolution; the server must not redirect
    // directory-ish requests, or /signin would bounce to /signin/.
    redirect: false,
    index: ['index.html'],
    wildcard: false,
  });

  /**
   * Cache headers are set in `onSend`, not in the plugin's `setHeaders`.
   *
   * `setHeaders` writes to the raw response before the plugin applies the
   * headers `send` derived, and `send` always contributes a
   * `Cache-Control: public, max-age=0`. That value is applied afterwards, so
   * anything `setHeaders` sets for that header is discarded — verified against
   * the installed v8, where every file came back `max-age=0` regardless.
   *
   * `onSend` runs after the payload is ready and immediately before it is
   * written, so the value set here is the one the client receives.
   *
   * The distinction is the whole point of the policy: a hashed filename may
   * never change for a given URL, so it can be cached for a year, while
   * index.html names the current bundle and must be revalidated or a deploy
   * leaves browsers pinned to a stale asset reference.
   */
  app.addHook('onSend', async (request, reply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return;
    const path = request.url.split('?')[0] ?? '';
    if (/\.[0-9a-f]{8,}\.(js|css|woff2?|ttf|png|jpe?g|svg|webp|ico)$/i.test(path)) {
      void reply.header('Cache-Control', IMMUTABLE_ASSET_CACHE);
    } else if (path.endsWith('.html') || path === '/' || path === '') {
      void reply.header('Cache-Control', HTML_CACHE);
    }
  });

  /**
   * Registered as a bare GET wildcard rather than as the app's not-found
   * handler, so a 404 for a real API path keeps the JSON error shape defined
   * in the error handler.
   */
  app.get('/*', async (request: FastifyRequest, reply: FastifyReply) => {
    if (isApiPath(request.url)) {
      return reply.status(404).send({
        error: {
          message: `Route ${request.method} ${request.url} not found`,
          type: 'not_found_error',
          code: 'not_found',
        },
      });
    }

    // A client route that was typed or linked directly, e.g. /usage or
    // /reset-password?token=..., is a real navigation, so the SPA boots and
    // resolves it. 200 is required for a hard refresh to work at all.
    return reply.sendFile('index.html');
  });
}
