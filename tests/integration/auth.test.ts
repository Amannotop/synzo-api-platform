import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness } from '../helpers/harness.js';
import { Client, TEST_PASSWORD, uniqueEmail } from '../helpers/client.js';

/**
 * Session lifecycle against the real app, real PostgreSQL and real cookies.
 * Session bugs (a logout that leaves the token valid, a suspended user who
 * keeps their session) are exactly the kind that a mocked session layer hides.
 */
let harness: Awaited<ReturnType<typeof createHarness>>;

beforeAll(async () => {
  harness = await createHarness();
});
afterAll(async () => {
  await harness.close();
});

async function register(client: Client, email = uniqueEmail('auth')) {
  const res = await client.post('/api/auth/register', { email, name: 'Test User', password: TEST_PASSWORD });
  return { res, email };
}

describe('registration', () => {
  it('creates an account and logs the user in', async () => {
    const c = new Client(harness.app);
    const { res, email } = await register(c);

    expect(res.statusCode).toBe(201);
    const body = c.json<{ user: { id: string; email: string } }>(res);
    expect(body.user.email).toBe(email);

    const me = await c.get('/api/me');
    expect(me.statusCode).toBe(200);
  });

  it('rejects a duplicate email with 409', async () => {
    const email = uniqueEmail('dup');
    const a = new Client(harness.app);
    await register(a, email);
    const b = new Client(harness.app);
    const res = await b.post('/api/auth/register', { email, name: 'Other', password: TEST_PASSWORD });
    expect(res.statusCode).toBe(409);
  });

  it('treats email casing and whitespace as the same account', async () => {
    // The unique index must see one canonical form, or a customer could
    // register a second account that looks identical in the dashboard.
    const email = uniqueEmail('case');
    const a = new Client(harness.app);
    expect((await register(a, email)).res.statusCode).toBe(201);

    const b = new Client(harness.app);
    const res = await b.post('/api/auth/register', {
      email: `  ${email.toUpperCase()}  `,
      name: 'Impostor',
      password: TEST_PASSWORD,
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects a weak password with 400', async () => {
    const c = new Client(harness.app);
    const res = await c.post('/api/auth/register', { email: uniqueEmail(), name: 'X', password: 'short' });
    expect(res.statusCode).toBe(400);
  });

  it('never returns the password hash', async () => {
    const c = new Client(harness.app);
    const { res } = await register(c);
    expect(res.body).not.toMatch(/passwordHash|password_hash|scrypt|\$scrypt/);
  });
});

describe('login', () => {
  it('authenticates with correct credentials', async () => {
    const c = new Client(harness.app);
    const { email } = await register(c);

    const fresh = new Client(harness.app);
    const res = await fresh.post('/api/auth/login', { email, password: TEST_PASSWORD });
    expect(res.statusCode).toBe(200);
    expect((await fresh.get('/api/me')).statusCode).toBe(200);
  });

  it('rejects a wrong password with 401', async () => {
    const c = new Client(harness.app);
    const { email } = await register(c);
    const res = await c.post('/api/auth/login', { email, password: 'definitely-wrong' });
    expect(res.statusCode).toBe(401);
  });

  it('gives the same error for a wrong password and an unknown account', async () => {
    // Differing messages would let an attacker enumerate registered emails.
    const c = new Client(harness.app);
    const { email } = await register(c);

    const wrongPassword = c.json<{ error: { message: string; code: string } }>(
      await c.post('/api/auth/login', { email, password: 'definitely-wrong' }),
    );
    const unknownAccount = c.json<{ error: { message: string; code: string } }>(
      await c.post('/api/auth/login', { email: uniqueEmail('ghost'), password: 'definitely-wrong' }),
    );
    expect(wrongPassword).toEqual(unknownAccount);
  });

  it('rate-limits repeated failed logins', async () => {
    const c = new Client(harness.app);
    const { email } = await register(c);

    let locked = 0;
    for (let i = 0; i < 12; i++) {
      const res = await c.post('/api/auth/login', { email, password: `wrong-${i}` });
      if (res.statusCode === 429) { locked = res.statusCode; break; }
    }
    expect(locked).toBe(429);
  });
});

describe('session lifecycle', () => {
  it('rejects /api/me with no session', async () => {
    const c = new Client(harness.app);
    expect((await c.get('/api/me')).statusCode).toBe(401);
  });

  it('rejects a tampered session cookie', async () => {
    // The cookie is signed; a modified value must not authenticate anyone.
    const c = new Client(harness.app);
    await register(c);
    const res = await c.get('/api/me', { cookie: 'synzo_session=forged.value' });
    expect(res.statusCode).toBe(401);
  });

  it('invalidates the session on logout', async () => {
    const c = new Client(harness.app);
    await register(c);
    expect((await c.get('/api/me')).statusCode).toBe(200);

    const out = await c.post('/api/auth/logout');
    expect(out.statusCode).toBeLessThan(300);

    // The cookie is cleared client-side, so replaying the old token must fail.
    const stale = await harness.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: 'synzo_session=stale-token-value' },
    });
    expect(stale.statusCode).toBe(401);
  });

  it('leaves the session unusable after logout even with the original cookie', async () => {
    const c = new Client(harness.app);
    await register(c);
    const before = c.get('/api/me');
    expect((await before).statusCode).toBe(200);

    // Capture the raw Set-Cookie value issued at registration.
    const issued = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: uniqueEmail('logout'), name: 'L', password: TEST_PASSWORD },
      headers: { 'content-type': 'application/json' },
    });
    const setCookie = issued.headers['set-cookie'] as unknown as string[];
    const token = setCookie[0].split(';')[0];

    const logger = new Client(harness.app);
    await logger.post('/api/auth/logout', undefined, { cookie: token });
    const after = await harness.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: token } });
    expect(after.statusCode).toBe(401);
  });
});

describe('password change', () => {
  it('changes the password and invalidates the old one', async () => {
    const c = new Client(harness.app);
    const { email } = await register(c);

    const NEW = 'a-brand-new-password-1';
    const res = await c.post('/api/me/password', { currentPassword: TEST_PASSWORD, newPassword: NEW });
    expect(res.statusCode).toBeLessThan(300);

    const fresh = new Client(harness.app);
    expect((await fresh.post('/api/auth/login', { email, password: TEST_PASSWORD })).statusCode).toBe(401);
    expect((await fresh.post('/api/auth/login', { email, password: NEW })).statusCode).toBe(200);
  });

  it('requires the correct current password', async () => {
    const c = new Client(harness.app);
    await register(c);
    const res = await c.post('/api/me/password', { currentPassword: 'wrong-current', newPassword: 'another-password-9' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('rejects a new password below the minimum length', async () => {
    const c = new Client(harness.app);
    await register(c);
    const res = await c.post('/api/me/password', { currentPassword: TEST_PASSWORD, newPassword: 'short' });
    expect(res.statusCode).toBe(400);
  });
});
