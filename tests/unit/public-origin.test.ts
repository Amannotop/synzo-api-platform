import { describe, expect, it } from 'vitest';
import {
  LOCAL_ORIGIN,
  originContext,
  resolvePublicOrigin,
  type OriginRequestLike,
} from '../../apps/api/src/lib/public-origin.js';
import { accountTokenLink } from '../../apps/api/src/lib/mailer.js';

function req(overrides: Partial<OriginRequestLike> = {}): OriginRequestLike {
  return {
    protocol: 'http',
    hostname: 'api.synzo.dev',
    headers: {},
    ...overrides,
  };
}

const detected = { trustProxy: false, configuredBaseUrl: undefined };
const proxied = { trustProxy: true, configuredBaseUrl: undefined };

describe('resolvePublicOrigin', () => {
  it('derives the origin from the request host when nothing is configured', () => {
    const { origin, source } = resolvePublicOrigin(req(), detected, LOCAL_ORIGIN);
    expect(origin).toBe('http://api.synzo.dev');
    expect(source).toBe('request');
  });

  it('lets a configured value win outright, whatever the request says', () => {
    // This is the escape hatch when a proxy's headers are wrong, so a hostile
    // Host header must not be able to override an operator's configured domain.
    const { origin, source } = resolvePublicOrigin(
      req({ hostname: 'evil.example.com' }),
      { trustProxy: true, configuredBaseUrl: 'https://synzo.dev' },
      LOCAL_ORIGIN,
    );
    expect(origin).toBe('https://synzo.dev');
    expect(source).toBe('configured');
  });

  it('strips a trailing slash so links never gain a double slash', () => {
    const { origin } = resolvePublicOrigin(
      req(),
      { trustProxy: false, configuredBaseUrl: 'https://synzo.dev/' },
      LOCAL_ORIGIN,
    );
    expect(origin).toBe('https://synzo.dev');
  });

  it('falls back to the local origin for loopback and bare hosts', () => {
    for (const hostname of ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', 'intranet']) {
      const { origin } = resolvePublicOrigin(req({ hostname }), detected, LOCAL_ORIGIN);
      expect(origin).toBe(LOCAL_ORIGIN);
    }
  });

  it('keeps a public host with an explicit port', () => {
    // A staging deploy on a high port is still a real public origin.
    const { origin } = resolvePublicOrigin(
      req({ hostname: 'staging.synzo.dev:8443' }),
      detected,
      LOCAL_ORIGIN,
    );
    expect(origin).toBe('http://staging.synzo.dev:8443');
  });

  it('ignores forwarded headers when the app does not trust a proxy', () => {
    // Without this, any client could set the header and have a password-reset
    // link minted for a domain it controls.
    const { origin } = resolvePublicOrigin(
      req({
        hostname: 'attacker.example.com',
        headers: { 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'https' },
      }),
      detected,
      LOCAL_ORIGIN,
    );
    expect(origin).toBe('http://attacker.example.com');
  });

  it('uses forwarded headers when the app does trust a proxy', () => {
    // request.hostname is already X-Forwarded-Host-aware when trustProxy is on,
    // so the protocol is the part that needs the header.
    const { origin } = resolvePublicOrigin(
      req({ protocol: 'http', hostname: 'synzo.dev', headers: { 'x-forwarded-proto': 'https' } }),
      proxied,
      LOCAL_ORIGIN,
    );
    expect(origin).toBe('https://synzo.dev');
  });

  it('takes the left-most value from a chained forwarded header', () => {
    // Proxies append per hop: the client-facing entry comes first.
    const { origin } = resolvePublicOrigin(
      req({ hostname: 'synzo.dev', headers: { 'x-forwarded-proto': 'https, http' } }),
      proxied,
      LOCAL_ORIGIN,
    );
    expect(origin).toBe('https://synzo.dev');
  });

  it('ignores an unrecognised forwarded protocol rather than trusting it', () => {
    const { origin } = resolvePublicOrigin(
      req({ hostname: 'synzo.dev', headers: { 'x-forwarded-proto': 'gopher' } }),
      proxied,
      LOCAL_ORIGIN,
    );
    expect(origin).toBe('http://synzo.dev');
  });

  it('handles a repeated header arriving as an array', () => {
    const { origin } = resolvePublicOrigin(
      req({ hostname: 'synzo.dev', headers: { 'x-forwarded-proto': ['https', 'http'] } }),
      proxied,
      LOCAL_ORIGIN,
    );
    expect(origin).toBe('https://synzo.dev');
  });

  it('rejects a mangled host containing a slash or whitespace', () => {
    for (const hostname of [
      'synzo.dev/evil',
      'syn zo.dev',
      'synzo.dev\\@evil.test',
      'x'.repeat(300),
    ]) {
      const { origin } = resolvePublicOrigin(req({ hostname }), detected, LOCAL_ORIGIN);
      expect(origin).toBe(LOCAL_ORIGIN);
    }
  });

  it('supports an IPv6 literal host', () => {
    const { origin } = resolvePublicOrigin(
      req({ hostname: '[2001:db8::1]' }),
      detected,
      LOCAL_ORIGIN,
    );
    expect(origin).toBe('http://[2001:db8::1]');
  });
});

describe('originContext', () => {
  it('carries the configured url and the proxy trust flag', () => {
    expect(
      originContext({ publicBaseUrl: 'https://synzo.dev', security: { trustProxy: true } }),
    ).toEqual({
      trustProxy: true,
      configuredBaseUrl: 'https://synzo.dev',
    });
  });

  it('passes an unset base url through as undefined so detection runs', () => {
    expect(
      originContext({ publicBaseUrl: undefined, security: { trustProxy: false } })
        .configuredBaseUrl,
    ).toBeUndefined();
  });
});

describe('accountTokenLink', () => {
  it('builds a reset link on the supplied origin', () => {
    expect(accountTokenLink('https://synzo.dev', 'password_reset', 'tok en/+=')).toBe(
      'https://synzo.dev/reset-password?token=tok%20en%2F%2B%3D',
    );
  });

  it('builds a verification link on the supplied origin', () => {
    expect(accountTokenLink('https://synzo.dev', 'email_verification', 'abc')).toBe(
      'https://synzo.dev/verify-email?token=abc',
    );
  });

  it('does not double a slash when the origin has a trailing one', () => {
    expect(accountTokenLink('https://synzo.dev/', 'password_reset', 'abc')).toBe(
      'https://synzo.dev/reset-password?token=abc',
    );
  });
});
