import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness } from '../helpers/harness.js';
import { Client, TEST_PASSWORD, uniqueEmail } from '../helpers/client.js';
import { json, sse } from '../helpers/local-upstream.js';

/**
 * End-to-end tool calling through the real HTTP surface.
 *
 * The bug this pins: `tools` was accepted at the edge and then dropped before
 * the upstream call. Nothing rejected it, the response was still 200, and the
 * model replied in prose that it had no tools — so an agent client looked
 * broken with no error anywhere to explain why. These tests assert the field
 * reaches the upstream intact on BOTH paths, and that the identity
 * instruction we prepend does not disturb tool calling.
 */
let harness: Awaited<ReturnType<typeof createHarness>>;

const WEATHER_TOOL = {
  type: 'function' as const,
  function: {
    name: 'get_weather',
    description: 'Look up the current weather for a city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
};

/** What a real upstream returns when it decides to call a tool. */
function toolCallCompletion() {
  return {
    id: 'chatcmpl-tools',
    object: 'chat.completion',
    model: 'space-bunny-free',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Delhi"}' } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 },
    cost: '0',
  };
}

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(() => {
  harness.upstream.respondWith((_r, res) => json(res, 200, toolCallCompletion()));
});

afterEach(() => {
  harness.upstream.requests.length = 0;
});

async function customer() {
  const client = new Client(harness.app);
  await client.post('/api/auth/register', {
    email: uniqueEmail('tools'),
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

function auth(secret: string) {
  return { authorization: `Bearer ${secret}` };
}

/** The body the upstream actually received on the most recent request. */
function lastUpstreamBody(): Record<string, unknown> {
  return harness.upstream.requests.at(-1)!.body as Record<string, unknown>;
}

describe('tool calling reaches the upstream intact', () => {
  it('forwards tools and tool_choice on the non-streaming path', async () => {
    const { client, secret } = await customer();

    const res = await client.post(
      '/v1/chat/completions',
      {
        model: harness.config.defaultModel,
        messages: [{ role: 'user', content: 'weather in Delhi?' }],
        tools: [WEATHER_TOOL],
        tool_choice: 'auto',
      },
      auth(secret),
    );

    expect(res.statusCode).toBe(200);
    const sent = lastUpstreamBody();
    expect(sent.tools).toEqual([WEATHER_TOOL]);
    expect(sent.tool_choice).toBe('auto');
  });

  it('forwards tools and tool_choice on the streaming path', async () => {
    harness.upstream.respondWith((_r, res) => {
      sse(res, [
        `data: ${JSON.stringify({
          id: 'chatcmpl-stream',
          object: 'chat.completion.chunk',
          model: 'space-bunny-free',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_abc',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '{"city":"Delhi"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: 'chatcmpl-stream',
          object: 'chat.completion.chunk',
          model: 'space-bunny-free',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 },
        })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    });

    const { client, secret } = await customer();
    const res = await client.post(
      '/v1/chat/completions',
      {
        model: harness.config.defaultModel,
        stream: true,
        messages: [{ role: 'user', content: 'weather in Delhi?' }],
        tools: [WEATHER_TOOL],
        tool_choice: 'required',
      },
      auth(secret),
    );

    expect(res.statusCode).toBe(200);
    const sent = lastUpstreamBody();
    expect(sent.tools).toEqual([WEATHER_TOOL]);
    expect(sent.tool_choice).toBe('required');
    expect(sent.stream).toBe(true);
  });

  it('sends neither key when the caller supplied neither', async () => {
    const { client, secret } = await customer();
    await client.post(
      '/v1/chat/completions',
      { model: harness.config.defaultModel, messages: [{ role: 'user', content: 'hi' }] },
      auth(secret),
    );
    const sent = lastUpstreamBody();
    expect('tools' in sent).toBe(false);
    expect('tool_choice' in sent).toBe(false);
  });

  it('forwards a named-function tool_choice without reshaping it', async () => {
    const { client, secret } = await customer();
    const choice = { type: 'function', function: { name: 'get_weather' } };
    await client.post(
      '/v1/chat/completions',
      {
        model: harness.config.defaultModel,
        messages: [{ role: 'user', content: 'weather in Delhi?' }],
        tools: [WEATHER_TOOL],
        tool_choice: choice,
      },
      auth(secret),
    );
    expect(lastUpstreamBody().tool_choice).toEqual(choice);
  });
});

describe('the tool-call response reaches the client intact', () => {
  it('returns tool_calls and finish_reason, and masks the upstream model id', async () => {
    const { client, secret } = await customer();
    const body = client.json<{
      model: string;
      choices: Array<{
        finish_reason: string;
        message: { content: string | null; tool_calls: Array<{ function: { name: string; arguments: string } }> };
      }>;
    }>(
      await client.post(
        '/v1/chat/completions',
        {
          model: harness.config.defaultModel,
          messages: [{ role: 'user', content: 'weather in Delhi?' }],
          tools: [WEATHER_TOOL],
        },
        auth(secret),
      ),
    );

    expect(body.model).toBe(harness.config.defaultModel);
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    expect(body.choices[0].message.content).toBeNull();
    expect(body.choices[0].message.tool_calls[0].function.name).toBe('get_weather');
    // The arguments stay a JSON-encoded string, as OpenAI clients expect.
    expect(body.choices[0].message.tool_calls[0].function.arguments).toBe('{"city":"Delhi"}');
  });

  it('preserves tool_calls through SSE while still masking the model id', async () => {
    // The streaming path rewrites `model` in every frame. That rewrite must
    // not disturb a tool-call delta, or an agent silently loses its tool call
    // on the one path it is most likely to use.
    harness.upstream.respondWith((_r, res) => {
      sse(res, [
        `data: ${JSON.stringify({
          id: 'chatcmpl-stream',
          model: 'space-bunny-free',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_abc',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '{"city":"Delhi"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: 'chatcmpl-stream',
          model: 'space-bunny-free',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    });

    const { client, secret } = await customer();
    const res = await client.post(
      '/v1/chat/completions',
      {
        model: harness.config.defaultModel,
        stream: true,
        messages: [{ role: 'user', content: 'weather in Delhi?' }],
        tools: [WEATHER_TOOL],
      },
      auth(secret),
    );

    const frames = res.body
      .split('\n\n')
      .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
      .map((l) => JSON.parse(l.slice('data: '.length)));

    expect(frames).toHaveLength(2);
    expect(frames[0].model).toBe(harness.config.defaultModel);
    expect(frames[0].choices[0].delta.tool_calls[0].function.name).toBe('get_weather');
    expect(frames[1].choices[0].finish_reason).toBe('tool_calls');
  });
});

describe('multi-turn tool conversations round-trip', () => {
  it('forwards an assistant tool-call turn and a tool-result turn unchanged', async () => {
    const { client, secret } = await customer();
    const res = await client.post(
      '/v1/chat/completions',
      {
        model: harness.config.defaultModel,
        messages: [
          { role: 'user', content: 'weather in Delhi?' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Delhi"}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_abc', content: '22C and clear' },
        ],
        tools: [WEATHER_TOOL],
      },
      auth(secret),
    );

    expect(res.statusCode).toBe(200);
    const sent = lastUpstreamBody().messages as Array<Record<string, unknown>>;
    // messages[0] is our identity instruction, so the customer's turns shift by one.
    expect(sent[0].role).toBe('system');
    expect(sent[2].content).toBeNull();
    expect(sent[2].tool_calls).toEqual([
      { id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Delhi"}' } },
    ]);
    expect(sent[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_abc', content: '22C and clear' });
  });

  it('still records usage for a turn that only calls a tool', async () => {
    const { client, secret } = await customer();
    await client.post(
      '/v1/chat/completions',
      {
        model: harness.config.defaultModel,
        messages: [{ role: 'user', content: 'weather in Delhi?' }],
        tools: [WEATHER_TOOL],
      },
      auth(secret),
    );

    const listed = client.json<{ requests: Array<{ totalTokens: number | null; model: string }> }>(
      await client.get('/api/requests?range=30d&limit=10', auth(secret)),
    );
    expect(listed.requests.some((r) => r.totalTokens === 42 && r.model === harness.config.defaultModel)).toBe(true);
  });
});

/**
 * Found in live testing, not in review: the upstream stamps its own brand into
 * `message.name` on every assistant turn, so a request that never mentioned
 * identity still came back stamped. The `model` field was already masked, which
 * is exactly what made this easy to miss — the body looked scrubbed.
 */
describe('upstream branding is masked on both paths', () => {
  it('rewrites an assistant name to the platform brand, non-streaming', async () => {
    harness.upstream.respondWith((_r, res) =>
      json(res, 200, {
        model: 'space-bunny-free',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'hi', name: 'Space Bunny' }, finish_reason: 'stop' },
        ],
      }),
    );

    const { client, secret } = await customer();
    const body = client.json<{
      model: string;
      choices: Array<{ message: { name?: string } }>;
    }>(
      await client.post(
        '/v1/chat/completions',
        { model: harness.config.defaultModel, messages: [{ role: 'user', content: 'hi' }] },
        auth(secret),
      ),
    );

    expect(body.model).toBe(harness.config.defaultModel);
    expect(body.choices[0].message.name).toBe('Sinki');
  });

  it('rewrites a delta name while streaming', async () => {
    harness.upstream.respondWith((_r, res) => {
      sse(res, [
        `data: ${JSON.stringify({
          model: 'space-bunny-free',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'hi', name: 'Space Bunny' } }],
        })}\n\n`,
        `data: ${JSON.stringify({
          model: 'space-bunny-free',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    });

    const { client, secret } = await customer();
    const res = await client.post(
      '/v1/chat/completions',
      {
        model: harness.config.defaultModel,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      },
      auth(secret),
    );

    const frames = res.body
      .split('\n\n')
      .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
      .map((l) => JSON.parse(l.slice('data: '.length)));

    expect(frames[0].choices[0].delta.name).toBe('Sinki');
    expect(frames[0].model).toBe(harness.config.defaultModel);
  });

  it('leaves a tool function name alone, since that call has to still work', async () => {
    // The customer's own tool must survive verbatim. Renaming it would make
    // the tool call unusable, which is worse than the leak being fixed.
    const { client, secret } = await customer();
    const body = client.json<{
      choices: Array<{ message: { tool_calls: Array<{ function: { name: string } }> } }>;
    }>(
      await client.post(
        '/v1/chat/completions',
        {
          model: harness.config.defaultModel,
          messages: [{ role: 'user', content: 'weather in Delhi?' }],
          tools: [WEATHER_TOOL],
        },
        auth(secret),
      ),
    );
    expect(body.choices[0].message.tool_calls[0].function.name).toBe('get_weather');
  });

  it('leaves an unrecognised assistant name untouched', async () => {
    harness.upstream.respondWith((_r, res) =>
      json(res, 200, {
        model: 'space-bunny-free',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi', name: 'acme-bot' } }],
      }),
    );

    const { client, secret } = await customer();
    const body = client.json<{ choices: Array<{ message: { name?: string } }> }>(
      await client.post(
        '/v1/chat/completions',
        { model: harness.config.defaultModel, messages: [{ role: 'user', content: 'hi' }] },
        auth(secret),
      ),
    );
    expect(body.choices[0].message.name).toBe('acme-bot');

  });
});

/**
 * A fixed 128-tool cap was rejected by real agent clients: 140 ordinary tool
 * definitions is only ~30KB, against a 1MB body limit. The count cap is gone,
 * and these pin the bound that replaced it so a tighter one cannot creep back.
 */
describe('toolset size is bounded by the body limit, not a count', () => {
  function manyTools(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      type: 'function' as const,
      function: {
        name: `tool_${i}`,
        description: `Tool ${i} that does a plausible thing`,
        parameters: { type: 'object', properties: { a: { type: 'string' } } },
      },
    }));
  }

  it('accepts and forwards a 300-tool request', async () => {
    const { client, secret } = await customer();
    const res = await client.post(
      '/v1/chat/completions',
      {
        model: harness.config.defaultModel,
        messages: [{ role: 'user', content: 'what can you do?' }],
        tools: manyTools(300),
      },
      auth(secret),
    );

    expect(res.statusCode).toBe(200);
    const sent = lastUpstreamBody().tools as unknown[];
    expect(sent).toHaveLength(300);
  });

  it('still refuses a request that exceeds the body limit', async () => {
    // The replacement bound has to actually bite. Without this, removing the
    // count cap would just be removing a limit.
    const { client, secret } = await customer();
    await client
      .post(
        '/v1/chat/completions',
        {
          model: harness.config.defaultModel,
          messages: [{ role: 'user', content: 'hi' }],
          // Each description is padded so the body blows past 1MB.
          tools: manyTools(4000).map((t) => ({
            ...t,
            function: { ...t.function, description: 'x'.repeat(400) },
          })),
        },
        auth(secret),
      )
      .then((res: { statusCode: number }) => {
        expect(res.statusCode).toBe(413);
      });
  });
});

/**
 * The shape an IDE agent actually sends: a large toolset where descriptions run
 * to thousands of characters. An invented 4,000-character description cap
 * rejected these with a message naming `tools.0.function.description`, a field
 * the caller never thought to set, so the whole session died on the first
 * message instead of the model ever being reached.
 */
describe('a realistic agent toolset is accepted', () => {
  it('accepts many tools with long descriptions and calls one', async () => {
    const tools = Array.from({ length: 40 }, (_, i) => ({
      type: 'function' as const,
      function: {
        name: `shell_tool_${i}`,
        // Deliberately well past the old 4,000-character cap.
        description:
          `Executes a command and returns its output. ${'Use this for filesystem and process work. '.repeat(120)}`,
        parameters: {
          type: 'object',
          properties: { cmd: { type: 'string' } },
          required: ['cmd'],
        },
      },
    }));

    const { client, secret } = await customer();
    const res = await client.post(
      '/v1/chat/completions',
      {
        model: harness.config.defaultModel,
        messages: [{ role: 'user', content: 'run ls' }],
        tools,
        tool_choice: 'auto',
      },
      auth(secret),
    );

    expect(res.statusCode).toBe(200);
    const sent = lastUpstreamBody().tools as Array<{ function: { description: string } }>;
    expect(sent).toHaveLength(40);
    // The description reaches the model intact, not silently truncated.
    expect(sent[0].function.description.length).toBeGreaterThan(4_000);
  });
});

describe('malformed tool definitions are rejected at the edge', () => {
  it('rejects a tool that is not a function', async () => {
    const { client, secret } = await customer();
    const res = await client.post(
      '/v1/chat/completions',
      {
        model: harness.config.defaultModel,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'retrieval' }],
      },
      auth(secret),
    );
    expect(res.statusCode).toBe(400);
    // Nothing should have reached the upstream for a request we refused.
    expect(harness.upstream.requests).toHaveLength(0);
  });

  it('rejects an unknown tool_choice', async () => {
    const { client, secret } = await customer();
    const res = await client.post(
      '/v1/chat/completions',
      {
        model: harness.config.defaultModel,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [WEATHER_TOOL],
        tool_choice: 'sometimes',
      },
      auth(secret),
    );
    expect(res.statusCode).toBe(400);
  });
});
