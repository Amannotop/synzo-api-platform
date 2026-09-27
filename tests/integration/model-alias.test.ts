import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness } from '../helpers/harness.js';
import { Client, TEST_PASSWORD, uniqueEmail } from '../helpers/client.js';

/**
 * A public model name is an ALIAS for a provider model, and the two are not
 * the same string whenever the catalogue is tiered: a customer sends `max`,
 * the provider is asked for `gpt-6-astra`.
 *
 * These tests pin the three things that break when that mapping is dropped:
 * the upstream must receive the provider id, the client must get its own name
 * back, and usage must be recorded under the public name.
 */
let harness: Awaited<ReturnType<typeof createHarness>>;

/**
 * Public name -> upstream id, captured before the first test that aliases a
 * model and restored after every one of them.
 *
 * The integration suite runs against the same database the developer is using,
 * so a test that repoints a model has to put it back. Without this, running the
 * suite leaves the local deployment calling a model that does not exist
 * upstream, which looks like a product bug on the next manual request.
 */
const originalUpstream = new Map<string, string>();

beforeAll(async () => {
  harness = await createHarness();
});
afterAll(async () => {
  await harness.close();
});

function defaultCompletion() {
  harness.upstream.respondWith((_r, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        model: 'whatever-the-upstream-wants-to-call-it',
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        cost: '0',
      }),
    );
  });
}

beforeEach(async () => {
  defaultCompletion();
  if (originalUpstream.size === 0) {
    const rows = await harness.sql<{ public_name: string; upstream_model: string }[]>`
      SELECT public_name, upstream_model FROM models
    `;
    for (const r of rows) originalUpstream.set(r.public_name, r.upstream_model);
  }
});

afterEach(async () => {
  harness.upstream.requests.length = 0;
  for (const [publicName, upstreamModel] of originalUpstream) {
    await harness.sql`UPDATE models SET upstream_model = ${upstreamModel} WHERE public_name = ${publicName}`;
  }
});

async function customer() {
  const client = new Client(harness.app);
  await client.post('/api/auth/register', {
    email: uniqueEmail('alias'),
    name: 'A',
    password: TEST_PASSWORD,
  });
  const project = client.json<{ project: { id: string } }>(
    await client.post('/api/projects', { name: 'P' }),
  );
  const secret = client.json<{ secret: string }>(
    await client.post('/api/keys', { name: 'k', projectId: project.project.id }),
  ).secret;
  return { client, secret };
}

/** Repoint a public model at a distinct upstream id, and return the new id. */
async function aliasModel(publicName: string, upstreamModel: string): Promise<string> {
  await harness.sql`
    UPDATE models SET upstream_model = ${upstreamModel}
    WHERE public_name = ${publicName}
  `;
  return upstreamModel;
}

describe('public model names are aliases for upstream models', () => {
  it('sends the upstream model id, not the public name, on the non-stream path', async () => {
    const upstream = await aliasModel(harness.config.defaultModel, 'upstream-id-nonstream');
    const { client, secret } = await customer();

    const res = await client.post(
      '/v1/chat/completions',
      { model: harness.config.defaultModel, messages: [{ role: 'user', content: 'hi' }] },
      { authorization: `Bearer ${secret}` },
    );

    expect(res.statusCode).toBe(200);
    const sent = harness.upstream.requests.at(-1) as { body: { model: string } };
    expect(sent.body.model).toBe(upstream);
    expect(sent.body.model).not.toBe(harness.config.defaultModel);
  });

  it('sends the upstream model id, not the public name, on the stream path', async () => {
    const upstream = await aliasModel(harness.config.defaultModel, 'upstream-id-stream');
    harness.upstream.respondWith((_r, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    });
    const { client, secret } = await customer();

    await client.post(
      '/v1/chat/completions',
      {
        model: harness.config.defaultModel,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { authorization: `Bearer ${secret}` },
    );

    const sent = harness.upstream.requests.at(-1) as { body: { model: string } };
    expect(sent.body.model).toBe(upstream);
    expect(sent.body.model).not.toBe(harness.config.defaultModel);
  });

  it('returns the public name to the client, not the provider model id', async () => {
    await aliasModel(harness.config.defaultModel, 'provider-internal-id');
    const { client, secret } = await customer();

    const body = client.json<{ model: string }>(
      await client.post(
        '/v1/chat/completions',
        { model: harness.config.defaultModel, messages: [{ role: 'user', content: 'hi' }] },
        { authorization: `Bearer ${secret}` },
      ),
    );

    // The provider's own naming is an implementation detail and must not leak.
    expect(body.model).toBe(harness.config.defaultModel);
  });

  it('records usage under the public name so reports match what was requested', async () => {
    await aliasModel(harness.config.defaultModel, 'provider-internal-id');
    const { client, secret } = await customer();

    await client.post(
      '/v1/chat/completions',
      { model: harness.config.defaultModel, messages: [{ role: 'user', content: 'hi' }] },
      { authorization: `Bearer ${secret}` },
    );

    const rows = await harness.sql<{ model_name: string }[]>`
      SELECT model_name FROM requests
      WHERE api_key_id = (SELECT id FROM api_keys WHERE key_prefix = ${secret.slice(0, 12)})
    `;
    expect(rows.map((r) => r.model_name)).toContain(harness.config.defaultModel);
  });
});
