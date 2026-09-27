import type { FastifyInstance } from 'fastify';

/**
 * A thin cookie-aware HTTP client for the integration suite.
 *
 * `app.inject()` does not maintain a cookie jar, so session tests would
 * otherwise have to copy the Set-Cookie header onto every subsequent request
 * by hand. Mirroring a real browser here is what makes the session-lifecycle
 * tests meaningful rather than a series of unrelated calls.
 */
export class Client {
  private cookies = new Map<string, string>();

  constructor(private readonly app: FastifyInstance) {}

  /**
   * `app.inject` wants cookies as a plain object, not a Cookie header string.
   * Passing the header separately too would duplicate them.
   */
  private cookieBag(): Record<string, string> {
    return Object.fromEntries(this.cookies);
  }

  private captureCookies(res: { headers: Record<string, unknown> }): void {
    const raw = res.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
    for (const c of list) {
      const [pair] = c.split(';');
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      // An empty value is a deletion, which is exactly how logout must work.
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    extraHeaders: Record<string, string> = {},
  ) {
    const res = await this.app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload: payload as object }),
      // Only claim a JSON body when there is one. Sending
      // `content-type: application/json` with an empty body is a 400, and a
      // real client posting to /api/auth/logout sends no content-type at all.
      headers: {
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        ...extraHeaders,
      },
      ...(this.cookies.size > 0 ? { cookies: this.cookieBag() } : {}),
    });
    this.captureCookies(res);
    return res;
  }

  get = (url: string, h?: Record<string, string>) => this.request('GET', url, undefined, h);
  post = (url: string, payload?: unknown, h?: Record<string, string>) => this.request('POST', url, payload, h);
  patch = (url: string, payload?: unknown, h?: Record<string, string>) => this.request('PATCH', url, payload, h);
  del = (url: string) => this.request('DELETE', url);

  json<T = Record<string, unknown>>(res: { body: string }): T {
    return JSON.parse(res.body) as T;
  }

  /** Drops the local jar, simulating a different browser. */
  reset(): void {
    this.cookies.clear();
  }
}

let seq = 0;

/** Unique-per-test identities, so parallel or repeated runs never collide. */
export function uniqueEmail(prefix = 'itest'): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}-${Math.random().toString(36).slice(2, 8)}@synzo.test`;
}

export const TEST_PASSWORD = 'integration-test-password';
