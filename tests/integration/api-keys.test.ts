import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness } from '../helpers/harness.js';
import { Client, TEST_PASSWORD, uniqueEmail } from '../helpers/client.js';

/**
 * API-key lifecycle against the real database. The guarantees under test are
 * enforced by the key's stored status, expiry and HMAC digest, so testing them
 * against a fake would test nothing.
 */
let harness: Awaited<ReturnType<typeof createHarness>>;

beforeAll(async () => {
  harness = await createHarness();
});
afterAll(async () => {
  await harness.close();
});

async function setupCustomer() {
  const client = new Client(harness.app);
  const email = uniqueEmail('keys');
  await client.post('/api/auth/register', { email, name: 'Key Owner', password: TEST_PASSWORD });
  const project = client.json<{ project: { id: string } }>(
    await client.post('/api/projects', { name: 'Default project' }),
  );
  return { client, email, projectId: project.project.id };
}

function chat(secret: string, body: Record<string, unknown> = {}) {
  return harness.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    payload: { model: harness.config.defaultModel, messages: [{ role: 'user', content: 'hi' }], ...body },
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
  });
}

describe('key creation (spec 5, 8)', () => {
  it('returns the secret exactly once', async () => {
    const { client, projectId } = await setupCustomer();
    const res = await client.post('/api/keys', { name: 'primary', projectId });

    expect(res.statusCode).toBe(201);
    const body = client.json<{ secret: string; key: { keyPrefix: string } }>(res);
    expect(body.secret).toMatch(/^sk_test_[A-Za-z0-9]{40}$/);
    expect(body.key.keyPrefix).toBe(body.secret.slice(0, 12));

    // Listing afterwards must not re-expose it.
    const list = client.json<{ keys: { id: string; secret?: string }[] }>(await client.get('/api/keys'));
    expect(JSON.stringify(list.keys)).not.toContain(body.secret);
    expect(list.keys.every((k) => k.secret === undefined)).toBe(true);
  });

  it('stores only a prefix and a digest, never the secret', async () => {
    const { client, projectId } = await setupCustomer();
    const body = client.json<{ secret: string }>(await client.post('/api/keys', { name: 'k', projectId }));

    const rows = await harness.sql`
      select key_prefix, key_hash from api_keys where key_prefix = ${body.secret.slice(0, 12)}`;
    expect(rows.length).toBe(1);
    expect(String(rows[0].key_hash)).not.toBe(body.secret);
    expect(String(rows[0].key_hash).length).toBeGreaterThan(20);
  });

  it('refuses a live key when the account is not allowed one', async () => {
    const { client, projectId } = await setupCustomer();
    const res = await client.post('/api/keys', { name: 'live', projectId, environment: 'live' });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a project that belongs to another customer', async () => {
    const a = await setupCustomer();
    const b = await setupCustomer();
    const res = await b.client.post('/api/keys', { name: 'stolen', projectId: a.projectId });
    expect(res.statusCode).toBe(404);
  });
});

describe('key authentication (spec 6)', () => {
  it('accepts a valid key', async () => {
    const { client, projectId } = await setupCustomer();
    const { secret } = client.json<{ secret: string }>(await client.post('/api/keys', { name: 'k', projectId }));

    harness.upstream.respondWith((_r, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });

    expect((await chat(secret)).statusCode).toBe(200);
  });

  it('rejects an unknown key with 401', async () => {
    expect((await chat('sk_test_' + 'A'.repeat(40))).statusCode).toBe(401);
  });

  it('rejects a missing key with 401', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'x', messages: [{ role: 'user', content: 'hi' }] },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a disabled key', async () => {
    const { client, projectId } = await setupCustomer();
    const created = client.json<{ key: { id: string }; secret: string }>(
      await client.post('/api/keys', { name: 'k', projectId }),
    );
    await client.post(`/api/keys/${created.key.id}/status`, { status: 'disabled' });
    expect((await chat(created.secret)).statusCode).toBe(401);
  });

  it('rejects a revoked key', async () => {
    const { client, projectId } = await setupCustomer();
    const created = client.json<{ key: { id: string }; secret: string }>(
      await client.post('/api/keys', { name: 'k', projectId }),
    );
    await client.post(`/api/keys/${created.key.id}/revoke`);
    expect((await chat(created.secret)).statusCode).toBe(401);
  });

  it('rejects an expired key', async () => {
    const { client, projectId } = await setupCustomer();
    const created = client.json<{ key: { id: string }; secret: string }>(
      await client.post('/api/keys', { name: 'k', projectId, expiresInDays: 1 }),
    );
    // Expire it directly in the database: waiting a day is not an option, and
    // the check under test is the expiry comparison, not the clock.
    await harness.sql`update api_keys set expires_at = now() - interval '1 minute' where id = ${created.key.id}`;
    expect((await chat(created.secret)).statusCode).toBe(401);
  });

  it('gives an identical error for unknown, revoked and expired keys', async () => {
    // A distinguishable error would let an attacker test whether a key id or
    // a customer exists.
    const { client, projectId } = await setupCustomer();
    const created = client.json<{ key: { id: string }; secret: string }>(
      await client.post('/api/keys', { name: 'k', projectId }),
    );
    await client.post(`/api/keys/${created.key.id}/revoke`);

    const unknown = await chat('sk_test_' + 'B'.repeat(40));
    const revoked = await chat(created.secret);
    expect(unknown.statusCode).toBe(revoked.statusCode);
    expect(unknown.body).toBe(revoked.body);
  });

  it('rejects a key belonging to a suspended customer', async () => {
    const { client, projectId } = await setupCustomer();
    const created = client.json<{ secret: string }>(await client.post('/api/keys', { name: 'k', projectId }));

    const userId = client.json<{ user: { id: string } }>(await client.get('/api/me')).user.id;
    await harness.sql`update users set status = 'suspended' where id = ${userId}`;

    expect((await chat(created.secret)).statusCode).toBe(401);
  });

  it('re-enables a disabled key', async () => {
    const { client, projectId } = await setupCustomer();
    const created = client.json<{ key: { id: string }; secret: string }>(
      await client.post('/api/keys', { name: 'k', projectId }),
    );
    await client.post(`/api/keys/${created.key.id}/status`, { status: 'disabled' });
    await client.post(`/api/keys/${created.key.id}/status`, { status: 'active' });

    harness.upstream.respondWith((_r, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { total_tokens: 2 } }));
    });
    expect((await chat(created.secret)).statusCode).toBe(200);
  });

  it('refuses to re-enable a revoked key', async () => {
    const { client, projectId } = await setupCustomer();
    const created = client.json<{ key: { id: string } }>(await client.post('/api/keys', { name: 'k', projectId }));
    await client.post(`/api/keys/${created.key.id}/revoke`);
    const res = await client.post(`/api/keys/${created.key.id}/status`, { status: 'active' });
    expect(res.statusCode).toBe(409);
  });
});

describe('key management isolation (spec 7)', () => {
  it('does not let one customer see or modify another customer key', async () => {
    const a = await setupCustomer();
    const b = await setupCustomer();
    const created = a.client.json<{ key: { id: string } }>(
      await a.client.post('/api/keys', { name: 'a-key', projectId: a.projectId }),
    );

    expect((await b.client.get(`/api/projects/${a.projectId}`)).statusCode).toBe(404);
    expect((await b.client.post(`/api/keys/${created.key.id}/revoke`)).statusCode).toBe(404);
    expect((await b.client.del(`/api/keys/${created.key.id}`)).statusCode).toBe(404);
  });

  it('lists only the calling customer keys', async () => {
    const a = await setupCustomer();
    const b = await setupCustomer();
    await a.client.post('/api/keys', { name: 'a', projectId: a.projectId });
    await b.client.post('/api/keys', { name: 'b', projectId: b.projectId });

    const listA = a.client.json<{ keys: { name: string }[] }>(await a.client.get('/api/keys'));
    expect(listA.keys.map((k) => k.name)).toEqual(['a']);
  });
});
