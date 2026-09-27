import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness.js';
import { completionBody, json } from '../helpers/local-upstream.js';
import { Client, uniqueEmail, TEST_PASSWORD } from '../helpers/client.js';

/**
 * Provisions a customer and returns a usable API key.
 *
 * Mirrors the setup the other integration suites use, so a change to the
 * registration or key-creation contract surfaces here as a shape mismatch
 * rather than as a confusing metrics failure.
 */
async function customerWithKey(h: Harness): Promise<string> {
  const client = new Client(h.app);
  await client.post('/api/auth/register', {
    email: uniqueEmail('metrics'),
    name: 'Metrics Owner',
    password: TEST_PASSWORD,
  });
  const projectId = client.json<{ project: { id: string } }>(
    await client.post('/api/projects', { name: 'Default project' }),
  ).project.id;
  return client.json<{ secret: string }>(
    await client.post('/api/keys', { name: 'primary', projectId }),
  ).secret;
}

/**
 * Metrics have to be scrapeable by a standard Prometheus client, which means
 * the response is text in the exposition format rather than JSON. These cases
 * check the format, and the access control that makes exposing it safe.
 */
describe('metrics', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({ env: { METRICS_ENABLED: 'true' } });
  });

  afterAll(async () => {
    await h.close();
  });

  it('serves Prometheus text, not JSON', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.body).toContain('# HELP');
    expect(res.body).toContain('# TYPE');
  });

  it('exposes the documented metric families', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/metrics' });
    // A family with no observations still renders its HELP/TYPE header, so
    // these are present from the first scrape. A dashboard that breaks on the
    // first poll of the day is worse than one that shows zero.
    for (const name of [
      'synzo_http_requests_total',
      'synzo_http_request_duration_seconds',
      'synzo_chat_requests_total',
      'synzo_chat_request_duration_seconds',
      'synzo_upstream_errors_total',
      'synzo_rate_limit_rejections_total',
      'synzo_provider_healthy',
    ]) {
      expect(res.body, name).toContain(`# TYPE ${name}`);
    }
  });

  it('records a completed request and a chat call', async () => {
    h.upstream.respondWith((_req, res) => json(res, 200, completionBody()));
    const apiKey = await customerWithKey(h);

    const completion = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { model: 'max', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(completion.statusCode).toBe(200);

    const res = await h.app.inject({ method: 'GET', url: '/metrics' });

    // The chat call is counted under the tier the customer asked for.
    expect(res.body).toMatch(/synzo_chat_requests_total\{[^}]*model="max"/);
    // A histogram observation implies both a count and at least one bucket.
    expect(res.body).toMatch(/synzo_chat_request_duration_seconds_count\{[^}]*\}\s+\d/);
    // And the HTTP request itself is counted with a 200 status.
    expect(res.body).toMatch(/synzo_http_requests_total\{[^}]*status="200"/);
  });

  it('counts an upstream failure by kind', async () => {
    h.upstream.respondWith((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'boom' } }));
    });

    const apiKey = await customerWithKey(h);

    await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { model: 'max', messages: [{ role: 'user', content: 'hi' }] },
    });

    const res = await h.app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toMatch(/synzo_upstream_errors_total\{kind="[^"]+"\}\s+[1-9]/);
  });
});

describe('metrics access control', () => {
  it('refuses a non-loopback caller with no token, even from a loopback peer', async () => {
    // The case that matters: ngrok's edge connects from 127.0.0.1, so the peer
    // address alone would let every internet visitor through. The Host header
    // is the discriminator, and a public hostname must fail the check.
    const h = await createHarness({ env: { METRICS_TOKEN: 'scrape-me' } });
    try {
      const tunnel = await h.app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { host: 'retract-constant-compacted.ngrok-free.dev' },
      });
      expect(tunnel.statusCode).toBe(401);
      expect(tunnel.json<{ error: { code: string } }>().error.code).toBe('metrics_unauthorized');
    } finally {
      await h.close();
    }
  });

  it('refuses a tunnel request carrying no token', async () => {
    const h = await createHarness({ env: { METRICS_ENABLED: 'true' } });
    try {
      const res = await h.app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { host: 'retract-constant-compacted.ngrok-free.dev' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await h.close();
    }
  });

  it('admits a tunnel request presenting the configured token', async () => {
    const h = await createHarness({ env: { METRICS_TOKEN: 'scrape-me' } });
    try {
      const res = await h.app.inject({
        method: 'GET',
        url: '/metrics',
        headers: {
          host: 'retract-constant-compacted.ngrok-free.dev',
          authorization: 'Bearer scrape-me',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('# TYPE');
    } finally {
      await h.close();
    }
  });

  it('rejects a wrong token of the same length', async () => {
    const h = await createHarness({ env: { METRICS_TOKEN: 'scrape-me' } });
    try {
      const res = await h.app.inject({
        method: 'GET',
        url: '/metrics',
        headers: {
          host: 'retract-constant-compacted.ngrok-free.dev',
          authorization: 'Bearer scrape-nx',
        },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await h.close();
    }
  });

  it('admits a genuine local operator with no token configured', async () => {
    const h = await createHarness({ env: { METRICS_TOKEN: '' } });
    try {
      const res = await h.app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { host: 'localhost:3000' },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await h.close();
    }
  });

  it('does not register the endpoint at all when metrics are disabled', async () => {
    const h = await createHarness({ env: { METRICS_ENABLED: 'false' } });
    try {
      const res = await h.app.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(404);
    } finally {
      await h.close();
    }
  });
});
