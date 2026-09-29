import { describe, expect, it } from 'vitest';
import {
  adminUpdateLimitsSchema,
  createApiKeySchema,
  createProjectSchema,
  loginSchema,
  registerSchema,
  updateKeyStatusSchema,
  updateProjectSchema,
  buildChatRequestSchema,
} from '@synzo/validation';

const LIMITS = {
  maxMessages: 200,
  maxMessageChars: 100_000,
  maxContentTokensHardCap: 200_000,
  maxImagesPerRequest: 8,
  maxImageBytes: 5_000_000,
};
const chatSchema = buildChatRequestSchema(LIMITS);

describe('registerSchema', () => {
  it('accepts a well-formed registration', () => {
    const r = registerSchema.parse({ email: 'a@b.com', name: 'Ada', password: 'correct-horse-battery' });
    expect(r.email).toBe('a@b.com');
  });

  it('normalizes email casing and surrounding whitespace', () => {
    // Duplicate registration is a 409, so the unique index must see one value.
    expect(registerSchema.parse({ email: '  Ada@Example.COM ', name: 'A', password: 'longenough1' }).email)
      .toBe('ada@example.com');
  });

  it('rejects a short password', () => {
    expect(registerSchema.safeParse({ email: 'a@b.com', name: 'A', password: 'short' }).success).toBe(false);
  });

  it('rejects a malformed email', () => {
    expect(registerSchema.safeParse({ email: 'not-an-email', name: 'A', password: 'longenough1' }).success).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(registerSchema.safeParse({ email: 'a@b.com', name: '', password: 'longenough1' }).success).toBe(false);
  });
});

describe('loginSchema', () => {
  it('allows a short password (only registration sets the floor)', () => {
    expect(loginSchema.safeParse({ email: 'a@b.com', password: 'x' }).success).toBe(true);
  });

  it('still requires a non-empty password', () => {
    expect(loginSchema.safeParse({ email: 'a@b.com', password: '' }).success).toBe(false);
  });
});

describe('createApiKeySchema', () => {
  const base = { name: 'prod', projectId: '11111111-1111-4111-8111-111111111111' };

  it('defaults the environment to test', () => {
    // Live keys are a deliberate opt-in, so the safe value is the default.
    expect(createApiKeySchema.parse(base).environment).toBe('test');
  });

  it('accepts a live key explicitly', () => {
    expect(createApiKeySchema.parse({ ...base, environment: 'live' }).environment).toBe('live');
  });

  it('rejects an unknown environment', () => {
    expect(createApiKeySchema.safeParse({ ...base, environment: 'prod' }).success).toBe(false);
  });

  it('rejects a non-uuid projectId', () => {
    expect(createApiKeySchema.safeParse({ ...base, projectId: 'nope' }).success).toBe(false);
  });

  it('is strict, so an unexpected field cannot ride along', () => {
    expect(createApiKeySchema.safeParse({ ...base, role: 'admin' }).success).toBe(false);
  });

  it('coerces expiresInDays and bounds it', () => {
    expect(createApiKeySchema.parse({ ...base, expiresInDays: '30' }).expiresInDays).toBe(30);
    expect(createApiKeySchema.safeParse({ ...base, expiresInDays: 0 }).success).toBe(false);
    expect(createApiKeySchema.safeParse({ ...base, expiresInDays: 4000 }).success).toBe(false);
  });
});

describe('createProjectSchema / updateProjectSchema', () => {
  it('accepts a minimal project', () => {
    expect(createProjectSchema.parse({ name: 'App' }).name).toBe('App');
  });

  it('rejects an empty project name', () => {
    expect(createProjectSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('requires at least one field on update', () => {
    expect(updateProjectSchema.safeParse({}).success).toBe(false);
  });

  it('accepts clearing a description with null', () => {
    expect(updateProjectSchema.parse({ description: null }).description).toBeNull();
  });
});

describe('updateKeyStatusSchema', () => {
  it('accepts only active and disabled', () => {
    expect(updateKeyStatusSchema.parse({ status: 'active' }).status).toBe('active');
    expect(updateKeyStatusSchema.safeParse({ status: 'revoked' }).success).toBe(false);
  });
});

describe('adminUpdateLimitsSchema (spec 50)', () => {
  it('rejects an empty patch', () => {
    expect(adminUpdateLimitsSchema.safeParse({}).success).toBe(false);
  });

  it('accepts a single limit change', () => {
    expect(adminUpdateLimitsSchema.parse({ requestsPerMinute: 120 }).requestsPerMinute).toBe(120);
  });

  it('accepts an allowedModels array', () => {
    expect(adminUpdateLimitsSchema.parse({ allowedModels: ['gpt-4o', 'claude-3'] }).allowedModels)
      .toEqual(['gpt-4o', 'claude-3']);
  });

  it('accepts null allowedModels meaning "every model"', () => {
    expect(adminUpdateLimitsSchema.parse({ allowedModels: null }).allowedModels).toBeNull();
  });

  it('rejects an empty-string model name inside allowedModels', () => {
    expect(adminUpdateLimitsSchema.safeParse({ allowedModels: [''] }).success).toBe(false);
  });

  it('rejects a non-integer limit', () => {
    expect(adminUpdateLimitsSchema.safeParse({ requestsPerMinute: 1.5 }).success).toBe(false);
  });

  it('rejects a limit of zero, which would block all traffic', () => {
    expect(adminUpdateLimitsSchema.safeParse({ maxConcurrentRequests: 0 }).success).toBe(false);
  });
});

describe('buildChatRequestSchema (spec 12, 22)', () => {
  const ok = { model: 'gpt-4o', messages: [{ role: 'user' as const, content: 'hi' }] };

  it('accepts a minimal OpenAI-shaped request', () => {
    expect(chatSchema.parse(ok).model).toBe('gpt-4o');
  });

  it('accepts an unknown role but reports a readable message', () => {
    const r = chatSchema.safeParse({ model: 'm', messages: [{ role: 'wizard', content: 'hi' }] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toContain('system, user, assistant, tool');
  });

  it('rejects an empty messages array', () => {
    expect(chatSchema.safeParse({ model: 'm', messages: [] }).success).toBe(false);
  });

  it('rejects more messages than the configured cap', () => {
    const many = Array.from({ length: LIMITS.maxMessages + 1 }, () => ({ role: 'user' as const, content: 'x' }));
    expect(chatSchema.safeParse({ model: 'm', messages: many }).success).toBe(false);
  });

  it('reports the offending message index when content is too long', () => {
    const r = chatSchema.safeParse({
      model: 'm',
      messages: [
        { role: 'user', content: 'fine' },
        { role: 'user', content: 'x'.repeat(LIMITS.maxMessageChars + 1) },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(['messages', 1, 'content']);
  });

  it('accepts but preserves stripped parameters for the edge to drop', () => {
    // These are tolerated for SDK compatibility and removed before the upstream
    // call; rejecting them would break every stock OpenAI client.
    const r = chatSchema.parse({ ...ok, temperature: 0.7, top_p: 0.9, user: 'u1' });
    expect(r.temperature).toBe(0.7);
    expect(r.user).toBe('u1');
  });

  it('rejects an out-of-range temperature', () => {
    expect(chatSchema.safeParse({ ...ok, temperature: 9 }).success).toBe(false);
  });

  it('rejects max_tokens of 0 and enforces the hard cap', () => {
    expect(chatSchema.safeParse({ ...ok, max_tokens: 0 }).success).toBe(false);
    expect(chatSchema.safeParse({ ...ok, max_tokens: LIMITS.maxContentTokensHardCap + 1 }).success).toBe(false);
  });

  it('coerces a stringified max_tokens from a form-encoded client', () => {
    expect(chatSchema.parse({ ...ok, max_tokens: '256' }).max_tokens).toBe(256);
  });

  it('rejects a missing model', () => {
    expect(chatSchema.safeParse({ messages: [{ role: 'user', content: 'hi' }] }).success).toBe(false);
  });

  it('keeps unknown extra fields rather than throwing, for forward compatibility', () => {
    const r = chatSchema.parse({ ...ok, some_future_param: 1 });
    expect((r as Record<string, unknown>).some_future_param).toBe(1);
  });
});

/**
 * Tool calling. An agent client sends its toolset on every request, so a
 * dropped `tools` is not a missing feature but a silent one: the call still
 * returned 200 and the model replied in prose that it had no tools. These pin
 * the shape we accept, and equally the shapes we must still refuse.
 */
describe('buildChatRequestSchema — tool calling', () => {
  const ok = { model: 'gpt-4o', messages: [{ role: 'user' as const, content: 'hi' }] };
  const getWeather = {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Look up the weather',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  };

  it('accepts a function tool and preserves its schema verbatim', () => {
    const r = chatSchema.parse({ ...ok, tools: [getWeather] });
    expect(r.tools).toEqual([getWeather]);
  });

  it('accepts a tool with no parameters schema, as some clients send', () => {
    const r = chatSchema.parse({
      ...ok,
      tools: [{ type: 'function', function: { name: 'now' } }],
    });
    expect(r.tools).toHaveLength(1);
  });

  it('accepts vendor keys inside a function definition without rejecting them', () => {
    const r = chatSchema.parse({
      ...ok,
      tools: [
        {
          type: 'function',
          function: { name: 'f', parameters: { type: 'object' }, strict: true },
        },
      ],
    });
    expect((r.tools![0] as { function: Record<string, unknown> }).function.strict).toBe(true);
  });

  it('accepts a tool description longer than any invented cap', () => {
    // Real agent clients register shell and file tools whose descriptions run
    // well past 4,000 characters. A cap here rejected them with a message
    // naming tools.N.function.description, a field the caller never set.
    const r = chatSchema.parse({
      ...ok,
      tools: [{ type: 'function', function: { name: 'read', description: 'x'.repeat(20_000) } }],
    });
    expect((r.tools![0] as { function: { description: string } }).function.description).toHaveLength(20_000);
  });

  it('rejects a tool that is not a function', () => {
    expect(chatSchema.safeParse({ ...ok, tools: [{ type: 'retrieval' }] }).success).toBe(false);
  });

  it('rejects a function tool with no name', () => {
    expect(
      chatSchema.safeParse({ ...ok, tools: [{ type: 'function', function: { parameters: {} } }] }).success,
    ).toBe(false);
  });

  it('accepts a toolset far larger than any old fixed cap', () => {
    // A fixed count cap rejected real agent clients. The real bound is
    // MAX_REQUEST_BODY_BYTES, which Fastify enforces before this schema runs.
    const many = Array.from({ length: 400 }, (_, i) => ({
      type: 'function',
      function: { name: `t${i}`, parameters: { type: 'object' } },
    }));
    expect(chatSchema.safeParse({ ...ok, tools: many }).success).toBe(true);
  });

  it('accepts every tool_choice form', () => {
    for (const choice of ['none', 'auto', 'required', { type: 'function', function: { name: 'get_weather' } }]) {
      expect(chatSchema.safeParse({ ...ok, tool_choice: choice }).success).toBe(true);
    }
  });

  it('rejects an unknown tool_choice', () => {
    expect(chatSchema.safeParse({ ...ok, tool_choice: 'sometimes' }).success).toBe(false);
  });

  it('accepts an assistant turn that only requests tool calls', () => {
    // content: null is what OpenAI clients emit here, and rejecting it would
    // make every agent loop fail on its second turn.
    const r = chatSchema.parse({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'weather in Delhi?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Delhi"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '22C and clear' },
      ],
    });
    expect(r.messages).toHaveLength(3);
    expect(r.messages[1].content).toBeNull();
    expect(r.messages[2].tool_call_id).toBe('call_1');
  });

  it('rejects a tool call with no function name', () => {
    const r = chatSchema.safeParse({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { arguments: '{}' } }],
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('still bounds tool-result content like any other message', () => {
    const r = chatSchema.safeParse({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'tool', tool_call_id: 'c1', content: 'x'.repeat(LIMITS.maxMessageChars + 1) },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(['messages', 1, 'content']);
  });
});

/**
 * Image input.
 *
 * The shape is OpenAI's: `content` stays a bare string for a text-only client,
 * and only becomes an array when a client actually attaches an image. So most of
 * what matters here is the boundary — what an image URL is allowed to be, and
 * what happens when the operator turns image input off entirely.
 */
describe('buildChatRequestSchema — image input', () => {
  const ok = { model: 'gpt-4o', messages: [{ role: 'user' as const, content: 'hi' }] };
  // 1x1 PNG: the payload is irrelevant to the schema, only its declared type and
  // its decoded length are.
  const PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it('leaves a plain string message exactly as it was', () => {
    const r = chatSchema.parse(ok);
    expect(r.messages[0].content).toBe('hi');
  });

  it('accepts a base64 data: URL and keeps the part intact', () => {
    const r = chatSchema.safeParse({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image_url', image_url: { url: PNG, detail: 'low' } },
          ],
        },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      const parts = r.data.messages[0].content as { type: string }[];
      expect(parts.map((p) => p.type)).toEqual(['text', 'image_url']);
    }
  });

  it('accepts a remote image only over https', () => {
    const https = { model: 'gpt-4o', messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    ] }] };
    expect(chatSchema.safeParse(https).success).toBe(true);

    // The QR rule, applied to a model input: a URL swapped in transit shows the
    // model something the customer never chose.
    const http = { model: 'gpt-4o', messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'http://example.com/a.png' } },
    ] }] };
    expect(chatSchema.safeParse(http).success).toBe(false);
  });

  it('rejects an image type outside png, jpeg and webp', () => {
    const svg = { model: 'gpt-4o', messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' } },
    ] }] };
    expect(chatSchema.safeParse(svg).success).toBe(false);
  });

  it('rejects a non-base64 data: URL', () => {
    const plain = { model: 'gpt-4o', messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'data:image/png,not-base64' } },
    ] }] };
    expect(chatSchema.safeParse(plain).success).toBe(false);
  });

  it('rejects an image whose decoded size is over the limit', () => {
    // A base64 payload long enough to decode past maxImageBytes. The header
    // claims a tiny image; only the decoded length is checked, which is the
    // number that actually reaches the provider.
    const oversized = `data:image/png;base64,${'A'.repeat(8 * 1024 * 1024)}`;
    expect(chatSchema.safeParse({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: oversized } }] }],
    }).success).toBe(false);
  });

  it('counts images across the whole conversation, not per message', () => {
    // Replaying history would otherwise hand the client a fresh budget per turn
    // and smuggle an unbounded number of images into one billed request.
    const many = Array.from({ length: LIMITS.maxImagesPerRequest + 1 }, () => ({
      role: 'user' as const,
      content: [{ type: 'image_url' as const, image_url: { url: PNG } }],
    }));
    expect(chatSchema.safeParse({ model: 'gpt-4o', messages: many }).success).toBe(false);
  });

  it('still bounds the text of a text part', () => {
    const r = chatSchema.safeParse({
      model: 'gpt-4o',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'x'.repeat(LIMITS.maxMessageChars + 1) }],
      }],
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(['messages', 0, 'content', 0, 'text']);
  });

  it('refuses every image when the operator has turned image input off', () => {
    const off = buildChatRequestSchema({ ...LIMITS, maxImagesPerRequest: 0 });
    const r = off.safeParse({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: PNG } }] }],
    });
    expect(r.success).toBe(false);
    // A text-only request is unaffected, so disabling images cannot take the
    // text API down with it.
    expect(off.safeParse(ok).success).toBe(true);
  });
});
