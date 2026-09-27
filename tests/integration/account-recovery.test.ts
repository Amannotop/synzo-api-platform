import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { createHarness } from '../helpers/harness.js';
import { Client, TEST_PASSWORD, uniqueEmail } from '../helpers/client.js';

/**
 * Password reset and email verification (§8), exercised end to end against
 * real PostgreSQL.
 *
 * The raw token never leaves the server in these tests: the suite reads the
 * stored digest and looks the token up the way an attacker with a database dump
 * would, which is the only way to assert that a leaked table contains no
 * working credential. The token values themselves are minted directly so the
 * flow is driven through the real consume path.
 */
let harness: Awaited<ReturnType<typeof createHarness>>;

beforeAll(async () => {
  harness = await createHarness();
});
afterAll(async () => {
  await harness.close();
});

const digest = (raw: string) => createHash('sha256').update(raw).digest('hex');

/**
 * token_hash is UNIQUE, so a fixed literal would collide the second time this
 * suite ran against the same database. Randomness keeps reruns independent.
 */
const uniqueToken = (label: string) => `${label}-${randomBytes(24).toString('base64url')}`;

async function account() {
  const client = new Client(harness.app);
  const email = uniqueEmail('recover');
  await client.post('/api/auth/register', { email, name: 'R', password: TEST_PASSWORD });
  const me = client.json<{ user: { id: string; email: string } }>(await client.get('/api/me')).user;
  return { client, email, userId: me.id };
}

describe('password reset', () => {
  it('never reveals whether an address is registered', async () => {
    const known = await account();
    const unknown = uniqueEmail('nobody');

    const a = await known.client.post('/api/auth/password/forgot', { email: known.email });
    const b = await new Client(harness.app).post('/api/auth/password/forgot', { email: unknown });

    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);
    // Byte-identical bodies, so the endpoint is not an enumeration oracle.
    expect(a.body).toBe(b.body);
  });

  it('does not store the raw token, only its digest', async () => {
    const user = await account();
    const res = await user.client.post('/api/auth/password/forgot', { email: user.email });
    expect(res.statusCode).toBe(202);

    const rows = await harness.sql`
      select token_hash from account_tokens where user_id = ${user.userId} and purpose = 'password_reset'
    `;
    expect(rows.length).toBe(1);
    // 64 hex chars = SHA-256. If the table held anything else, a dump would be
    // directly replayable.
    expect(String(rows[0].token_hash)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts a valid token once and refuses every replay', async () => {
    const user = await account();
    // Confirms the request path really does mint a password_reset row before
    // the token itself is driven through the consume path below.
    const requested = await user.client.post('/api/auth/password/forgot', { email: user.email });
    expect(requested.statusCode).toBe(202);
    const rows = await harness.sql`
      select token_hash from account_tokens
      where user_id = ${user.userId} and purpose = 'password_reset' and consumed_at is null
    `;
    expect(rows.length).toBe(1);

    // The service mints its own random token and never returns it to the
    // caller, so the consume path is driven with a token whose digest this
    // test controls. That keeps the suite independent of outbound mail.
    const raw = uniqueToken('test-reset-token');
    await harness.sql`
      insert into account_tokens (user_id, token_hash, purpose, expires_at)
      values (${user.userId}, ${digest(raw)}, 'password_reset', now() + interval '1 hour')
    `;

    const fresh = new Client(harness.app);
    const first = await fresh.post('/api/auth/password/reset', { token: raw, password: 'a-brand-new-password' });
    expect(first.statusCode).toBe(200);

    const replay = await new Client(harness.app).post('/api/auth/password/reset', {
      token: raw,
      password: 'yet-another-password',
    });
    expect(replay.statusCode).toBe(400);
    expect(fresh.json<{ error: { code: string } }>(replay).error.code).toBe('invalid_reset_token');

    // The new password is live and the old one is not.
    const client = new Client(harness.app);
    expect((await client.post('/api/auth/login', { email: user.email, password: 'a-brand-new-password' })).statusCode).toBe(200);
    expect((await new Client(harness.app).post('/api/auth/login', { email: user.email, password: TEST_PASSWORD })).statusCode).toBe(401);
  });

  it('evicts existing sessions when the password is reset', async () => {
    const user = await account();
    expect((await user.client.get('/api/me')).statusCode).toBe(200);

    await user.client.post('/api/auth/password/forgot', { email: user.email });
    const raw = uniqueToken('session-eviction-token');
    await harness.sql`
      insert into account_tokens (user_id, token_hash, purpose, expires_at)
      values (${user.userId}, ${digest(raw)}, 'password_reset', now() + interval '1 hour')
    `;

    await user.client.post('/api/auth/password/reset', { token: raw, password: 'another-fresh-password' });

    // The pre-reset cookie must be dead: otherwise the reset would not have
    // locked out an attacker who already had a session.
    expect((await user.client.get('/api/me')).statusCode).toBe(401);
  });

  it('rejects an expired token', async () => {
    const user = await account();
    const raw = uniqueToken('expired-token');
    await harness.sql`
      insert into account_tokens (user_id, token_hash, purpose, expires_at)
      values (${user.userId}, ${digest(raw)}, 'password_reset', now() - interval '1 minute')
    `;

    const res = await new Client(harness.app).post('/api/auth/password/reset', {
      token: raw,
      password: 'should-never-be-applied',
    });
    expect(res.statusCode).toBe(400);
    // The old password still works, i.e. nothing was changed.
    expect(
      (await new Client(harness.app).post('/api/auth/login', { email: user.email, password: TEST_PASSWORD })).statusCode,
    ).toBe(200);
  });

  it('will not accept a password_reset token as an email_verification token', async () => {
    const user = await account();
    const raw = uniqueToken('cross-purpose-token');
    await harness.sql`
      insert into account_tokens (user_id, token_hash, purpose, expires_at)
      values (${user.userId}, ${digest(raw)}, 'password_reset', now() + interval '1 hour')
    `;

    const res = await new Client(harness.app).post('/api/auth/email/verify', { token: raw });
    expect(res.statusCode).toBe(400);
  });
});

describe('email verification', () => {
  it('marks the address verified and signs the customer in', async () => {
    const user = await account();
    const before = user.client.json<{ user: { emailVerified: boolean } }>(await user.client.get('/api/me'));
    expect(before.user.emailVerified).toBe(false);

    const raw = uniqueToken('verify-token');
    await harness.sql`
      insert into account_tokens (user_id, token_hash, purpose, expires_at)
      values (${user.userId}, ${digest(raw)}, 'email_verification', now() + interval '1 hour')
    `;

    const client = new Client(harness.app);
    const res = await client.post('/api/auth/email/verify', { token: raw });
    expect(res.statusCode).toBe(200);

    const after = client.json<{ user: { emailVerified: boolean } }>(await client.get('/api/me'));
    expect(after.user.emailVerified).toBe(true);
  });

  it('supersedes an outstanding token when a new one is issued', async () => {
    const user = await account();

    const first = uniqueToken('first-verify-token');
    await harness.sql`
      insert into account_tokens (user_id, token_hash, purpose, expires_at)
      values (${user.userId}, ${digest(first)}, 'email_verification', now() + interval '1 hour')
    `;

    // Requesting another one must invalidate the first, so only the newest link
    // in the customer's inbox still works.
    const resend = await user.client.post('/api/auth/email/resend');
    expect(resend.statusCode).toBe(200);
    expect(user.client.json<{ resent: boolean }>(resend).resent).toBe(true);

    const res = await new Client(harness.app).post('/api/auth/email/verify', { token: first });
    expect(res.statusCode).toBe(400);
  });

  it('does not let one account exhaust another account\'s resend budget', async () => {
    // The limiter used to be keyed by IP with a fixed cap of three, so every
    // customer sharing an egress address (office NAT, a CI runner) spent one
    // common budget. These two accounts are separate customers on the same
    // request IP, which is exactly the shape that broke.
    const a = await account();
    const b = await account();

    // Spend the whole budget on A, reading the cap from config so the test
    // tracks the deployment rather than a number copied out of it.
    const budget = harness.config.bruteForce.maxAttempts;
    for (let i = 0; i < budget; i += 1) {
      const res = await a.client.post('/api/auth/email/resend');
      expect(res.statusCode).toBe(200);
    }
    // A is now over its own limit...
    expect((await a.client.post('/api/auth/email/resend')).statusCode).toBe(429);
    // ...but B, a different customer behind the same IP, is untouched.
    expect((await b.client.post('/api/auth/email/resend')).statusCode).toBe(200);
  });
});
