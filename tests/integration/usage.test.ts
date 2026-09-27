import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness } from '../helpers/harness.js';
import { Client, TEST_PASSWORD, uniqueEmail } from '../helpers/client.js';
import { RateLimitService } from '../../apps/api/src/services/rate-limit.service.js';

/**
 * Usage and quota recording across the real request path: provider response →
 * rate limiter → database → dashboard totals. The guarantee that matters most
 * is that nothing is invented — a response with no usage must record null, not
 * zero (§18, §19).
 */
let harness: Awaited<ReturnType<typeof createHarness>>;

beforeAll(async () => {
  harness = await createHarness();
});
afterAll(async () => {
  await harness.close();
});

/**
 * The stub's default answer is installed in `beforeEach`, not `afterEach`:
 * `afterEach` would leave the very first test running against whatever
 * responder the previous FILE left behind (or none at all), which reads as a
 * real failure rather than a test-isolation bug.
 */
function defaultCompletion() {
  harness.upstream.respondWith((_r, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      cost: '0',
    }));
  });
}

beforeEach(defaultCompletion);
afterEach(() => harness.upstream.requests.length = 0);

async function customer() {
  const client = new Client(harness.app);
  await client.post('/api/auth/register', { email: uniqueEmail('usage'), name: 'U', password: TEST_PASSWORD });
  const project = client.json<{ project: { id: string } }>(await client.post('/api/projects', { name: 'P' }));
  const secret = client.json<{ secret: string }>(await client.post('/api/keys', { name: 'k', projectId: project.project.id })).secret;
  const me = client.json<{ user: { id: string } }>(await client.get('/api/me')).user;
  return { client, secret, userId: me.id, projectId: project.project.id };
}

/**
 * Streams are recorded AFTER the response is fully flushed (the handler
 * hijacks the socket), so the row does not exist the instant `inject()`
 * resolves. Polling is the honest way to assert on it; sleeping a fixed
 * interval would be either flaky or needlessly slow.
 */
async function waitForRequest(userId: string, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await harness.sql`select * from requests where user_id = ${userId}`;
    if (rows.length > 0) return rows[0] as Record<string, unknown>;
    if (Date.now() > deadline) throw new Error('request row was never written');
    await new Promise((r) => setTimeout(r, 25));
  }
}

function call(secret: string, body: Record<string, unknown> = {}) {
  return harness.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    payload: { model: harness.config.defaultModel, messages: [{ role: 'user', content: 'hello' }], ...body },
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
  });
}

/**
 * Reads the single request row belonging to a customer. A customer in these
 * tests makes exactly one call per assertion, so "the row" is unambiguous —
 * unlike `order by created_at desc limit 1`, which is a coin flip when two
 * rows share a millisecond.
 */
async function lastRequest(userId: string) {
  const rows = await harness.sql`
    select status, http_status, total_tokens, upstream_cost, currency, stream
    from requests where user_id = ${userId}`;
  expect(rows.length).toBe(1);
  return rows[0] as Record<string, unknown>;
}

describe('usage recording (spec 18, 19, 20)', () => {
  it('records tokens reported by the upstream', async () => {
    const c = await customer();
    expect((await call(c.secret)).statusCode).toBe(200);

    const row = await lastRequest(c.userId);
    expect(row?.status).toBe('success');
    expect(Number(row?.total_tokens)).toBe(15);
  });

  it('stores null, not zero, when the upstream reports no usage', async () => {
    // Fabricating a zero would understate the customer's real consumption and
    // silently break quota enforcement.
    harness.upstream.respondWith((_r, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
    });
    const c = await customer();
    await call(c.secret);

    const row = await lastRequest(c.userId);
    expect(row?.total_tokens).toBeNull();
  });

  it('stores the upstream cost verbatim, with no currency invented', async () => {
    harness.upstream.respondWith((_r, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { total_tokens: 5 },
        cost: '0.00123',
      }));
    });
    const c = await customer();
    await call(c.secret);

    const row = await lastRequest(c.userId);
    expect(Number(row?.upstream_cost)).toBeCloseTo(0.00123, 6);
    expect(row?.currency).toBeNull();
  });

  it('records a failed request with its error code and no usage', async () => {
    harness.upstream.respondWith((_r, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'internal failure at /srv/app/secret.js' } }));
    });
    const c = await customer();
    const res = await call(c.secret);
    expect(res.statusCode).toBe(502);

    const row = await lastRequest(c.userId);
    expect(row?.status).toBe('error');
    expect(Number(row?.http_status)).toBe(502);
    expect(row?.total_tokens).toBeNull();
  });

  it('never leaks upstream internals in the error body', async () => {
    harness.upstream.respondWith((_r, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'db password hunter2 in /srv/app/secret.js' } }));
    });
    const c = await customer();
    const res = await call(c.secret);
    expect(res.body).not.toContain('hunter2');
    expect(res.body).not.toContain('/srv/app');
  });

  it('records a streamed request the same way', async () => {
    harness.upstream.respondWith((_r, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
      res.write('data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const c = await customer();
    const res = await call(c.secret, { stream: true });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('data: [DONE]');

    const row = await waitForRequest(c.userId);
    expect(row.stream).toBe(true);
    expect(Number(row.total_tokens)).toBe(10);
  });

  it('surfaces totals on the usage endpoint', async () => {
    const c = await customer();
    await call(c.secret);
    await call(c.secret);

    const usage = c.client.json<{ stats: { totalRequests: number; totalTokens: number } }>(
      await c.client.get('/api/usage?range=90d'),
    );
    expect(usage.stats.totalRequests).toBe(2);
    expect(usage.stats.totalTokens).toBe(30);
  });
});

describe('token quota enforcement (spec 22, 50)', () => {
  it('rejects the next request once the daily token quota is spent', async () => {
    const c = await customer();
    const keys = c.client.json<{ keys: { id: string }[] }>(await c.client.get('/api/keys'));

    // Admission reads the REAL limit from customer_limits, so the quota has to
    // be lowered there; priming the counter alone would not be enforced.
    await harness.sql`update customer_limits set tokens_per_day = 20 where user_id = ${c.userId}`;

    const rl = new RateLimitService(harness.redis, harness.logger);
    // Both scopes are checked at admission, so the counter has to be primed at
    // the customer scope with the real ids for the rejection to fire.
    await rl.recordTokens(
      {
        userId: c.userId, apiKeyId: keys.keys[0].id, requestsPerMinute: 60, requestsPerDay: 1000,
        tokensPerDay: 20, maxConcurrentRequests: 5, unlimited: false,
      },
      20,
    );

    const res = await call(c.secret);
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body).error.code).toBe('daily_token_quota_exceeded');
  });

  it('counts real consumption against the daily token quota', async () => {
    const c = await customer();
    const first = await call(c.secret);
    expect(first.statusCode).toBe(200);

    // The successful request just recorded 15 tokens at both scopes.
    const rl = new RateLimitService(harness.redis, harness.logger);
    const usage = await rl.tokenUsage(c.userId);
    expect(usage.customer).toBe(15);
  });

  it('lets an unlimited customer through regardless of tokens consumed', async () => {
    const c = await customer();
    await harness.sql`update users set unlimited_mode = true where id = ${c.userId}`;

    const keys = c.client.json<{ keys: { id: string }[] }>(await c.client.get('/api/keys'));
    const rl = new RateLimitService(harness.redis, harness.logger);
    await rl.recordTokens(
      {
        userId: c.userId, apiKeyId: keys.keys[0].id, requestsPerMinute: 60, requestsPerDay: 1000,
        tokensPerDay: 1, maxConcurrentRequests: 5, unlimited: true,
      },
      1_000_000,
    );

    expect((await call(c.secret)).statusCode).toBe(200);
  });

  it('still records token usage for an unlimited customer', async () => {
    // "Unlimited" means not enforced, not unmeasured: the dashboard has to show
    // what they actually consumed.
    const c = await customer();
    await harness.sql`update users set unlimited_mode = true where id = ${c.userId}`;
    await call(c.secret);

    const rl = new RateLimitService(harness.redis, harness.logger);
    expect((await rl.tokenUsage(c.userId)).customer).toBe(15);
  });
});

describe('concurrency limit (spec 23)', () => {
  it('rejects the second concurrent request when the limit is 1', async () => {
    const c = await customer();
    await harness.sql`update customer_limits set max_concurrent_requests = 1 where user_id = ${c.userId}`;

    let release: (() => void) | undefined;
    harness.upstream.respondWith(async (_r, res) => {
      // Hold the first request open so the second genuinely overlaps it.
      await new Promise<void>((r) => { release = r; });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { total_tokens: 1 } }));
    });

    const first = call(c.secret);
    // Give the first request time to claim its concurrency slot.
    await new Promise((r) => setTimeout(r, 150));
    const second = await call(c.secret);
    release?.();

    expect(second.statusCode).toBe(429);
    expect((await first).statusCode).toBe(200);
  });
});

describe('model allowlist (spec 50)', () => {
  it('hides a model outside the customer allowlist as 404', async () => {
    const c = await customer();
    const other = await customer();
    const otherModel = other.client.json<{ models: { publicName: string }[] }>(
      await other.client.get('/api/models'),
    ).models[0].publicName;

    await harness.sql`update customer_limits set allowed_models = ${JSON.stringify(['definitely-not-a-real-model'])} where user_id = ${c.userId}`;

    const res = await call(c.secret, { model: otherModel });
    expect(res.statusCode).toBe(404);
  });

  it('serves a model inside the allowlist', async () => {
    const c = await customer();
    const model = c.client.json<{ models: { publicName: string }[] }>(await c.client.get('/api/models'))
      .models[0].publicName;
    await harness.sql`update customer_limits set allowed_models = ${JSON.stringify([model])} where user_id = ${c.userId}`;

    expect((await call(c.secret, { model })).statusCode).toBe(200);
  });

  /**
   * null and [] are different instructions, and every surface has to agree on
   * which is which. They previously did not: an admin who ticked "only selected
   * models" and unchecked everything got an allowlist of [], which the model
   * endpoints read as "all models" while chat resolution read it as "none".
   */
  it('an empty allowlist means NO models, consistently', async () => {
    const c = await customer();
    const before = c.client.json<{ models: { publicName: string }[] }>(await c.client.get('/api/models'));
    expect(before.models.length).toBeGreaterThan(0);
    const model = before.models[0].publicName;

    await harness.sql`update customer_limits set allowed_models = ${JSON.stringify([])} where user_id = ${c.userId}`;

    // The dashboard and the OpenAI-compatible listing both show nothing.
    const dashboard = c.client.json<{ models: unknown[] }>(await c.client.get('/api/models'));
    expect(dashboard.models).toEqual([]);
    const v1 = c.client.json<{ data: unknown[] }>(
      await c.client.get('/v1/models', { authorization: `Bearer ${c.secret}` }),
    );
    expect(v1.data).toEqual([]);

    // And the request itself is refused with the same 404 as any other
    // disallowed model, so a locked-out customer cannot tell why.
    expect((await call(c.secret, { model })).statusCode).toBe(404);
  });

  it('a null allowlist means EVERY enabled model', async () => {
    const c = await customer();
    await harness.sql`update customer_limits set allowed_models = NULL where user_id = ${c.userId}`;

    const listed = c.client.json<{ models: { publicName: string }[] }>(await c.client.get('/api/models'));
    expect(listed.models.length).toBeGreaterThan(0);
    expect((await call(c.secret, { model: listed.models[0].publicName })).statusCode).toBe(200);
  });
});
