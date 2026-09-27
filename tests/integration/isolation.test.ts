import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness } from '../helpers/harness.js';
import { Client, TEST_PASSWORD, uniqueEmail } from '../helpers/client.js';

/**
 * Tenant isolation is the platform's core security promise (§7). It is
 * enforced in the repository queries, so these tests go through the HTTP
 * surface of two real customers against the real database rather than calling
 * repositories directly — that is the only way to prove no route forgets to
 * pass the owner id through.
 */
let harness: Awaited<ReturnType<typeof createHarness>>;

beforeAll(async () => {
  harness = await createHarness();
});
afterAll(async () => {
  await harness.close();
});

async function customer(name: string) {
  const client = new Client(harness.app);
  const email = uniqueEmail(name);
  await client.post('/api/auth/register', { email, name: `Customer ${name}`, password: TEST_PASSWORD });
  const project = client.json<{ project: { id: string } }>(
    await client.post('/api/projects', { name: `${name} project` }),
  );
  return { client, email, projectId: project.project.id, userId: client.json<{ user: { id: string } }>(await client.get('/api/me')).user.id };
}

describe('project isolation', () => {
  it('does not expose another customer project', async () => {
    const a = await customer('iso-a');
    const b = await customer('iso-b');
    expect((await b.client.get(`/api/projects/${a.projectId}`)).statusCode).toBe(404);
  });

  it('does not let one customer rename or delete another project', async () => {
    const a = await customer('iso-c');
    const b = await customer('iso-d');
    expect((await b.client.patch(`/api/projects/${a.projectId}`, { name: 'stolen' })).statusCode).toBe(404);
    expect((await b.client.del(`/api/projects/${a.projectId}`)).statusCode).toBe(404);

    // The victim's project is untouched.
    const check = a.client.json<{ project: { name: string } }>(await a.client.get(`/api/projects/${a.projectId}`));
    expect(check.project.name).toBe('iso-c project');
  });

  it('lists only the calling customer projects', async () => {
    const a = await customer('iso-e');
    const b = await customer('iso-f');
    const aList = a.client.json<{ projects: { id: string }[] }>(await a.client.get('/api/projects'));
    expect(aList.projects.map((p) => p.id)).toEqual([a.projectId]);
    const list = b.client.json<{ projects: { id: string }[] }>(await b.client.get('/api/projects'));
    expect(list.projects.map((p) => p.id)).toEqual([b.projectId]);
  });
});

describe('usage isolation (spec 8, 20)', () => {
  it('does not leak another customer request log', async () => {
    const a = await customer('usage-a');
    const b = await customer('usage-b');

    const secret = a.client.json<{ secret: string }>(
      await a.client.post('/api/keys', { name: 'k', projectId: a.projectId }),
    ).secret;

    harness.upstream.respondWith((_r, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        cost: '0',
      }));
    });
    await harness.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: harness.config.defaultModel, messages: [{ role: 'user', content: 'secret data' }] },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    });

    const bLog = b.client.json<{ requests: unknown[] }>(await b.client.get('/api/requests?range=90d&limit=200'));
    expect(bLog.requests).toHaveLength(0);
  });

  it('reports only the calling customer usage totals', async () => {
    const a = await customer('totals-a');
    const b = await customer('totals-b');
    const usageB = b.client.json<{ stats: { totalRequests: number }; byModel: unknown[] }>(
      await b.client.get('/api/usage?range=90d'),
    );
    expect(usageB.stats.totalRequests).toBe(0);
    expect(usageB.byModel).toHaveLength(0);

    const usageA = a.client.json<{ stats: { totalRequests: number } }>(await a.client.get('/api/usage?range=90d'));
    expect(usageA.stats.totalRequests).toBe(0);
  });

  it('scopes a projectId filter to the calling customer', async () => {
    const a = await customer('filter-a');
    const b = await customer('filter-b');
    // Filtering by a foreign project must return an empty set, never its data.
    const res = await b.client.get(`/api/requests?range=90d&projectId=${a.projectId}`);
    expect(res.statusCode).toBe(200);
    const body = b.client.json<{ requests: unknown[]; total: number }>(res);
    expect(body.requests).toHaveLength(0);
    expect(body.total).toBe(0);
  });
});

describe('admin boundary (spec 34)', () => {
  it('refuses admin routes to a non-admin customer', async () => {
    const c = await customer('plain');
    for (const url of ['/api/admin/customers', '/api/admin/errors', '/api/admin/audit']) {
      expect((await c.client.get(url)).statusCode).toBe(403);
    }
  });

  it('returns 404 for another customer object rather than 403', async () => {
    // 403 would confirm the id exists, which is itself a leak.
    const a = await customer('probe-a');
    const b = await customer('probe-b');
    expect((await b.client.get(`/api/projects/${a.projectId}`)).statusCode).toBe(404);
  });
});
