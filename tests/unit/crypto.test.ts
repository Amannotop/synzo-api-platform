import { describe, expect, it } from 'vitest';
import {
  deriveKeyPrefix,
  fakePasswordHash,
  generateApiKeySecret,
  hashApiKey,
  hashPassword,
  safeEqual,
  sha256Hex,
  verifyPassword,
} from '../../apps/api/src/lib/crypto.js';

const PEPPER = 'test-pepper-that-is-at-least-32-characters-long';

describe('API key secrets (spec 5, 6)', () => {
  it('issues live and test keys with the documented prefixes', () => {
    expect(generateApiKeySecret('live')).toMatch(/^sk_live_[A-Za-z0-9]{40}$/);
    expect(generateApiKeySecret('test')).toMatch(/^sk_test_[A-Za-z0-9]{40}$/);
  });

  it('never repeats a secret', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateApiKeySecret('test')));
    expect(seen.size).toBe(500);
  });

  it('uses the full base62 alphabet, so the alphabet is not truncated', () => {
    // A generator stuck on a subset (or skewed by a modulo) would show up as
    // a much smaller character set over enough samples.
    const chars = new Set<string>();
    for (let i = 0; i < 200; i++) {
      // Strip the fixed sk_live_ prefix so only the random body is measured.
      for (const ch of generateApiKeySecret('live').slice('sk_live_'.length)) chars.add(ch);
    }
    expect(chars.size).toBe(62);
  });

  it('derives a 12-character display prefix', () => {
    const key = generateApiKeySecret('live');
    expect(deriveKeyPrefix(key)).toBe(key.slice(0, 12));
    expect(deriveKeyPrefix(key)).toMatch(/^sk_live_/);
  });
});

describe('hashApiKey (spec 6)', () => {
  it('is a 64-character hex HMAC', () => {
    expect(hashApiKey('sk_test_abc', PEPPER)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same key and pepper', () => {
    expect(hashApiKey('sk_test_abc', PEPPER)).toBe(hashApiKey('sk_test_abc', PEPPER));
  });

  it('changes completely when the pepper changes', () => {
    // The pepper is what makes a stolen database dump useless on its own.
    const a = hashApiKey('sk_test_abc', PEPPER);
    const b = hashApiKey('sk_test_abc', `${PEPPER}-rotated`);
    expect(a).not.toBe(b);
  });

  it('distinguishes different keys', () => {
    expect(hashApiKey('sk_test_aaa', PEPPER)).not.toBe(hashApiKey('sk_test_aab', PEPPER));
  });

  it('is not a bare sha256 of the key', () => {
    expect(hashApiKey('sk_test_abc', PEPPER)).not.toBe(sha256Hex('sk_test_abc'));
  });
});

describe('safeEqual', () => {
  it('matches identical strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
  });

  it('rejects different strings of equal length', () => {
    expect(safeEqual('abc', 'abd')).toBe(false);
  });

  it('rejects a length mismatch without throwing', () => {
    expect(safeEqual('abc', 'abcdef')).toBe(false);
    expect(safeEqual('', 'a')).toBe(false);
  });
});

describe('password hashing (spec 31)', () => {
  // scrypt at N=32768 costs real CPU; give these room.
  it('produces a self-describing scrypt hash', async () => {
    const hash = await hashPassword('correct horse battery staple');
    const parts = hash.split('$');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('scrypt');
    expect(Number(parts[1])).toBeGreaterThanOrEqual(32768);
  });

  it('salts, so the same password hashes differently each time', async () => {
    const a = await hashPassword('same-password-here');
    const b = await hashPassword('same-password-here');
    expect(a).not.toBe(b);
  });

  it('verifies a correct password', async () => {
    const hash = await hashPassword('my-real-password');
    expect(await verifyPassword('my-real-password', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('my-real-password');
    expect(await verifyPassword('my-real-passwore', hash)).toBe(false);
  });

  it('treats the password as Unicode-normalized, so NFC and NFD agree', async () => {
    const nfc = 'paßwort-ünicode';
    const nfd = nfc.normalize('NFD');
    expect(nfc).not.toBe(nfd);
    const hash = await hashPassword(nfc);
    expect(await verifyPassword(nfd, hash)).toBe(true);
  });

  it('rejects a malformed stored hash instead of throwing', async () => {
    for (const bad of ['', 'nonsense', 'scrypt$1$2$3', 'bcrypt$1$2$3$a$b', 'scrypt$a$b$c$d$e']) {
      expect(await verifyPassword('whatever', bad)).toBe(false);
    }
  });

  it('fakePasswordHash returns without producing a usable value', async () => {
    await expect(fakePasswordHash()).resolves.toBeUndefined();
  });
});

describe('sha256Hex', () => {
  it('matches the known digest of the empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
