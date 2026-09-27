import {
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  createHash,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Node caps scrypt's memory at 32MB by default, which is below what N=32768
 * requires (verified on Node 26: it throws ERR_CRYPRYPT_INVALID_SCRYPT_PARAMS).
 * We raise maxmem explicitly to 64MB so the intended cost factor is real
 * rather than silently weakened.
 */
const SCRYPT_N = 32768;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export type KeyEnvironment = 'live' | 'test';

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Rejection sampling keeps the distribution uniform. Plain modulo over
 * 62 would skew toward the first symbols of the alphabet.
 */
function randomBase62(length: number): string {
  const out: string[] = [];
  while (out.length < length) {
    const buf = randomBytes(length * 2);
    for (let i = 0; i < buf.length && out.length < length; i++) {
      const byte = buf[i] as number;
      if (byte < 248) out.push(BASE62[byte % 62] as string);
    }
  }
  return out.join('');
}

export function generateApiKeySecret(environment: KeyEnvironment): string {
  const prefix = environment === 'live' ? 'sk_live_' : 'sk_test_';
  return `${prefix}${randomBase62(40)}`;
}

/** The human-visible fragment stored alongside the hash, e.g. "sk_live_7Hf8kX". */
export function deriveKeyPrefix(fullKey: string): string {
  return fullKey.slice(0, 12);
}

/**
 * HMAC-SHA256 with a server-side pepper. Chosen over a bare digest so that a
 * stolen database dump cannot be attacked without also stealing the pepper
 * from the environment. Lookup is an exact indexed match, not a scan.
 */
export function hashApiKey(fullKey: string, pepper: string): string {
  return createHmac('sha256', pepper).update(fullKey).digest('hex');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time string compare that tolerates length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so timing does not reveal the length check.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/* ------------------------------------------------------------ passwords --- */

export interface PasswordHash {
  hash: string;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = await scrypt(password.normalize('NFKC'), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
    maxmem: SCRYPT_MAXMEM,
  });
  // Self-describing so parameters can be rotated later without breaking old hashes.
  return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const salt = Buffer.from(saltB64 as string, 'base64');
  const expected = Buffer.from(hashB64 as string, 'base64');
  let derived: Buffer;
  try {
    derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    return false;
  }
  return timingSafeEqual(derived, expected);
}

/**
 * Burn roughly one verification's worth of CPU when the account does not exist,
 * so response timing does not reveal whether an email is registered.
 */
export async function fakePasswordHash(): Promise<void> {
  await hashPassword(randomBase62(32));
}
