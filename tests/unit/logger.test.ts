import { describe, expect, it } from 'vitest';
import { redact, redactString } from '../../apps/api/src/lib/logger.js';

/**
 * Redaction is a hard security boundary (§31): a secret that reaches a log
 * sink is a leaked credential, even if the sink is a file nobody reads. These
 * tests assert on the redaction helper directly so every call site inherits
 * the guarantee.
 */
describe('redactString (spec 31)', () => {
  it('redacts a live API key anywhere in free text', () => {
    const key = 'sk_live_abcdef0123456789ABCDEF0123456789abcd';
    const out = redactString(`upstream rejected key ${key} today`);
    expect(out).not.toContain('abcdef0123456789ABCDEF0123456789abcd');
    expect(out).toContain('sk_live_[REDACTED]');
  });

  it('redacts test keys as well as live keys', () => {
    const key = 'sk_test_0123456789abcdef0123456789abcdef01234567';
    expect(redactString(`key=${key}`)).toBe('key=sk_test_[REDACTED]');
  });

  it('leaves ordinary text untouched', () => {
    expect(redactString('request completed in 42ms')).toBe('request completed in 42ms');
  });

  it('does not mangle strings that merely start with sk_live_', () => {
    // Too short to be a real key; redacting it would hide useful text.
    expect(redactString('sk_live_short')).toBe('sk_live_short');
  });
});

describe('redact (spec 31)', () => {
  it('redacts sensitive top-level keys regardless of casing', () => {
    const out = redact({
      Authorization: 'Bearer super-secret',
      COOKIE: 'session=abc',
      Password: 'hunter2hunter2',
      apiKey: 'whatever',
      database_url: 'postgres://u:p@h/db',
    }) as Record<string, unknown>;

    for (const key of ['Authorization', 'COOKIE', 'Password', 'apiKey', 'database_url']) {
      expect(out[key]).toBe('[REDACTED]');
    }
  });

  it('redacts secrets nested inside objects and arrays', () => {
    const out = redact({
      request: {
        headers: { authorization: 'Bearer abc' },
        keys: [{ api_key: 'sk_live_0123456789abcdef0123456789abcdef' }],
      },
    }) as Record<string, Record<string, Record<string, Record<string, unknown>>>>;

    expect(out.request.headers.authorization).toBe('[REDACTED]');
    expect(out.request.keys[0].api_key).toBe('[REDACTED]');
  });

  it('redacts a key embedded in a non-sensitive field', () => {
    const out = redact({ note: 'used sk_live_0123456789abcdef0123456789abcdef0123' }) as {
      note: string;
    };
    expect(out.note).toBe('used sk_live_[REDACTED]');
  });

  it('passes null and undefined through unchanged', () => {
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
  });

  it('truncates beyond the depth cap rather than recursing forever', () => {
    // A self-referencing object would otherwise blow the stack.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
  });

  it('keeps non-sensitive diagnostic fields intact', () => {
    const out = redact({ requestId: 'req_abc', statusCode: 429, ok: false }) as Record<string, unknown>;
    expect(out).toEqual({ requestId: 'req_abc', statusCode: 429, ok: false });
  });

  it('summarizes an Error without leaking the stack', () => {
    const err = new Error('failed for sk_live_0123456789abcdef0123456789abcdef0123');
    const out = redact(err) as { name: string; message: string };
    expect(out.name).toBe('Error');
    expect(out.message).not.toContain('abcdef0123456789abcdef');
  });
});
