import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '@synzo/config';
import { buildOpenApiSpec } from '../openapi/spec.js';
import { LOCAL_ORIGIN, originContext, resolvePublicOrigin } from '../lib/public-origin.js';
import { APP_VERSION } from '../lib/version.js';

interface DocsDeps {
  config: AppConfig;
}

const require = createRequire(import.meta.url);

/**
 * Swagger UI's static assets, resolved from the installed package.
 *
 * Bundled rather than pulled from a CDN: customers reach this deployment over
 * a tunnel, and documentation that silently degrades when a third-party host
 * is unreachable is worse than documentation that always works.
 */
function swaggerRoot(): string {
  // require.resolve follows pnpm's symlink layout for us, so the asset paths
  // below are the package's real ones rather than a guess.
  return dirname(require.resolve('swagger-ui-dist/package.json'));
}

/** The files Swagger UI actually requests, and nothing else. */
const SWAGGER_ASSETS = new Set([
  'swagger-ui.css',
  'swagger-ui-bundle.js',
  'swagger-ui-standalone-preset.js',
  'favicon-32x32.png',
  'favicon-16x16.png',
]);

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
};

function contentTypeFor(file: string): string {
  const dot = file.lastIndexOf('.');
  return CONTENT_TYPES[file.slice(dot)] ?? 'application/octet-stream';
}

/**
 * The Swagger UI bootstrap, served as its own file.
 *
 * This used to be an inline <script> block. Under the production policy
 * (`script-src 'self'`, no `unsafe-inline`) a browser blocks it, so /docs
 * rendered an empty page that looked like a broken spec rather than a blocked
 * script. Keeping the policy strict and moving the bootstrap to a real
 * endpoint is the fix that does not cost anything: an external file is served
 * from this same origin, so it satisfies 'self' without weakening the one
 * directive that stops injected scripts from running.
 *
 * The spec URL is absolute-from-root rather than document-relative so the
 * bootstrap behaves identically at /docs and behind any prefix.
 */
const SWAGGER_INITIALIZER = `window.ui = SwaggerUIBundle({
  url: '/openapi.json',
  dom_id: '#swagger-ui',
  deepLinking: true,
  displayRequestDuration: true,
  tryItOutEnabled: true,
  filter: true,
  persistAuthorization: true,
  docExpansion: 'list',
  defaultModelsExpandDepth: 1,
  presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
  layout: 'StandaloneLayout'
});
`;

/**
 * The Swagger UI page, written out in full.
 *
 * swagger-ui-dist ships an index.html whose bootstrap points at a spec file
 * inside the package. Rewriting that file by string substitution looks like the
 * smaller change and is not: the substitution depends on the package's exact
 * markup, so an innocuous upstream edit to index.html silently breaks the
 * replacement and the UI falls back to rendering a frozen copy of a spec that
 * no longer matches the server. The drift this route exists to remove would
 * come back through the front door.
 *
 * Emitting the document means the only thing that decides what the UI loads is
 * the spec URL below, and that is the live one.
 */
const SWAGGER_PAGE = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Synzo API reference</title>
    <link rel="stylesheet" type="text/css" href="/docs/swagger-ui.css" />
    <link rel="icon" type="image/png" href="/docs/favicon-32x32.png" sizes="32x32" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="/docs/swagger-ui-bundle.js" charset="UTF-8"></script>
    <script src="/docs/swagger-ui-standalone-preset.js" charset="UTF-8"></script>
    <script src="/docs/swagger-initializer.js" charset="UTF-8" defer></script>
  </body>
</html>`;

/**
 * Serves the machine-readable description and a browsable rendering of it.
 *
 * The hand-written Documentation page this replaces could not be kept in step
 * with the routes: it described tiers and endpoints by hand and went stale
 * silently. Generating the spec from the same code that serves the requests
 * means the two cannot disagree.
 */
export async function registerDocsRoutes(app: FastifyInstance, deps: DocsDeps): Promise<void> {
  const { config } = deps;
  const assetRoot = swaggerRoot();

  /**
   * The server URL is derived per request, so a customer who reached the API on
   * one hostname gets "Try it out" pointed at that hostname rather than at
   * whatever this server happens to consider canonical.
   */
  const specFor = (request: FastifyRequest) =>
    buildOpenApiSpec({
      serverUrl: resolvePublicOrigin(request, originContext(config), LOCAL_ORIGIN).origin,
      version: APP_VERSION,
      sessionCookieName: config.security.sessionCookieName,
    });

  app.get('/openapi.json', async (request, reply) =>
    reply
      .header('Content-Type', 'application/json; charset=utf-8')
      // The document describes the API, so it changes whenever a route does.
      // A minute of caching lets a deploy propagate without a hard reload.
      .header('Cache-Control', 'public, max-age=60')
      .send(specFor(request)),
  );

  // The UI's own assets live under /docs/, which is also where the SPA
  // fallback lives. Restricting to a known set means an unknown path there
  // 404s as JSON rather than being answered with dashboard HTML.
  app.get('/docs/*', async (request, reply) => {
    const file = (request.params as { '*': string })['*'];

    // Not from the package: this is ours, and it has to be reachable under
    // 'self' for the page above to bootstrap at all.
    if (file === 'swagger-initializer.js') {
      return reply
        .header('Content-Type', 'application/javascript; charset=utf-8')
        .header('Cache-Control', 'no-store')
        .send(SWAGGER_INITIALIZER);
    }

    if (!SWAGGER_ASSETS.has(file)) {
      return reply.status(404).send({
        error: { message: 'Not found', type: 'not_found_error', code: 'not_found' },
      });
    }
    const body = await readFile(resolve(assetRoot, file));
    return reply
      .header('Content-Type', contentTypeFor(file))
      .header('Cache-Control', 'public, max-age=86400')
      .send(body);
  });

  app.get('/docs', async (_request, reply) =>
    reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(SWAGGER_PAGE),
  );
}
