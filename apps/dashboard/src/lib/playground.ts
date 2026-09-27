/**
 * Pure helpers behind the API Playground.
 *
 * Kept free of React and of DOM types on purpose: the base-URL handling and
 * snippet generation are the parts most likely to be wrong, and this way they
 * are ordinary functions the unit suite can exercise directly.
 */

export interface PlaygroundConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  stream: boolean;
  rememberKey: boolean;
}

export const DEFAULT_CONFIG: PlaygroundConfig = {
  baseUrl: '',
  apiKey: '',
  model: '',
  stream: true,
  rememberKey: false,
};

/**
 * Normalizes a user-typed base URL down to its origin, without a trailing `/v1`.
 *
 * Both forms a person is likely to paste have to work, and they mean different
 * strings: OpenAI's SDKs are handed `https://host/v1` and append
 * `/chat/completions` themselves, while the API docs show the bare origin.
 * Collapsing a trailing `/v1` means the same base URL works for the playground,
 * the generated snippets and an SDK, and one fewer way for a paste to fail.
 *
 * Returns null for anything that is not an http(s) URL, so the caller can show
 * a real error rather than building a request against a nonsense origin.
 */
export function normalizeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // A scheme that is present but not http(s) is rejected, not repaired. Without
  // this check, "ftp://example.com" failed the http(s) test, got `https://`
  // prepended, and became the nonsense "https://ftp//example.com" — which
  // looks valid enough to be sent, and puts the API key somewhere unexpected.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) return null;

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  // A host must exist. "https://" parses, so this cannot be left implicit.
  if (!parsed.hostname) return null;

  const path = parsed.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '');
  return `${parsed.protocol}//${parsed.host}${path}`;
}

/** The full endpoint for a chat completion against a normalized base. */
export function chatEndpoint(baseUrl: string): string {
  return `${baseUrl}/v1/chat/completions`;
}

export function modelsEndpoint(baseUrl: string): string {
  return `${baseUrl}/v1/models`;
}

/** True when the base URL is one this browser could plausibly call. */
export function isCrossOrigin(baseUrl: string, pageOrigin: string): boolean {
  try {
    return new URL(baseUrl).origin !== new URL(pageOrigin).origin;
  } catch {
    return true;
  }
}

/**
 * Wraps a value in single quotes for a POSIX shell.
 *
 * The curl snippet is meant to be pasted and run, and a pasted secret that the
 * shell mangles produces a 401 that looks like a rejected key. Wrapping the
 * value properly means the snippet works whatever the key contains.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface Snippet {
  id: string;
  label: string;
  language: string;
  code: string;
}

/**
 * Builds copy-pasteable clients for whatever base URL and key are configured.
 *
 * These are the "use our API directly" artefacts: a person pastes one, runs it,
 * and gets a real response without having to work out the headers themselves.
 */
export function buildSnippets(baseUrl: string, apiKey: string, model: string): Snippet[] {
  const base = normalizeBaseUrl(baseUrl) ?? baseUrl.trim();
  const key = apiKey.trim() || 'YOUR_API_KEY';
  const m = model.trim() || 'GPT-6 Astra';
  const body = JSON.stringify(
    { model: m, messages: [{ role: 'user', content: 'Say hi' }] },
    null,
    2,
  );

  return [
    {
      id: 'curl',
      label: 'cURL',
      language: 'bash',
      code: [
        `curl ${shellQuote(`${base}/v1/chat/completions`)} \\`,
        `  -H ${shellQuote(`Authorization: Bearer ${key}`)} \\`,
        `  -H 'Content-Type: application/json' \\`,
        `  -d ${shellQuote(body)}`,
      ].join('\n'),
    },
    {
      id: 'python',
      label: 'Python',
      language: 'python',
      code: [
        'from openai import OpenAI',
        '',
        'client = OpenAI(',
        `    base_url=${pythonLiteral(`${base}/v1`)},`,
        `    api_key=${pythonLiteral(key)},`,
        ')',
        '',
        'response = client.chat.completions.create(',
        `    model=${pythonLiteral(m)},`,
        "    messages=[{'role': 'user', 'content': 'Say hi'}],",
        ')',
        'print(response.choices[0].message.content)',
      ].join('\n'),
    },
    {
      id: 'javascript',
      label: 'JavaScript',
      language: 'javascript',
      code: [
        "import OpenAI from 'openai';",
        '',
        'const client = new OpenAI({',
        `  baseURL: ${jsLiteral(`${base}/v1`)},`,
        `  apiKey: ${jsLiteral(key)},`,
        '});',
        '',
        'const response = await client.chat.completions.create({',
        `  model: ${jsLiteral(m)},`,
        "  messages: [{ role: 'user', content: 'Say hi' }],",
        '});',
        'console.log(response.choices[0].message.content);',
      ].join('\n'),
    },
    {
      id: 'models',
      label: 'List models',
      language: 'bash',
      code: [
        `curl ${shellQuote(`${base}/v1/models`)} \\`,
        `  -H ${shellQuote(`Authorization: Bearer ${key}`)}`,
      ].join('\n'),
    },
  ];
}

/** A Python string literal. Uses double quotes unless the value contains one. */
function pythonLiteral(value: string): string {
  return value.includes('"') ? `'${value}'` : `"${value}"`;
}

/** A JavaScript string literal, quoted so a quote in the value cannot break it. */
function jsLiteral(value: string): string {
  return JSON.stringify(value);
}

/**
 * Serializes the part of the config that is safe to keep on the device.
 *
 * The API key is only included when the person explicitly asked for it to be
 * remembered. Storing a secret in localStorage makes it readable by any script
 * running on the origin, so the default is to hold it in memory for the
 * session and let the choice be theirs to make.
 */
export function serializeConfig(config: PlaygroundConfig): string {
  const { baseUrl, model, stream, rememberKey, apiKey } = config;
  return JSON.stringify({ baseUrl, model, stream, rememberKey, ...(rememberKey ? { apiKey } : {}) });
}

/** Reads stored config, tolerating absent, corrupt, or partial data. */
export function parseConfig(raw: string | null): Partial<PlaygroundConfig> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};

  const o = parsed as Record<string, unknown>;
  const out: Partial<PlaygroundConfig> = {};
  if (typeof o.baseUrl === 'string') out.baseUrl = o.baseUrl;
  if (typeof o.model === 'string') out.model = o.model;
  if (typeof o.stream === 'boolean') out.stream = o.stream;
  if (typeof o.rememberKey === 'boolean') out.rememberKey = o.rememberKey;
  // A stored key is only honoured when the same record says it was
  // deliberately kept, so flipping the toggle off really does clear it.
  if (o.rememberKey === true && typeof o.apiKey === 'string') out.apiKey = o.apiKey;
  return out;
}
