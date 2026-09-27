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

const LIMITS = { maxMessages: 200, maxMessageChars: 100_000, maxContentTokensHardCap: 200_000 };
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
