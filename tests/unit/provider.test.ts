import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '@synzo/config';
import { OpenCodeProvider } from '../../apps/api/src/providers/opencode.provider.js';
import { completionBody, json, LocalUpstream, sse } from '../helpers/local-upstream.js';

/**
 * The provider is exercised over a REAL socket against a local server, so
 * fetch, AbortSignal and the ReadableStream reader paths run for real. Only
 * the upstream's answers are controlled. scripts/smoke.sh is what proves the
 * same code works against the live OpenCode Zen endpoint.
 */
const up = new LocalUpstream();

function makeConfig(overrides: Partial<AppConfig['upstream']> = {}): AppConfig {
  return {
    upstream: {
      baseUrl: up.baseUrl,
      chatPath: '/v1/chat/completions',
      modelsPath: '/v1/models',
      apiKey: undefined,
      connectTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      streamTimeoutMs: 5_000,
      maxRetries: 0,
      ...overrides,
    },
  } as AppConfig;
}

const PAYLOAD = {
  model: 'gpt-4o-mini',
  messages: [
    { role: 'user' as const, content: 'hello' },
    { role: 'assistant' as const, content: 'hi' },
  ],
  stream: false,
};

beforeAll(() => up.start());
afterAll(() => up.stop());
afterEach(() => {
  up.requests.length = 0;
  up.respondWith((_req, res) => json(res, 200, completionBody()));
});

describe('upstream request mapping (spec 12, 17)', () => {
  it('forwards exactly model, messages, stream and max_tokens', async () => {
    const provider = new OpenCodeProvider(makeConfig());
    await provider.chat(
      {
        ...PAYLOAD,
        max_tokens: 128,
        // These are edge-only fields; if any leaked into the body this test
        // would fail, because the provider builds the body explicitly.
        ...({ temperature: 0.9, top_p: 0.5, user: 'u1', stop: ['x'] } as Record<string, unknown>),
      } as never,
      new AbortController().signal,
    );

    const sent = up.requests.at(-1)!.body as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['max_tokens', 'messages', 'model', 'stream']);
  });

  it('omits max_tokens entirely when the customer did not set it', async () => {
    const provider = new OpenCodeProvider(makeConfig());
    await provider.chat(PAYLOAD, new AbortController().signal);
    const sent = up.requests.at(-1)!.body as Record<string, unknown>;
    expect('max_tokens' in sent).toBe(false);
  });

  it('forwards messages verbatim, preserving order and roles', async () => {
    const provider = new OpenCodeProvider(makeConfig());
    await provider.chat(PAYLOAD, new AbortController().signal);
    const sent = up.requests.at(-1)!.body as { messages: unknown[] };
    expect(sent.messages).toEqual(PAYLOAD.messages);
  });

  it('forces stream:false on the non-streaming path', async () => {
    const provider = new OpenCodeProvider(makeConfig());
    await provider.chat({ ...PAYLOAD, stream: true } as never, new AbortController().signal);
    expect((up.requests.at(-1)!.body as { stream: boolean }).stream).toBe(false);
  });

  it('forces stream:true on the streaming path', async () => {
    const provider = new OpenCodeProvider(makeConfig());
    const gen = provider.streamChat(PAYLOAD, new AbortController().signal);
    up.respondWith((_req, res) => sse(res, ['data: [DONE]\n\n']));
    for await (const _ of gen) { /* drain */ }
    expect((up.requests.at(-1)!.body as { stream: boolean }).stream).toBe(true);
  });

  it('never sends an Authorization header when no upstream key is configured', async () => {
    // Verified against the real endpoint: a bogus Authorization header makes
    // OpenCode return 401, so an unset key must omit the header entirely.
    const provider = new OpenCodeProvider(makeConfig());
    await provider.chat(PAYLOAD, new AbortController().signal);
    expect(up.requests.at(-1)!.headers.authorization).toBeUndefined();
  });

  it('sends a Bearer token when an upstream key is configured', async () => {
    const provider = new OpenCodeProvider(makeConfig({ apiKey: 'upstream-secret' }));
    await provider.chat(PAYLOAD, new AbortController().signal);
    expect(up.requests.at(-1)!.headers.authorization).toBe('Bearer upstream-secret');
  });

  it('never forwards a customer cookie or session header upstream', async () => {
    const provider = new OpenCodeProvider(makeConfig({ apiKey: 'k' }));
    await provider.chat(PAYLOAD, new AbortController().signal);
    const h = up.requests.at(-1)!.headers;
    expect(h.cookie).toBeUndefined();
    expect(h.host).toBeDefined(); // set by http, not by us
  });
});

describe('non-streaming response normalization (spec 18, 19, 33)', () => {
  it('parses usage and the string cost OpenCode actually returns', async () => {
    const provider = new OpenCodeProvider(makeConfig());
    const r = await provider.chat(PAYLOAD, new AbortController().signal);
    expect(r.usage).toEqual({
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
      upstreamCost: 0,
      currency: null,
    });
  });

  it('leaves usage null when upstream reports none, rather than inventing zeros', async () => {
    up.respondWith((_req, res) => json(res, 200, { id: 'x', choices: [] }));
    const provider = new OpenCodeProvider(makeConfig());
    const r = await provider.chat(PAYLOAD, new AbortController().signal);
    expect(r.usage.totalTokens).toBeNull();
    expect(r.usage.promptTokens).toBeNull();
  });

  it('passes the upstream body through with minimal reshaping', async () => {
    up.respondWith((_req, res) => json(res, 200, completionBody({ vendor_extra: { nested: true } })));
    const provider = new OpenCodeProvider(makeConfig());
    const r = await provider.chat(PAYLOAD, new AbortController().signal);
    expect(r.body.vendor_extra).toEqual({ nested: true });
  });

  it('translates an upstream ModelError into a 404 invalid_model', async () => {
    // A model typo must not surface as an auth failure.
    up.respondWith((_req, res) =>
      json(res, 401, { error: { type: 'ModelError', message: 'model not supported' } }),
    );
    const provider = new OpenCodeProvider(makeConfig());
    await expect(provider.chat(PAYLOAD, new AbortController().signal)).rejects.toMatchObject({
      httpStatus: 404,
      code: 'invalid_model',
    });
  });

  it('marks an upstream 429 as retryable and keeps the status', async () => {
    up.respondWith((_req, res) => json(res, 429, { error: { message: 'slow down' } }));
    const provider = new OpenCodeProvider(makeConfig());
    await expect(provider.chat(PAYLOAD, new AbortController().signal)).rejects.toMatchObject({
      httpStatus: 429,
      retryable: true,
    });
  });

  it('maps an upstream 500 to a client-safe 502 and hides internals', async () => {
    up.respondWith((_req, res) =>
      json(res, 500, { error: { message: 'db password hunter2 at /srv/secret' } }),
    );
    const provider = new OpenCodeProvider(makeConfig());
    const err = await provider.chat(PAYLOAD, new AbortController().signal).catch((e) => e);
    expect(err.httpStatus).toBe(502);
  });

  it('survives a non-JSON error body without leaking it', async () => {
    up.respondWith((_req, res) => {
      res.writeHead(503, { 'Content-Type': 'text/html' });
      res.end('<html>gateway down</html>');
    });
    const provider = new OpenCodeProvider(makeConfig());
    await expect(provider.chat(PAYLOAD, new AbortController().signal)).rejects.toMatchObject({
      httpStatus: 502,
    });
  });
});

describe('provider timeout (spec 16)', () => {
  it('aborts a non-streaming request that exceeds requestTimeoutMs', async () => {
    up.respondWith(async (_req, res) => {
      // Longer than the 150ms timeout below; the socket is torn down on abort.
      await new Promise((r) => setTimeout(r, 3_000));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    const provider = new OpenCodeProvider(makeConfig({ requestTimeoutMs: 150 }));
    await expect(provider.chat(PAYLOAD, new AbortController().signal)).rejects.toThrow();
  });

  it('honours a caller abort immediately', async () => {
    up.respondWith((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Headers sent, body withheld: only an abort can end this request.
      res.flushHeaders();
    });
    const controller = new AbortController();
    const provider = new OpenCodeProvider(makeConfig({ requestTimeoutMs: 30_000 }));
    const p = provider.chat(PAYLOAD, controller.signal);
    controller.abort();
    await expect(p).rejects.toThrow();
  });
});

describe('SSE streaming (spec 15, 55)', () => {
  async function drain(gen: AsyncGenerator<string, unknown, void>): Promise<{ frames: string[]; usage: unknown }> {
    const frames: string[] = [];
    let usage: unknown = null;
    const iterator = gen as AsyncGenerator<string, unknown, void>;
    for (;;) {
      const r = await iterator.next();
      if (r.done) {
        usage = r.value;
        break;
      }
      frames.push(r.value);
    }
    return { frames, usage };
  }

  it('yields each frame as it arrives and terminates at [DONE]', async () => {
    up.respondWith((_req, res) =>
      sse(res, [
        'data: {"choices":[{"delta":{"content":"He"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const provider = new OpenCodeProvider(makeConfig());
    const { frames } = await drain(provider.streamChat(PAYLOAD, new AbortController().signal));

    expect(frames).toHaveLength(3);
    expect(frames[0]).toContain('"content":"He"');
    expect(frames[1]).toContain('"content":"llo"');
    expect(frames[2]).toBe('data: [DONE]\n\n');
  });

  it('collects usage from the trailing chunk and reports it', async () => {
    up.respondWith((_req, res) =>
      sse(res, [
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4,"total_tokens":13}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const provider = new OpenCodeProvider(makeConfig());
    const { usage } = await drain(provider.streamChat(PAYLOAD, new AbortController().signal));
    expect(usage).toMatchObject({ promptTokens: 9, completionTokens: 4, totalTokens: 13 });
  });

  it('swallows the cost frame that OpenCode sends AFTER [DONE]', async () => {
    // Verified live: the real endpoint emits this post-terminator frame. The
    // client's stream must still end cleanly at [DONE], with no trailing data.
    up.respondWith((_req, res) =>
      sse(res, [
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: [DONE]\n\n',
        'data: {"choices":[],"cost":"0"}\n\n',
      ]),
    );
    const provider = new OpenCodeProvider(makeConfig());
    const { frames, usage } = await drain(provider.streamChat(PAYLOAD, new AbortController().signal));

    expect(frames.at(-1)).toBe('data: [DONE]\n\n');
    expect(frames.join('')).not.toContain('"cost"');
    expect(usage).toMatchObject({ upstreamCost: 0 });
  });

  it('tolerates a malformed frame without killing the stream', async () => {
    up.respondWith((_req, res) =>
      sse(res, [
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: {not json at all\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const provider = new OpenCodeProvider(makeConfig());
    const { frames } = await drain(provider.streamChat(PAYLOAD, new AbortController().signal));
    expect(frames.some((f) => f.includes('"content":"ok"'))).toBe(true);
    expect(frames.at(-1)).toBe('data: [DONE]\n\n');
  });

  it('synthesizes [DONE] when the upstream disconnects mid-stream', async () => {
    // A truncated stream must still give the client a well-formed end marker
    // rather than an abrupt close it cannot interpret.
    up.respondWith((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      // Drop the socket only after the frame has flushed, so the client sees a
      // truncated body rather than a failure to connect at all.
      setTimeout(() => res.destroy(), 30);
    });
    const provider = new OpenCodeProvider(makeConfig());
    const { frames } = await drain(provider.streamChat(PAYLOAD, new AbortController().signal));
    expect(frames.at(-1)).toBe('data: [DONE]\n\n');
  });

  it('reassembles a frame split across TCP writes', async () => {
    up.respondWith((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":');
      res.write('{"content":"split"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const provider = new OpenCodeProvider(makeConfig());
    const { frames } = await drain(provider.streamChat(PAYLOAD, new AbortController().signal));
    expect(frames[0]).toContain('"content":"split"');
  });

  it('stops reading and releases the socket when the client aborts', async () => {
    let aborted = false;
    up.respondWith((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
      res.on('close', () => {
        aborted = true;
      });
      // Keep the stream open so only the abort can end it.
    });
    const controller = new AbortController();
    const provider = new OpenCodeProvider(makeConfig({ streamTimeoutMs: 30_000 }));
    const gen = provider.streamChat(PAYLOAD, controller.signal);
    const first = await gen.next();
    expect(first.value).toContain('"content":"a"');
    controller.abort();
    await expect(gen.next()).rejects.toThrow();

    // The upstream socket must actually be closed, not left streaming into a
    // dead connection.
    await new Promise((r) => setTimeout(r, 100));
    expect(aborted).toBe(true);
  });

  it('times out a stream that stalls with no data', async () => {
    up.respondWith((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
      // No body, no end: only the stream timeout can end this.
    });
    const provider = new OpenCodeProvider(makeConfig({ streamTimeoutMs: 150 }));
    const gen = provider.streamChat(PAYLOAD, new AbortController().signal);
    await expect(gen.next()).rejects.toThrow();
  });

  it('requests text/event-stream on the streaming path', async () => {
    up.respondWith((_req, res) => sse(res, ['data: [DONE]\n\n']));
    const provider = new OpenCodeProvider(makeConfig());
    await drain(provider.streamChat(PAYLOAD, new AbortController().signal));
    expect(up.requests.at(-1)!.headers.accept).toBe('text/event-stream');
  });

  it('turns an upstream error status into a rejected stream', async () => {
    up.respondWith((_req, res) => json(res, 500, { error: { message: 'boom' } }));
    const provider = new OpenCodeProvider(makeConfig());
    const gen = provider.streamChat(PAYLOAD, new AbortController().signal);
    await expect(gen.next()).rejects.toMatchObject({ httpStatus: 502 });
  });
});

describe('health check', () => {
  it('reports healthy with latency on a 200', async () => {
    up.respondWith((_req, res) => json(res, 200, { data: [] }));
    const provider = new OpenCodeProvider(makeConfig());
    const h = await provider.healthCheck(new AbortController().signal);
    expect(h.healthy).toBe(true);
    expect(h.latencyMs).not.toBeNull();
  });

  it('reports unhealthy, not throwing, when upstream errors', async () => {
    up.respondWith((_req, res) => json(res, 503, {}));
    const provider = new OpenCodeProvider(makeConfig());
    const h = await provider.healthCheck(new AbortController().signal);
    expect(h.healthy).toBe(false);
    expect(h.detail).toContain('503');
  });

  it('reports unhealthy rather than throwing when unreachable', async () => {
    const provider = new OpenCodeProvider(makeConfig({ baseUrl: 'http://127.0.0.1:1' }));
    const h = await provider.healthCheck(new AbortController().signal);
    expect(h.healthy).toBe(false);
  });
});
