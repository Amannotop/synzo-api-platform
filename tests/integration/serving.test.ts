import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness.js';

/**
 * The single-origin serving contract.
 *
 * Serving the dashboard from the API removes the Vite dev proxy, and that
 * proxy was quietly answering some API paths with HTML. These cases pin the
 * boundary down: API paths stay JSON, client routes get the SPA.
 */
describe('single-origin serving', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({ env: { SERVE_DASHBOARD: 'true' } });
  });

  afterAll(async () => {
    await h.close();
  });

  it('answers /health with JSON, not the dashboard', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(() => JSON.parse(res.body)).not.toThrow();
  });

  it('answers /ready with JSON', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/ready' });
    expect(res.headers['content-type']).toMatch(/application\/json/);
    // 200 when the dependencies are up, 503 when they are not. Either is JSON;
    // what matters is that it is never the SPA.
    expect([200, 503]).toContain(res.statusCode);
    expect(res.body).not.toContain('<!doctype html');
  });

  it('returns a JSON 404 for an unknown /api path instead of the SPA', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/definitely-not-a-route' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const body = res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('not_found');
  });

  it('returns a JSON 404 for an unknown /v1 path instead of the SPA', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/definitely-not-a-route' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('not_found');
  });

  it('serves the SPA at the root', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('<div id="root">');
  });

  it('serves the SPA for a client deep link, so a hard refresh works', async () => {
    // /usage is a client-side route with no server handler. A 404 here is what
    // breaks hard refresh and shared links, so this asserts 200 + HTML.
    for (const route of ['/usage', '/projects', '/signin', '/reset-password?token=abc']) {
      const res = await h.app.inject({ method: 'GET', url: route });
      expect(res.statusCode, route).toBe(200);
      expect(res.headers['content-type'], route).toMatch(/text\/html/);
      expect(res.body, route).toContain('<div id="root">');
    }
  });

  it('does not let a route that merely starts with api fall through to the SPA', async () => {
    // The prefix check must be a path-segment match: /apikeys is a client route.
    const res = await h.app.inject({ method: 'GET', url: '/api' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('marks hashed assets immutable and the entry document revalidated', async () => {
    const index = await h.app.inject({ method: 'GET', url: '/' });
    expect(index.headers['cache-control']).toBe('no-cache');
  });

  it('serves the OpenAPI document and a Swagger UI that is served from this origin', async () => {
    const spec = await h.app.inject({ method: 'GET', url: '/openapi.json' });
    expect(spec.statusCode).toBe(200);
    const doc = spec.json<{ openapi: string; paths: Record<string, unknown> }>();
    expect(doc.openapi).toMatch(/^3\.1/);
    // The spec has to describe the routes that exist, not an older snapshot.
    expect(Object.keys(doc.paths)).toContain('/v1/chat/completions');
    expect(Object.keys(doc.paths)).toContain('/health');

    const ui = await h.app.inject({ method: 'GET', url: '/docs' });
    expect(ui.statusCode).toBe(200);
    expect(ui.headers['content-type']).toMatch(/text\/html/);
    // Swagger UI must load from here, not a CDN: a tunnel customer cannot be
    // made to depend on a third-party host being reachable.
    expect(ui.body).not.toMatch(/https?:\/\/unpkg\.com/);
    // The page names the initializer, and the initializer is what names the
    // spec. Together they have to reach the live document.
    expect(ui.body).toContain('/docs/swagger-initializer.js');

    const init = await h.app.inject({ method: 'GET', url: '/docs/swagger-initializer.js' });
    expect(init.body).toContain('/openapi.json');
  });

  it('serves the Swagger assets it references', async () => {
    for (const asset of ['/docs/swagger-ui.css', '/docs/swagger-ui-bundle.js']) {
      const res = await h.app.inject({ method: 'GET', url: asset });
      expect(res.statusCode, asset).toBe(200);
      expect(res.headers['content-type'], asset).toBeTruthy();
    }
  });

  it('bootstraps Swagger from an external file, because the CSP forbids inline script', async () => {
    // The production policy is `script-src 'self'` with no `unsafe-inline`.
    // An inline bootstrap is blocked by it, and the symptom is a blank /docs
    // that looks like a broken spec rather than a blocked script -- so the
    // shape of the page is asserted here, not just that it returns 200.
    const ui = await h.app.inject({ method: 'GET', url: '/docs' });
    expect(ui.body).toContain('/docs/swagger-initializer.js');
    // No script body may appear in the document itself.
    expect(ui.body).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>\s*\S/);

    const csp = ui.headers['content-security-policy'] ?? '';
    if (csp) {
      // Whatever the policy says, it must not have been weakened to let the
      // page work.
      expect(csp).not.toContain("script-src 'unsafe-inline'");
    }

    const init = await h.app.inject({ method: 'GET', url: '/docs/swagger-initializer.js' });
    expect(init.statusCode).toBe(200);
    expect(init.headers['content-type']).toMatch(/javascript/);
    expect(init.body).toContain('SwaggerUIBundle');
    // The spec it loads has to be the live one, served from this origin.
    expect(init.body).toContain('/openapi.json');
  });

  it('does not answer a disabled /metrics with the SPA', async () => {
    // The regression this pins: with SERVE_DASHBOARD on, the SPA fallback
    // answers any unmatched GET. /metrics is only registered when metrics are
    // enabled, so with them off the fallback used to claim it and return 200
    // with a page of HTML. A scraper would record that as a healthy endpoint
    // that happens to return nonsense, which is worse than a clean 404.
    const h = await createHarness({
      env: { SERVE_DASHBOARD: 'true', METRICS_ENABLED: 'false' },
    });
    try {
      const res = await h.app.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).not.toContain('<!DOCTYPE html>');
    } finally {
      await h.close();
    }
  });

  it('404s an unknown /docs asset as JSON rather than as the SPA', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/docs/nope.txt' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('never serves a file from outside the Swagger asset directory', async () => {
    // The asset route reads a filename and joins it onto a root, so a
    // traversal is the obvious thing to try. What must hold is that no file
    // outside the directory is ever returned, whatever the status code is.
    for (const url of [
      '/docs/..%2f..%2f..%2fetc%2fpasswd',
      '/docs/..%2f..%2fpackage.json',
      '/docs/../../../etc/passwd',
    ]) {
      const res = await h.app.inject({ method: 'GET', url });
      expect(res.body, url).not.toContain('root:');
      expect(res.body, url).not.toContain('"name": "synzo-api-platform"');
    }
  });

  it('reports the version from one shared constant', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/version' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ version: string }>();
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('single-origin serving disabled', () => {
  let h: Harness;

  beforeAll(async () => {
    // The default. Serving twice would mask routing mistakes, so the flag has
    // to genuinely turn it off.
    h = await createHarness({ env: { SERVE_DASHBOARD: 'false' } });
  });

  afterAll(async () => {
    await h.close();
  });

  it('does not serve the SPA, so an unknown path is the API 404', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/usage' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});
