import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness.js';
import { Client, TEST_PASSWORD, uniqueEmail } from '../helpers/client.js';

/**
 * Who ends up holding the admin role on a fresh deployment.
 *
 * This is a security property, not a convenience. On a publicly reachable
 * signup form, "whichever person registers first" means whoever reached the
 * form first, and that account can approve itself, grant itself credits and
 * read every customer's ledger. `ADMIN_EMAIL` is the fix -- it makes operator
 * intent explicit -- while the first-admin fallback is kept so an unconfigured
 * deploy is still usable rather than locked out of its own admin APIs.
 *
 * The configured address is unique per run. The integration database is shared
 * and persistent, so a fixed address would already exist from a previous run
 * and the registration would 409 before any bootstrap logic was reached.
 */
const OPERATOR = uniqueEmail('operator');

let h: Harness;

beforeAll(async () => {
  h = await createHarness({
    creditSystem: true,
    env: { ADMIN_EMAIL: OPERATOR },
  });
});

afterAll(async () => {
  await h.close();
});

async function register(email: string): Promise<Client> {
  const c = new Client(h.app);
  const res = await c.post('/api/auth/register', { email, name: 'Bootstrap User', password: TEST_PASSWORD });
  expect(res.statusCode).toBe(201);
  return c;
}

describe('admin bootstrap', () => {
  it('makes the configured ADMIN_EMAIL an active admin, skipping the queue', async () => {
    const c = await register(OPERATOR);
    const me = c.json<{ user: { role: string; status: string } }>(await c.get('/api/me'));

    expect(me.user.role).toBe('admin');
    // Active, not pending: an admin blocked awaiting approval would have nobody
    // to approve them, which is the deadlock the bootstrap exists to avoid.
    expect(me.user.status).toBe('active');

    // And the role is real, not cosmetic -- an admin route actually opens.
    const res = await c.get('/api/admin/credits/customers?limit=1');
    expect(res.statusCode).toBe(200);
  });

  it('leaves every other signup a plain customer', async () => {
    // The database already holds admins, so the first-admin fallback cannot
    // fire here. This is the property that stops a configured ADMIN_EMAIL from
    // turning into "everyone is an admin".
    const c = await register(uniqueEmail('not-the-operator'));
    const me = c.json<{ user: { role: string; status: string } }>(await c.get('/api/me'));

    expect(me.user.role).toBe('customer');
    // APPROVAL_REQUIRED is on, so a customer signup waits for review.
    expect(me.user.status).toBe('pending');

    const res = await c.get('/api/admin/credits/customers?limit=1');
    expect(res.statusCode).toBe(403);
  });

  it('matches ADMIN_EMAIL case-insensitively', async () => {
    // An operator typing their address into .env should not be silently
    // downgraded to a customer for capitalising it. Lookups elsewhere in the
    // repository match case-insensitively, so the bootstrap has to agree with
    // them or the platform would hold two different opinions about whether
    // two spellings are the same person.
    //
    // The first case already registered OPERATOR, so the row is removed first:
    // a differently-cased registration is correctly a DUPLICATE (findByEmail
    // is case-insensitive) and would 409 before any bootstrap logic ran.
    // Deleting is a test-fixture action, not something production does.
    await h.sql`delete from users where lower(email) = lower(${OPERATOR})`;

    const [local, domain] = OPERATOR.split('@');
    const cased = `${local.toUpperCase()}@${domain.toUpperCase()}`;
    const c = await register(cased);
    const me = c.json<{ user: { role: string; status: string } }>(await c.get('/api/me'));

    expect(me.user.role).toBe('admin');
    expect(me.user.status).toBe('active');
  });
});
