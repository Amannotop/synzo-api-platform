import { describe, expect, it } from 'vitest';
import {
  buildSnippets, chatEndpoint, isCrossOrigin, modelsEndpoint, normalizeBaseUrl,
  parseConfig, serializeConfig, shellQuote,
} from '../../apps/dashboard/src/lib/playground.js';

/**
 * The playground's base-URL handling is the part most likely to be quietly
 * wrong: a person pasting a URL should not have to know which of three forms
 * the API expects, and a wrong join produces a 404 that looks like a bad key.
 */
describe('normalizeBaseUrl', () => {
  it('keeps a bare origin as-is', () => {
    expect(normalizeBaseUrl('https://api.example.com')).toBe('https://api.example.com');
  });

  it('strips a trailing slash', () => {
    expect(normalizeBaseUrl('https://api.example.com/')).toBe('https://api.example.com');
  });

  it('collapses a trailing /v1, since the SDK form and the docs form differ', () => {
    // A user pasting the SDK's base_url must not end up with /v1/v1.
    expect(normalizeBaseUrl('https://api.example.com/v1')).toBe('https://api.example.com');
    expect(normalizeBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com');
    expect(normalizeBaseUrl('https://api.example.com/V1')).toBe('https://api.example.com');
  });

  it('assumes https when no scheme is given', () => {
    expect(normalizeBaseUrl('api.example.com')).toBe('https://api.example.com');
  });

  it('preserves a non-default port, which a local deployment needs', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
  });

  it('preserves a path prefix but not the v1 segment', () => {
    expect(normalizeBaseUrl('https://example.com/app/v1')).toBe('https://example.com/app');
  });

  it('rejects input that is not a URL', () => {
    for (const bad of ['', '   ', 'not a url', '://missing', 'https://']) {
      expect(normalizeBaseUrl(bad)).toBeNull();
    }
  });

  it('rejects a non-http scheme rather than sending the key to it', () => {
    expect(normalizeBaseUrl('ftp://example.com')).toBeNull();
    expect(normalizeBaseUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('endpoint joining', () => {
  it('builds the chat and models paths without a double slash', () => {
    expect(chatEndpoint('https://api.example.com')).toBe('https://api.example.com/v1/chat/completions');
    expect(modelsEndpoint('https://api.example.com')).toBe('https://api.example.com/v1/models');
  });
});

describe('isCrossOrigin', () => {
  it('detects a different origin', () => {
    expect(isCrossOrigin('https://api.example.com', 'https://app.example.com')).toBe(true);
  });

  it('treats the same origin as same-origin', () => {
    expect(isCrossOrigin('https://app.example.com', 'https://app.example.com')).toBe(false);
  });

  it('treats a different port on the same host as cross-origin', () => {
    expect(isCrossOrigin('http://localhost:3000', 'http://localhost:5173')).toBe(true);
  });
});

describe('shellQuote', () => {
  it('wraps a plain value', () => {
    expect(shellQuote('hello')).toBe("'hello'");
  });

  it('escapes an embedded single quote rather than breaking the command', () => {
    // The standard POSIX idiom: close the quote, emit an escaped quote, reopen.
    // Without it a key containing a quote produces a shell syntax error that
    // looks like the key was rejected.
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe('buildSnippets', () => {
  const base = 'https://api.example.com';

  it('uses the configured base URL and key in every snippet', () => {
    const snippets = buildSnippets(base, 'sk_test_abc', 'GPT-6 Astra');
    for (const s of snippets) {
      expect(s.code).toContain('api.example.com');
    }
    expect(snippets.map((s) => s.id)).toEqual(['curl', 'python', 'javascript', 'models']);
  });

  it('gives the SDK snippets the /v1 base the OpenAI clients expect', () => {
    const snippets = buildSnippets(base, 'sk_test_abc', 'GPT-6 Astra');
    const py = snippets.find((s) => s.id === 'python')!;
    const js = snippets.find((s) => s.id === 'javascript')!;
    // The OpenAI SDKs append /chat/completions themselves, so it must be /v1.
    expect(py.code).toContain('https://api.example.com/v1');
    expect(js.code).toContain('https://api.example.com/v1');
  });

  it('does not double the v1 segment when the pasted base already has it', () => {
    const snippets = buildSnippets('https://api.example.com/v1', 'sk_test_abc', 'm');
    expect(snippets[0].code).toContain('https://api.example.com/v1/chat/completions');
    expect(snippets[0].code).not.toContain('/v1/v1');
  });

  it('uses a visible placeholder when no key has been entered', () => {
    // Snippets are generated before a key is typed, and a snippet containing
    // an empty string would look like a working client.
    const snippets = buildSnippets(base, '', 'm');
    expect(snippets[0].code).toContain('YOUR_API_KEY');
  });

  it('produces a curl snippet that survives a shell round trip', () => {
    const snippets = buildSnippets(base, "sk_test_o'brien", 'm');
    // The header value keeps the key intact while the quoting stays valid.
    expect(snippets[0].code).toContain("-H 'Authorization: Bearer sk_test_o'\\''brien'");
  });
});

describe('config persistence', () => {
  it('stores the key only when remembering was asked for', () => {
    const withKey = serializeConfig({
      baseUrl: 'https://x', apiKey: 'sk_test_secret', model: 'm', stream: true, rememberKey: true,
    });
    expect(withKey).toContain('sk_test_secret');

    const without = serializeConfig({
      baseUrl: 'https://x', apiKey: 'sk_test_secret', model: 'm', stream: true, rememberKey: false,
    });
    // The default is in-memory only, so the secret must not reach storage.
    expect(without).not.toContain('sk_test_secret');
  });

  it('ignores a stored key when the record does not opt in', () => {
    // A key left in storage from an older session must not come back just
    // because the field is present.
    const raw = JSON.stringify({ baseUrl: 'https://x', apiKey: 'sk_leaked', rememberKey: false });
    expect(parseConfig(raw).apiKey).toBeUndefined();
  });

  it('round-trips a config that does opt in', () => {
    const raw = serializeConfig({
      baseUrl: 'https://x', apiKey: 'sk_test_abc', model: 'm', stream: false, rememberKey: true,
    });
    const parsed = parseConfig(raw);
    expect(parsed.apiKey).toBe('sk_test_abc');
    expect(parsed.baseUrl).toBe('https://x');
    expect(parsed.stream).toBe(false);
  });

  it('tolerates missing, empty, corrupt, and wrongly-typed storage', () => {
    expect(parseConfig(null)).toEqual({});
    expect(parseConfig('')).toEqual({});
    expect(parseConfig('{not json')).toEqual({});
    expect(parseConfig('"a string"')).toEqual({});
    expect(parseConfig(JSON.stringify({ baseUrl: 42, model: null }))).toEqual({});
  });
});
