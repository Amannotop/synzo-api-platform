import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness.js';
import { completionBody, json } from '../helpers/local-upstream.js';
import { Client, uniqueEmail, TEST_PASSWORD } from '../helpers/client.js';

/**
 * Upstream error classification.
 *
 * A misconfigured deployment has to be legible from the outside. When the
 * upstream rejected our credential, the generic "could not complete this
 * request" read like the provider was merely unavailable, which sent the
 * operator to check the network instead of their own configuration.
 *
 * The other half of the contract is that classifying it better must not turn
 * into disclosing it: the customer learns the service is misconfigured, which
 * is true, and nothing about the upstream's internals.
 */
describe('upstream error classification', () => {
  let h: Harness;
  let apiKey: string;

  beforeAll(async () => {
    h = await createHarness();
    const client = new Client(h.app);
    await client.post('/api/auth/register', {
      email: uniqueEmail('upstream'),
      name: 'Upstream Owner',
      password: TEST_PASSWORD,
    });
    const projectId = client.json<{ project: { id: string } }>(
      await client.post('/api/projects', { name: 'Default project' }),
    ).project.id;
    apiKey = client.json<{ secret: string }>(
      await client.post('/api/keys', { name: 'primary', projectId }),
    ).secret;
  });

  afterAll(async () => {
    await h.close();
  });

  const chat = () =>
    h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'max', messages: [{ role: 'user', content: 'hi' }] },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    });

  it('reports a rejected credential as an upstream authentication failure', async () => {
    h.upstream.respondWith((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid api key sk_live_TOP_SECRET' } }));
    });

    const res = await chat();
    // 5xx, because the customer cannot fix it and retrying will not help.
    expect(res.statusCode).toBe(502);
    const body = res.json<{ error: { code: string; type: string; message: string } }>();
    expect(body.error.code).toBe('upstream_authentication_failed');
    // The message must name the cause, or the operator still has to guess.
    expect(body.error.message).toMatch(/credential|configuration/i);
  });

  it('does not leak the upstream body, the key, or a stack trace', async () => {
    h.upstream.respondWith((_req, res) => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            message: 'key sk_live_TOP_SECRET rejected for org 8842',
            type: 'PermissionDenied',
            trace: 'at handler (/srv/opencode/auth.js:88:3)',
          },
        }),
      );
    });

    const res = await chat();
    const raw = res.body;
    expect(res.statusCode).toBe(502);
    // The upstream's own identifiers, its file paths and its internals must
    // all stay on the upstream's side of the boundary.
    expect(raw).not.toContain('sk_live_TOP_SECRET');
    expect(raw).not.toContain('8842');
    expect(raw).not.toContain('auth.js');
    expect(raw).not.toContain('PermissionDenied');
    expect(raw).not.toMatch(/at .*\.js:\d+/);
  });

  it('classifies a 401 whose body is not JSON as the same failure', async () => {
    h.upstream.respondWith((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'text/html' });
      res.end('<html><body>Unauthorized</body></html>');
    });

    const res = await chat();
    expect(res.statusCode).toBe(502);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('upstream_authentication_failed');
  });

  it('still maps an unknown model to a 404 rather than an auth failure', async () => {
    // OpenCode answers 401 with a ModelError body for an unsupported model.
    // Reading that as a credential rejection would turn a model typo into an
    // unactionable server error.
    h.upstream.respondWith((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'ModelError', message: 'not supported' } }));
    });

    const res = await chat();
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('invalid_model');
  });

  it('keeps a plain 5xx distinguishable from an auth failure', async () => {
    h.upstream.respondWith((_req, res) => json(res, 500, { error: { message: 'boom' } }));

    const res = await chat();
    expect(res.statusCode).toBe(502);
    // The whole point of the new branch: unavailable and unauthenticated are
    // different problems with different fixes, and must not share a code.
    expect(res.json<{ error: { code: string } }>().error.code).not.toBe(
      'upstream_authentication_failed',
    );
  });

  it('does not leak upstream text on a plain 5xx either', async () => {
    h.upstream.respondWith((_req, res) =>
      json(res, 500, { error: { message: 'db password rotation failed on shard-7' } }),
    );

    const res = await chat();
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('shard-7');
  });

  it('maps an upstream 429 to a retryable rate-limit error', async () => {
    h.upstream.respondWith((_req, res) => json(res, 429, { error: { message: 'slow down' } }));

    const res = await chat();
    expect(res.statusCode).toBe(429);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('upstream_rate_limited');
  });

  it('records the classified failure in the requests table', async () => {
    h.upstream.respondWith((_req, res) => json(res, 401, { error: { message: 'nope' } }));
    const before = await h.sql`select count(*)::int as n from requests`;
    await chat();
    const after = await h.sql`select count(*)::int as n from requests`;

    expect(after[0].n).toBe(before[0].n + 1);
    const rows = await h.sql`
      select error_code, http_status from requests order by created_at desc limit 1`;
    // The durable record has to agree with what the customer was told, or the
    // dashboard and the support conversation will disagree.
    expect(rows[0].error_code).toBe('upstream_authentication_failed');
    expect(rows[0].http_status).toBe(502);
  });

  it('serves a successful call unchanged', async () => {
    h.upstream.respondWith((_req, res) => json(res, 200, completionBody()));
    const res = await chat();
    expect(res.statusCode).toBe(200);
    expect(res.json<{ choices: unknown[] }>().choices.length).toBe(1);
  });
});
