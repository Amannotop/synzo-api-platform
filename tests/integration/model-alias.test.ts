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

/**
 * A model is told which name to answer with, so "which model are you" returns
 * the product name rather than the upstream's own.
 *
 * The upstream request is the observable: the harness captures what was sent, so
 * these assert on the message array rather than on model output. Testing
 * generated text would be testing the model's mood, not this code — what this
 * code is responsible for is that the instruction is present, comes first, and
 * uses the public name.
 */
describe('model identity instruction', () => {
  async function upstreamMessages(): Promise<{ role: string; content: string }[]> {
    const sent = harness.upstream.requests.at(-1) as { body: { messages: { role: string; content: string }[] } };
    return sent.body.messages;
  }

  it('sends an identity instruction naming the public model, not the upstream id', async () => {
    await aliasModel(harness.config.defaultModel, 'upstream-id-for-identity');
    const { client, secret } = await customer();

    await client.post(
      '/v1/chat/completions',
      { model: harness.config.defaultModel, messages: [{ role: 'user', content: 'hi' }] },
      { authorization: `Bearer ${secret}` },
    );

    const messages = await upstreamMessages();
    const instruction = messages.find((m) => m.role === 'system');
    expect(instruction).toBeDefined();
    expect(instruction?.content).toContain('GPT-6 Astra');
    // The whole point: the upstream's own id must not appear in the prompt.
    expect(instruction?.content).not.toContain('upstream-id-for-identity');
  });

  it('puts the instruction ahead of a customer-supplied system message', async () => {
    const { client, secret } = await customer();

    await client.post(
      '/v1/chat/completions',
      {
        model: harness.config.defaultModel,
        messages: [
          { role: 'system', content: 'You are a pirate.' },
          { role: 'user', content: 'who are you' },
        ],
      },
      { authorization: `Bearer ${secret}` },
    );

    const messages = await upstreamMessages();
    // Ours is first, so a customer message cannot sit in front of it.
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('GPT-6 Astra');
    // The customer's own instruction is preserved, not overwritten.
    expect(messages.some((m) => m.content === 'You are a pirate.')).toBe(true);
  });

  it('applies on the streaming path too, not just the non-streaming one', async () => {
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
        messages: [{ role: 'user', content: 'who are you' }],
      },
      { authorization: `Bearer ${secret}` },
    );

    const messages = await upstreamMessages();
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('GPT-6 Astra');
  });

  it('lists the platform names without exposing the provider or upstream ids', async () => {
    const { client, secret } = await customer();

    await client.post(
      '/v1/chat/completions',
      { model: harness.config.defaultModel, messages: [{ role: 'user', content: 'hi' }] },
      { authorization: `Bearer ${secret}` },
    );

    const instruction = (await upstreamMessages()).find((m) => m.role === 'system')?.content ?? '';
    expect(instruction).toContain('Sinki 6.6');
    expect(instruction).toContain('Claude Opus 4.8');
    // The provider brand is fine to show; the upstream's internal id is not.
    expect(instruction).not.toMatch(/gpt-6-astra|gpt-5\.6-sol|claude-opus-4-8|space-bunny-free/);
  });
});

/**
 * `/v1/models` advertises the display name, and the tier name keeps working as
 * an alias.
 *
 * These are two halves of one guarantee. If the listing showed a friendly name
 * that requests did not accept, every caller would have to change. If requests
 * kept accepting only tiers, the friendly name in the listing would be a lie.
 * Both directions are pinned here.
 */
describe('display names are usable as model ids', () => {
  it('lists display names as the model id, not the tier', async () => {
    const { client, secret } = await customer();
    const listed = client.json<{ data: { id: string; sinki_tier: string }[] }>(
      await client.get('/v1/models', { authorization: `Bearer ${secret}` }),
    );

    expect(listed.data.length).toBeGreaterThan(0);
    for (const m of listed.data) {
      expect(m.id).not.toBe('max');
      expect(m.id).toContain(' ');
    }
    expect(listed.data.map((m) => m.id)).toContain('GPT-6 Astra');
    expect(listed.data.map((m) => m.id)).toContain('Sinki 6.6');
  });

  it('keeps the internal tier out of the advertised ids', async () => {
    const { client, secret } = await customer();
    const listed = client.json<{ data: { id: string }[] }>(
      await client.get('/v1/models', { authorization: `Bearer ${secret}` }),
    );
    const ids = listed.data.map((m) => m.id);
    for (const internal of ['space-bunny-free', 'max', 'xhigh', 'high', 'medium', 'low']) {
      expect(ids).not.toContain(internal);
    }
  });

  it('accepts a display name in a completion request', async () => {
    const { client, secret } = await customer();
    const res = await client.post(
      '/v1/chat/completions',
      { model: 'GPT-6 Astra', messages: [{ role: 'user', content: 'hi' }] },
      { authorization: `Bearer ${secret}` },
    );
    expect(res.statusCode).toBe(200);
  });

  it('still accepts the tier name, so existing integrations do not break', async () => {
    const { client, secret } = await customer();
    const res = await client.post(
      '/v1/chat/completions',
      { model: 'max', messages: [{ role: 'user', content: 'hi' }] },
      { authorization: `Bearer ${secret}` },
    );
    expect(res.statusCode).toBe(200);
  });

  it('records usage under the tier name whichever alias was used', async () => {
    const { client, secret } = await customer();
    await client.post(
      '/v1/chat/completions',
      { model: 'GPT-5.6 Terra', messages: [{ role: 'user', content: 'hi' }] },
      { authorization: `Bearer ${secret}` },
    );
    const rows = await harness.sql<{ model_name: string }[]>`
      SELECT model_name FROM requests
      WHERE api_key_id = (SELECT id FROM api_keys WHERE key_prefix = ${secret.slice(0, 12)})
    `;
    // Resolved to the public name, so the two aliases cannot split history.
    expect(rows.map((r) => r.model_name)).toContain('high');
  });

  it('resolves a display name on the single-model endpoint', async () => {
    const { client, secret } = await customer();
    const res = await client.get('/v1/models/GPT-6 Astra', { authorization: `Bearer ${secret}` });
    expect(res.statusCode).toBe(200);
    const body = client.json<{ id: string; sinki_tier: string }>(res);
    expect(body.id).toBe('GPT-6 Astra');
    expect(body.sinki_tier).toBe('max');
  });
});

/**
 * Streaming must not be the weaker path.
 *
 * The non-streaming completion rewrites the echoed `model` to the public name.
 * Streaming originally did not, so every SSE chunk carried the upstream's own
 * id — the same request disclosed different information depending on one
 * boolean. Both halves are pinned here, plus the framing that a rewrite could
 * plausibly break.
 */
describe('streaming does not leak the upstream model id', () => {
  async function streamWithUpstreamModel(id: string, publicName: string) {
    await aliasModel(publicName, id);
    harness.upstream.respondWith((_r, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        'data: {"model":"' +
          id +
          '","choices":[{"delta":{"content":"a"}}]}\n\n',
      );
      res.write('data: {"model":"' + id + '","choices":[{"delta":{"content":"b"}}]}\n\n');
      res.end('data: [DONE]\n\n');
    });
    const { client, secret } = await customer();
    const res = await client.post(
      '/v1/chat/completions',
      {
        model: publicName,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { authorization: `Bearer ${secret}` },
    );
    return String(res.body);
  }

  it('rewrites the model field in every chunk', async () => {
    const body = await streamWithUpstreamModel('upstream-secret-id', 'max');
    expect(body).not.toContain('upstream-secret-id');
    expect(body).toContain('"model":"max"');
  });

  it('preserves the [DONE] terminator so the client is not left hanging', async () => {
    const body = await streamWithUpstreamModel('upstream-secret-id-2', 'max');
    expect(body).toContain('data: [DONE]');
  });

  it('still delivers the content deltas', async () => {
    const body = await streamWithUpstreamModel('upstream-secret-id-3', 'max');
    expect(body).toContain('"content":"a"');
    expect(body).toContain('"content":"b"');
  });
});

/**
 * The internal upstream id must not reach a customer on ANY surface.
 *
 * This is a regression test for a real leak, and the shape of the bug is the
 * point. The response masker rewrites the echoed `model` to the row's public
 * name, which is correct for all five catalogue tiers — their public name is a
 * tier like `max`, which discloses nothing. But `public_name` is a database
 * column, not a guarantee, and one legacy row carries the upstream's own id
 * there. On that row the masker faithfully reproduced the very id it was
 * written to hide, because "replace the internal id with the public name" and
 * "the public name IS the internal id" are the same statement.
 *
 * Every surface is asserted rather than just the one that was noticed, because
 * the same mistake was made independently in the streaming path, the two model
 * listings, and the dashboard. Pinning only the reported one would leave the
 * others to be rediscovered by a customer.
 */
const INTERNAL = /space[-_ ]?bunny|opencode|open[-_ ]?zen/i;

describe('internal upstream ids never reach a customer', () => {
  it('does not echo the internal id in a non-streaming completion', async () => {
    const { client, secret } = await customer();
    const res = await client.post(
      '/v1/chat/completions',
      // The branded row whose public name is the internal id.
      { model: 'Sinki 6.6', messages: [{ role: 'user', content: 'hi' }] },
      { authorization: `Bearer ${secret}` },
    );
    const body = client.json<{ model: string }>(res);
    // The brand is fine. The id it is standing in for is not.
    expect(body.model).not.toMatch(INTERNAL);
    expect(body.model).toBe('Sinki 6.6');
  });

  it('does not echo the internal id in a streamed frame', async () => {
    const { client, secret } = await customer();
    // The upstream answers with its own id, which is the case the old
    // comparison treated as "already correct" and passed through.
    const res = await client.post(
      '/v1/chat/completions',
      { model: 'Sinki 6.6', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { authorization: `Bearer ${secret}` },
    );
    const text = res.body;
    expect(text).not.toMatch(INTERNAL);
  });

  it('does not leak the id through the model listings', async () => {
    const { client, secret } = await customer();
    const list = client.json<{ data: Record<string, unknown>[]; sinki_aliases: Record<string, string> }>(
      await client.get('/v1/models', { authorization: `Bearer ${secret}` }),
    );
    const serialized = JSON.stringify(list);
    expect(serialized).not.toMatch(INTERNAL);
    // `sinki_tier` exists to publish the addressable alias. For the internal
    // row there is no safe alias, so the field is omitted rather than filled
    // with a placeholder that could not be sent in a request.
    const branded = list.data.find((m) => m.id === 'Sinki 6.6');
    expect(branded).toBeDefined();
    expect(branded).not.toHaveProperty('sinki_tier');
    // The tiers that DO have a safe alias keep publishing it.
    expect(list.data.find((m) => m.id === 'GPT-6 Astra')?.sinki_tier).toBe('max');
  });

  it('does not leak the id in the single-model lookup', async () => {
    const { client, secret } = await customer();
    const res = await client.get('/v1/models/Sinki 6.6', {
      authorization: `Bearer ${secret}`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(client.json(res))).not.toMatch(INTERNAL);
  });

  it('does not leak the id in a model-not-available error', async () => {
    const { client, secret } = await customer();
    // A plan that excludes the row must not name it in the refusal.
    const res = await client.post(
      '/v1/chat/completions',
      { model: 'not-a-real-model-at-all', messages: [{ role: 'user', content: 'hi' }] },
      { authorization: `Bearer ${secret}` },
    );
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toMatch(INTERNAL);
  });
});

describe('the dashboard is not handed the internal id either', () => {
  it('gives the dashboard an addressable name that is safe to display and send', async () => {
    const { client } = await customer();
    const res = await client.get('/api/models');
    const body = client.json<{
      models: Array<{ label: string; publicName: string; addressable: string }>;
    }>(res);

    // The whole payload is scanned, not just the fields the page happens to
    // render today, so adding a field later cannot quietly reintroduce this.
    expect(JSON.stringify(body)).not.toMatch(INTERNAL);

    const branded = body.models.find((m) => m.label === 'Sinki 6.6');
    expect(branded).toBeDefined();
    // The Models page prints this next to "Send model:", so it has to be a
    // name that can actually be sent — and not the id it replaces.
    expect(branded!.addressable).toBe('Sinki 6.6');
    // The routing key is absent for a non-admin. The whole-payload scan
    // above is the real assertion; this pins the mechanism, so a future
    // change that reintroduces the field fails here with a clear reason
    // rather than only as an anonymous regex mismatch.
    expect(branded!.publicName).toBeUndefined();
  });
});
