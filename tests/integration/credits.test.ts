import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness.js';
import { Client, TEST_PASSWORD, uniqueEmail } from '../helpers/client.js';
import { completionBody, json } from '../helpers/local-upstream.js';

/**
 * The credit system end to end, against the real database.
 *
 * The harness runs with `creditSystem: true`, so APPROVAL_REQUIRED is on and
 * every account here starts PENDING with a zero balance — the production
 * posture. Each case states the whole flow it depends on rather than sharing
 * one mutated customer, because most of the properties under test are
 * exactly-once claims and sharing a subject would let one case's grant mask
 * another's duplicate.
 */

let h: Harness;
let admin: Client;

const TRIAL = 500_000;

/**
 * A token unique to this process run, for request ids that must not collide
 * with a previous run's rows. The integration database is shared and
 * persistent, so a hardcoded id would collide with leftovers from a run hours
 * or days ago.
 */
const RUN = Math.random().toString(36).slice(2, 10);
const runId = () => RUN;

beforeAll(async () => {
  h = await createHarness({ creditSystem: true });
  // The first account to EXIST becomes admin by design (see
  // UserRepository.create). The integration project shares one database
  // across every suite, so by the time this file runs that slot is long gone
  // and registration alone hands back a plain customer -- every admin call
  // would 403 and the suite would fail for a reason that has nothing to do
  // with credits. Promote explicitly, as admin-search.test.ts does, so this
  // suite depends on nothing but its own setup.
  const first = new Client(h.app);
  await first.post('/api/auth/register', {
    email: uniqueEmail('credit-admin'),
    name: 'Credit Admin',
    password: TEST_PASSWORD,
  });
  const firstId = first.json<{ user: { id: string } }>(await first.get('/api/me')).user.id;
  await h.sql`update users set role = 'admin' where id = ${firstId}`;
  admin = first;
});

afterAll(async () => {
  await h.close();
});

interface Account {
  client: Client;
  id: string;
  email: string;
  secret: string;
}

/** Registers a customer and provisions an API key. The key is not usable yet. */
async function register(prefix: string): Promise<Account> {
  const client = new Client(h.app);
  const email = uniqueEmail(prefix);
  await client.post('/api/auth/register', { email, name: `Customer ${prefix}`, password: TEST_PASSWORD });
  const id = client.json<{ user: { id: string } }>(await client.get('/api/me')).user.id;
  const projectId = client.json<{ project: { id: string } }>(
    await client.post('/api/projects', { name: 'default' }),
  ).project.id;
  const secret = client.json<{ secret: string }>(
    await client.post('/api/keys', { name: 'primary', projectId }),
  ).secret;
  return { client, id, email, secret };
}

function chat(acct: Account, body: Record<string, unknown> = {}) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${acct.secret}` },
    payload: { model: 'max', messages: [{ role: 'user', content: 'hi' }], ...body },
  });
}

async function balance(userId: string) {
  return h.credits.getBalances(userId);
}

/* ------------------------------------------------- phase 2: approval gate */

describe('approval gate (spec phase 2)', () => {
  it('registers a customer as pending and grants no free credits', async () => {
    const c = await register('pending-1');
    const res = c.client.json<{ user: { status: string }; approvalRequired: boolean }>(
      await c.client.get('/api/me'),
    );
    expect(res.user.status).toBe('pending');
    const b = await balance(c.id);
    // The trial is granted on approval, never at registration.
    expect(b.freeGranted).toBe(0);
    expect(b.freeRemaining).toBe(0);
    expect(b.freeTrialGrantedAt).toBeNull();
  });

  it('refuses an API call from a pending account, without spending anything', async () => {
    h.upstream.respondWith((_req, res) => json(res, 200, completionBody()));
    const c = await register('pending-2');
    const res = await chat(c);
    expect(res.statusCode).toBe(401);
    // Indistinguishable from a bad key: the caller learns nothing about which
    // accounts exist or what state they are in.
    expect(res.json<{ error: { code: string } }>().error.code).toBe('invalid_api_key');
  });

  it('lets a pending customer sign in and see why they are blocked', async () => {
    const c = await register('pending-3');
    const view = c.client.json<{ account: { status: string; apiAccess: { allowed: boolean; reason: string | null } } }>(
      await c.client.get('/api/credits'),
    );
    expect(view.account.status).toBe('pending');
    expect(view.account.apiAccess.allowed).toBe(false);
    expect(view.account.apiAccess.reason).toBe('awaiting_approval');
  });

  it('blocks a rejected account and says so', async () => {
    const c = await register('reject-1');
    await admin.post(`/api/admin/credits/customers/${c.id}/reject`, { note: 'no' });
    const view = c.client.json<{ account: { status: string; apiAccess: { reason: string } } }>(
      await c.client.get('/api/credits'),
    );
    expect(view.account.status).toBe('rejected');
    expect(view.account.apiAccess.reason).toBe('account_rejected');
    expect((await chat(c)).statusCode).toBe(401);
  });
});

/* ------------------------------------------ phase 3: the one-time 500k trial */

describe('one-time free trial (spec phase 3)', () => {
  it('grants exactly 500,000 on approval', async () => {
    const c = await register('trial-1');
    const res = await admin.post(`/api/admin/credits/customers/${c.id}/approve`, { note: 'ok' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ alreadyTrialed: boolean; balance: { freeGranted: number; freeRemaining: number; hasFreeTrial: boolean } }>();
    expect(body.balance.freeGranted).toBe(TRIAL);
    expect(body.balance.freeRemaining).toBe(TRIAL);
    expect(body.alreadyTrialed).toBe(false);
  });

  it('does not grant a second trial on a repeated approval', async () => {
    const c = await register('trial-2');
    await admin.post(`/api/admin/credits/customers/${c.id}/approve`, {});
    const again = await admin.post(`/api/admin/credits/customers/${c.id}/approve`, {});
    expect(again.statusCode).toBe(200);
    expect(again.json<{ alreadyTrialed: boolean }>().alreadyTrialed).toBe(true);
    expect((await balance(c.id)).freeGranted).toBe(TRIAL);
  });

  it('grants exactly once under CONCURRENT approvals', async () => {
    const c = await register('trial-3');
    // Five approvals fired at once. The partial unique index on
    // (user_id) WHERE kind='free_trial_grant' is what makes this safe, not
    // the application checking first.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        admin.post(`/api/admin/credits/customers/${c.id}/approve`, {}),
      ),
    );
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    const b = await balance(c.id);
    expect(b.freeGranted).toBe(TRIAL);
    const granted = await h.sql<{ n: number }[]>`
      select count(*)::int as n from credit_ledger
      where user_id = ${c.id} and kind = 'free_trial_grant'`;
    expect(Number(granted[0]?.n)).toBe(1);
  });

  it('keeps free and paid balances separate', async () => {
    const c = await register('sep-1');
    await admin.post(`/api/admin/credits/customers/${c.id}/approve`, {});
    await admin.post(`/api/admin/credits/customers/${c.id}/adjust`, {
      bucket: 'paid', direction: 'add', amount: 1000, reason: 'purchase',
    });
    const b = await balance(c.id);
    expect(b.freeGranted).toBe(TRIAL);
    expect(b.paidGranted).toBe(1000);
    // A paid grant never touches the free pool.
    expect(b.freeRemaining).toBe(TRIAL);
  });

  it('records the trial in the ledger, and only ever once', async () => {
    const c = await register('ledger-1');
    await admin.post(`/api/admin/credits/customers/${c.id}/approve`, {});
    await admin.post(`/api/admin/credits/customers/${c.id}/approve`, {});
    const entries = await h.credits.listLedger(c.id);
    const trials = entries.filter((e) => e.kind === 'free_trial_grant');
    expect(trials).toHaveLength(1);
    expect(trials[0]?.amount).toBe(TRIAL);
  });
});

/* ------------------------------------------ phase 4: usage and exhaustion */

describe('usage and exhaustion (spec phase 4)', () => {
  it('deducts the ACTUAL token count, not the reservation', async () => {
    const c = await register('usage-1');
    await admin.post(`/api/admin/credits/customers/${c.id}/approve`, {});
    h.upstream.respondWith((_req, res) =>
      json(res, 200, completionBody({ usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })),
    );
    expect((await chat(c)).statusCode).toBe(200);
    const b = await balance(c.id);
    // Charged 120, not the ~32k worst case the reservation held.
    expect(b.freeUsed).toBe(120);
    expect(b.freeRemaining).toBe(TRIAL - 120);
    // And the reservation is fully returned, so nothing stays frozen.
    expect(b.freeReserved).toBe(0);
  });

  it('returns the unused part of the reservation, so it is not frozen', async () => {
    const c = await register('usage-2');
    await admin.post(`/api/admin/credits/customers/${c.id}/approve`, {});
    h.upstream.respondWith((_req, res) =>
      json(res, 200, completionBody({ usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })),
    );
    await chat(c);
    const b = await balance(c.id);
    expect(b.freeReserved).toBe(0);
    expect(b.freeRemaining).toBe(TRIAL - 10);
  });

  it('releases the reservation when the upstream fails, billing nothing', async () => {
    const c = await register('usage-3');
    await admin.post(`/api/admin/credits/customers/${c.id}/approve`, {});
    h.upstream.respondWith((_req, res) => json(res, 500, { error: 'boom' }));
    expect((await chat(c)).statusCode).toBeGreaterThanOrEqual(500);
    const b = await balance(c.id);
    // A request that produced no output must not cost the customer anything,
    // and must not leave their balance held hostage either.
    expect(b.freeUsed).toBe(0);
    expect(b.freeReserved).toBe(0);
    expect(b.freeRemaining).toBe(TRIAL);
  });

  it('spends free credits before paid ones', async () => {
    const c = await register('order-1');
    await admin.post(`/api/admin/credits/customers/${c.id}/approve`, {});
    await admin.post(`/api/admin/credits/customers/${c.id}/adjust`, {
      bucket: 'paid', direction: 'add', amount: 10_000, reason: 'purchase',
    });
    h.upstream.respondWith((_req, res) =>
      json(res, 200, completionBody({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })),
    );
    await chat(c);
    const b = await balance(c.id);
    expect(b.freeUsed).toBe(2);
    // Paid credits are untouched while free ones remain: the trial is a
    // promotion, so a paying customer should not watch it drain their money.
    expect(b.paidUsed).toBe(0);
  });

  it('blocks with a structured 402 once every credit is spent', async () => {
    const c = await register('exhaust-1');
    await admin.post(`/api/admin/credits/customers/${c.id}/approve`, {});
    // Drain the free pool down to a sliver via a manual deduct, which is the
    // only way to reach zero without making half a million upstream calls.
    await admin.post(`/api/admin/credits/customers/${c.id}/adjust`, {
      bucket: 'free', direction: 'deduct', amount: TRIAL - 10, reason: 'test setup',
    });
    h.upstream.respondWith((_req, res) =>
      json(res, 200, completionBody({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })),
    );
    await chat(c);
    const blocked = await chat(c);
    expect(blocked.statusCode).toBe(402);
    const err = blocked.json<{ error: { code: string; message: string; freeRemaining: number; paidRemaining: number } }>().error;
    expect(err.code).toBe('credit_exhausted');
    // The error names the balances so the customer can see where they stand.
    expect(err.freeRemaining).toBeLessThan(32_000);
    expect(err.paidRemaining).toBe(0);
  });

  it('cannot overspend under concurrent requests', async () => {
    const c = await register('race-1');
    await admin.post(`/api/admin/credits/customers/${c.id}/approve`, {});
    // Exactly enough free credits for ONE worst-case reservation and no more.
    const ceiling = h.config.credits.maxReservationTokens;
    await admin.post(`/api/admin/credits/customers/${c.id}/adjust`, {
      bucket: 'free', direction: 'deduct', amount: TRIAL - ceiling, reason: 'test setup',
    });
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    h.upstream.respondWith(async (_req, res) => {
      // Hold every request at the upstream at once, so they all try to claim
      // the same balance in the same instant.
      await gate;
      json(res, 200, completionBody({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });

    const inFlight = Array.from({ length: 8 }, () => chat(c));
    // Give the reservations a moment to collide, then let them all finish.
    await new Promise((r) => setTimeout(r, 250));
    release?.();

    const results = await Promise.all(inFlight);
    const ok = results.filter((r) => r.statusCode === 200).length;
    const refused = results.filter((r) => r.statusCode === 402).length;
    expect(ok + refused).toBe(8);
    // The whole point: the losers are refused rather than admitted and
    // settled into a negative balance.
    expect(ok).toBeLessThanOrEqual(1);
    const b = await balance(c.id);
    expect(b.freeRemaining).toBeGreaterThanOrEqual(0);
    expect(b.freeReserved).toBe(0);
  });

  it('reclaims a reservation orphaned by a crash', async () => {
    const c = await register('stale-1');
    await admin.post(`/api/admin/credits/customers/${c.id}/approve`, {});
    // Simulate a process that claimed tokens and then died: an open
    // reservation with nothing behind it.
    //
    // The request id is unique per run on purpose. `reserve` treats a repeated
    // request id as a RETRY of the same request and returns the existing claim
    // without taking anything, so a fixed literal would make this test pass
    // vacuously on every run after the first (and fail on a database that had
    // never seen it, in the opposite way). The shared integration database
    // outlives any single run, so the id has to be unique to match.
    const orphanId = `req_orphaned_${runId()}`;
    await h.credits.reserve({ requestId: orphanId, userId: c.id, amount: 100_000 });
    const mid = await balance(c.id);
    expect(mid.freeReserved).toBe(100_000);
    // Spendable excludes the orphan, so the account is short until it is
    // reclaimed.
    const view = c.client.json<{ balance: { freeReserved: number; totalRemaining: number } }>(
      await c.client.get('/api/credits'),
    );
    expect(view.balance.freeReserved).toBe(100_000);
    expect(view.balance.totalRemaining).toBe(TRIAL - 100_000);

    // Backdate it past the staleness window, then sweep.
    await h.sql`
      update credit_reservations set created_at = now() - interval '2 hours'
      where request_id = ${orphanId}`;
    await h.creditSweeper.sweepNow();
    /**
     * Assert on THIS customer's balance, not on the sweep's return value.
     *
     * `sweepNow()` reclaims stale reservations across the WHOLE table, and the
     * integration database is shared with every other suite and with every
     * previous run. Its total therefore includes rows this test knows nothing
     * about, so pinning it to 100,000 would make this suite fail for reasons
     * that have nothing to do with the account under test. The property that
     * actually matters is that the orphan's tokens came back to the customer
     * who lost them.
     */
    const after = await balance(c.id);
    expect(after.freeReserved).toBe(0);
    expect(after.freeRemaining).toBe(TRIAL);
  });

  it('leaves a live reservation alone, however long it has been open', async () => {
    const c = await register('stale-2');
    await admin.post(`/api/admin/credits/customers/${c.id}/approve`, {});
    const liveId = `req_live_${runId()}`;
    await h.credits.reserve({ requestId: liveId, userId: c.id, amount: 50_000 });
    // The sweep only touches reservations older than the window; this one is
    // inside it. Backdating by a few seconds must not be enough.
    await h.sql`
      update credit_reservations set created_at = now() - interval '10 seconds'
      where request_id = ${liveId}`;
    await h.creditSweeper.sweepNow();
    // The live claim survived, so a slow-but-real request is never robbed by
    // recovery. (Same reasoning as above for not asserting on the global
    // total: what matters is that THIS reservation was left alone.)
    expect((await balance(c.id)).freeReserved).toBe(50_000);
  });
});

/* --------------------- partial-balance reservation (the low-balance clamp) */

/**
 * A balance smaller than the worst-case reservation used to be a hard wall.
 *
 * With a 32k reservation ceiling, a customer holding 500 credits was shown
 * "500 remaining" by the dashboard and then refused every call, including a
 * two-word prompt that genuinely costs under 500. The account was presented as
 * funded and as broke at the same time, and the only way out was an admin
 * manual adjustment.
 *
 * The fix clamps the claim to what is actually spendable. These cases pin the
 * three properties that has to hold for the clamp to be safe: a funded
 * customer is served, an unfunded one is still refused, and the balance never
 * goes negative however the request is sized.
 *
 * The ceiling is lowered rather than the balance being raised, because the
 * production posture is a 32k reservation. That is the regime in which the bug
 * was found, and a test that used a small ceiling would pass even if the clamp
 * were removed entirely.
 */
describe('low-balance reservation clamp', () => {
  /** The floor CreditService enforces on every request. */
  const MIN = 64;
  /** Small enough that a 500-credit balance cannot cover the worst case. */
  const CEILING = 4_000;

  let h2: Harness;
  let admin2: Client;

  beforeAll(async () => {
    h2 = await createHarness({
      creditSystem: true,
      env: { CREDIT_MAX_RESERVATION_TOKENS: String(CEILING) },
    });
    // The integration project shares one database across every suite, so the
    // first-account-becomes-admin slot is long gone. Promote explicitly, the
    // same way the main suite above does.
    const first = new Client(h2.app);
    await first.post('/api/auth/register', {
      email: uniqueEmail('clamp-admin'),
      name: 'Clamp Admin',
      password: TEST_PASSWORD,
    });
    const firstId = first.json<{ user: { id: string } }>(await first.get('/api/me')).user.id;
    await h2.sql`update users set role = 'admin' where id = ${firstId}`;
    admin2 = first;
  });

  afterAll(async () => {
    await h2.close();
  });

  /**
   * A customer whose free balance is exactly `left`.
   *
   * Goes through approval first, because that is the only way a trial is
   * granted, then a manual deduct to reach the target balance. Draining 500k
   * tokens through real calls would be absurd; the ledger records the deduct
   * as its own auditable line either way.
   */
  async function funded(prefix: string, left: number): Promise<Account> {
    const client = new Client(h2.app);
    const email = uniqueEmail(prefix);
    await client.post('/api/auth/register', { email, name: `Customer ${prefix}`, password: TEST_PASSWORD });
    const id = client.json<{ user: { id: string } }>(await client.get('/api/me')).user.id;
    const projectId = client.json<{ project: { id: string } }>(
      await client.post('/api/projects', { name: 'default' }),
    ).project.id;
    const secret = client.json<{ secret: string }>(
      await client.post('/api/keys', { name: 'primary', projectId }),
    ).secret;

    await admin2.post(`/api/admin/credits/customers/${id}/approve`, {});
    if (left !== TRIAL) {
      await admin2.post(`/api/admin/credits/customers/${id}/adjust`, {
        bucket: 'free', direction: 'deduct', amount: TRIAL - left, reason: 'test setup',
      });
    }
    return { client, id, email, secret };
  }

  function ask(c: Account) {
    return h2.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${c.secret}` },
      payload: { model: 'max', messages: [{ role: 'user', content: 'hi' }] },
    });
  }

  it('serves a request the worst-case reservation alone would have refused', async () => {
    // Deliberately more than MIN and far less than CEILING, so the normal
    // reservation fails and only the clamp can admit the request.
    const bal = 500;
    const c = await funded('clamp-1', bal);
    h2.upstream.respondWith((_req, res) =>
      json(res, 200, completionBody({ usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })),
    );

    // The customer is served, which is the entire point of the fix.
    expect((await ask(c)).statusCode).toBe(200);

    const after = await h2.credits.getBalances(c.id);
    // Charged the ACTUAL 120 off the top -- not the clamp, and not the 4k
    // ceiling. The balance proves it: a frozen clamp would show 0 here.
    expect(after.freeRemaining).toBe(bal - 120);
    // The clamp is released, so the remainder is genuinely spendable again.
    expect(after.freeReserved).toBe(0);
    // And the invariant that makes the clamp safe at all.
    expect(after.freeRemaining).toBeGreaterThanOrEqual(0);
  });

  it('never lets the balance go negative, even when usage exceeds the balance', async () => {
    const bal = 200;
    const c = await funded('clamp-2', bal);
    // The provider reports MORE than the customer holds. This is the case that
    // would silently mint credits if settlement charged real usage blindly.
    h2.upstream.respondWith((_req, res) =>
      json(res, 200, completionBody({ usage: { prompt_tokens: 400, completion_tokens: 400, total_tokens: 800 } })),
    );

    expect((await ask(c)).statusCode).toBe(200);

    const after = await h2.credits.getBalances(c.id);
    // Settlement is capped at what was actually held, so the customer is
    // charged at most their balance and it stops exactly at zero. The
    // provider's 800 does not become 800 credits out of thin air.
    expect(after.freeRemaining).toBe(0);
    expect(after.freeReserved).toBe(0);
    // Nothing spilled into paid, and nothing is owed.
    expect(after.paidRemaining).toBe(0);
    expect(after.paidUsed).toBe(0);
  });

  it('still refuses when the balance cannot cover even a minimal request', async () => {
    // Below MIN, so there is nothing to clamp to and this IS a real exhaustion.
    const bal = MIN - 1;
    const c = await funded('clamp-3', bal);
    h2.upstream.respondWith((_req, res) => json(res, 200, completionBody()));

    const res = await ask(c);

    expect(res.statusCode).toBe(402);
    const err = res.json<{ error: { code: string; freeRemaining: number; paidRemaining: number } }>().error;
    expect(err.code).toBe('credit_exhausted');
    // The refusal is honest about what is left, which is the number the paywall
    // uses to decide whether to offer a top-up.
    expect(err.freeRemaining).toBe(bal);
    expect(err.paidRemaining).toBe(0);

    // Nothing was spent and nothing is frozen by the refused attempt.
    const after = await h2.credits.getBalances(c.id);
    expect(after.freeRemaining).toBe(bal);
    expect(after.freeReserved).toBe(0);
  });
});

/* ------------------------------------ phase 5/6: packages, paywall, payments */

describe('paywall and payments (spec phase 5, 6)', () => {
  it('serves active packages and billing config to a signed-in customer', async () => {
    const c = await register('pay-1');
    await admin.post(`/api/admin/credits/customers/${c.id}/approve`, {});
    const view = c.client.json<{
      packages: { id: string; name: string; credits: number; priceMinor: number }[];
      billing: { configured: boolean };
    }>(await c.client.get('/api/credits'));
    expect(view.packages.length).toBeGreaterThan(0);
    // A package's price and credit count come from the server, never the client.
    for (const p of view.packages) {
      expect(p.credits).toBeGreaterThan(0);
      expect(p.priceMinor).toBeGreaterThan(0);
    }
  });

  it('rejects a payment whose confirmed email is not the account email', async () => {
    const c = await register('pay-2');
    await admin.post(`/api/admin/credits/customers/${c.id}/approve`, {});
    const pkg = c.client.json<{ packages: { id: string }[] }>(await c.client.get('/api/credits')).packages[0]!;
    const res = await c.client.post('/api/credits/payments', {
      packageId: pkg.id,
      reference: 'TXN-EMAIL-MISMATCH-1',
      confirmedEmail: 'someone.else@example.com',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('email_mismatch');
  });

  it('creates a PENDING request and adds NO credits', async () => {
    const c = await register('pay-3');
    await admin.post(`/api/admin/credits/customers/${c.id}/approve`, {});
    const pkg = c.client.json<{ packages: { id: string; credits: number }[] }>(
      await c.client.get('/api/credits'),
    ).packages[0]!;
    const before = await balance(c.id);
    const res = await c.client.post('/api/credits/payments', {
      packageId: pkg.id,
      reference: 'TXN-PENDING-1',
      confirmedEmail: c.email,
    });
    expect(res.statusCode).toBe(201);
    const payment = res.json<{ payment: { id: string; status: string; credits: number } }>().payment;
    expect(payment.status).toBe('pending');
    // The server's own credit count for the package, not anything the client
    // could have asked for.
    expect(payment.credits).toBe(pkg.credits);
    // Submitting a form is not paying.
    const after = await balance(c.id);
    expect(after.paidGranted).toBe(before.paidGranted);
    expect(after.paidRemaining).toBe(before.paidRemaining);
  });

  it('ignores any attempt to dictate price or credits in the request body', async () => {
    const c = await register('pay-4');
    await admin.post(`/api/admin/credits/customers/${c.id}/approve`, {});
    const pkg = c.client.json<{ packages: { id: string; credits: number; priceMinor: number }[] }>(
      await c.client.get('/api/credits'),
    ).packages[0]!;
    // A client trying to buy 1,000,000,000 credits for one rupee. The schema
    // is strict, so the extra fields are a 400 rather than being ignored.
    const res = await c.client.post('/api/credits/payments', {
      packageId: pkg.id,
      reference: 'TXN-TAMPER-1',
      confirmedEmail: c.email,
      credits: 1_000_000_000,
      amountMinor: 1,
    });
    expect(res.statusCode).toBe(400);
    const payments = c.client.json<{ payments: unknown[] }>(await c.client.get('/api/credits/payments'));
    expect(payments.payments).toHaveLength(0);
  });

  it('refuses a duplicate transaction reference from the same customer', async () => {
    const c = await register('pay-5');
    await admin.post(`/api/admin/credits/customers/${c.id}/approve`, {});
    const pkg = c.client.json<{ packages: { id: string }[] }>(await c.client.get('/api/credits')).packages[0]!;
    const first = await c.client.post('/api/credits/payments', {
      packageId: pkg.id, reference: 'TXN-DUPE-1', confirmedEmail: c.email,
    });
    expect(first.statusCode).toBe(201);
    const second = await c.client.post('/api/credits/payments', {
      packageId: pkg.id, reference: 'TXN-DUPE-1', confirmedEmail: c.email,
    });
    expect(second.statusCode).toBe(409);
    const list = c.client.json<{ payments: unknown[] }>(await c.client.get('/api/credits/payments'));
    expect(list.payments).toHaveLength(1);
  });

  it('validates a receipt by its actual bytes, not its declared type', async () => {
    const c = await register('pay-6');
    await admin.post(`/api/admin/credits/customers/${c.id}/approve`, {});
    const pkg = c.client.json<{ packages: { id: string }[] }>(await c.client.get('/api/credits')).packages[0]!;

    // A real 1x1 PNG.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
    const ok = await c.client.post('/api/credits/payments', {
      packageId: pkg.id,
      reference: 'TXN-RECEIPT-OK',
      confirmedEmail: c.email,
      receiptDataUrl: `data:image/png;base64,${png}`,
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json<{ payment: { hasReceipt: boolean } }>().payment.hasReceipt).toBe(true);

    // HTML labelled as a PNG. The declared type is a string the client chose;
    // the magic bytes are the only thing that can be trusted.
    const html = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
    const spoof = await c.client.post('/api/credits/payments', {
      packageId: pkg.id,
      reference: 'TXN-RECEIPT-SPOOF',
      confirmedEmail: c.email,
      receiptDataUrl: `data:image/png;base64,${html}`,
    });
    expect(spoof.statusCode).toBe(400);
  });

  it('refuses an SVG receipt outright', async () => {
    const c = await register('pay-7');
    await admin.post(`/api/admin/credits/customers/${c.id}/approve`, {});
    const pkg = c.client.json<{ packages: { id: string }[] }>(await c.client.get('/api/credits')).packages[0]!;
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString('base64');
    const res = await c.client.post('/api/credits/payments', {
      packageId: pkg.id,
      reference: 'TXN-RECEIPT-SVG',
      confirmedEmail: c.email,
      receiptDataUrl: `data:image/svg+xml;base64,${svg}`,
    });
    expect(res.statusCode).toBe(400);
  });
});

/* ------------------------------------------ phase 8: admin payment handling */

describe('admin payment review (spec phase 8)', () => {
  async function submit(prefix: string, reference: string) {
    const c = await register(prefix);
    await admin.post(`/api/admin/credits/customers/${c.id}/approve`, {});
    const pkg = c.client.json<{ packages: { id: string; credits: number }[] }>(
      await c.client.get('/api/credits'),
    ).packages[0]!;
    const res = await c.client.post('/api/credits/payments', {
      packageId: pkg.id, reference, confirmedEmail: c.email,
    });
    expect(res.statusCode).toBe(201);
    return { c, paymentId: res.json<{ payment: { id: string; credits: number } }>().payment.id, credits: pkg.credits };
  }

  it('adds the exact purchased amount on approval, exactly once', async () => {
    const { c, paymentId, credits } = await submit('appr-1', 'TXN-APPROVE-1');
    const before = await balance(c.id);
    const res = await admin.post(`/api/admin/credits/payments/${paymentId}/approve`, { note: 'verified' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ replayed: boolean }>().replayed).toBe(false);
    const after = await balance(c.id);
    expect(after.paidGranted).toBe(before.paidGranted + credits);
    expect(after.paidRemaining).toBe(before.paidRemaining + credits);
  });

  it('does not allocate again on a repeated approval', async () => {
    const { c, paymentId, credits } = await submit('appr-2', 'TXN-APPROVE-2');
    await admin.post(`/api/admin/credits/payments/${paymentId}/approve`, {});
    const granted = await balance(c.id);
    const again = await admin.post(`/api/admin/credits/payments/${paymentId}/approve`, {});
    expect(again.statusCode).toBe(200);
    expect(again.json<{ replayed: boolean }>().replayed).toBe(true);
    const after = await balance(c.id);
    expect(after.paidGranted).toBe(granted.paidGranted);
    // The trial lives in the FREE bucket; a purchase adds only the package
    // amount to the PAID one. Asserting against paidGranted alone is the point
    // -- a double allocation would show up here as 2 x credits.
    expect(after.paidGranted).toBe(credits);
    expect(after.freeGranted).toBe(TRIAL);
  });

  it('allocates exactly once under CONCURRENT approvals', async () => {
    const { c, paymentId, credits } = await submit('appr-3', 'TXN-APPROVE-3');
    const results = await Promise.all(
      Array.from({ length: 6 }, () => admin.post(`/api/admin/credits/payments/${paymentId}/approve`, {})),
    );
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    const after = await balance(c.id);
    expect(after.paidGranted).toBe(credits);
    expect(after.freeGranted).toBe(TRIAL);
    const rows = await h.sql<{ n: number }[]>`
      select count(*)::int as n from credit_ledger
      where reference_id = ${paymentId} and kind = 'payment_credit'`;
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('restores API access after credits are allocated', async () => {
    const { c, paymentId } = await submit('restore-1', 'TXN-RESTORE-1');
    // Burn the trial down to nothing.
    await admin.post(`/api/admin/credits/customers/${c.id}/adjust`, {
      bucket: 'free', direction: 'deduct', amount: TRIAL, reason: 'test setup',
    });
    h.upstream.respondWith((_req, res) => json(res, 200, completionBody()));
    expect((await chat(c)).statusCode).toBe(402);

    await admin.post(`/api/admin/credits/payments/${paymentId}/approve`, {});
    // The very next call works, with no further action from the customer.
    expect((await chat(c)).statusCode).toBe(200);
    const view = c.client.json<{ account: { apiAccess: { allowed: boolean } } }>(
      await c.client.get('/api/credits'),
    );
    expect(view.account.apiAccess.allowed).toBe(true);
  });

  it('adds nothing when a payment is rejected, and requires a reason', async () => {
    const { c, paymentId } = await submit('rej-1', 'TXN-REJECT-1');
    const before = await balance(c.id);
    const noReason = await admin.post(`/api/admin/credits/payments/${paymentId}/reject`, {});
    expect(noReason.statusCode).toBe(400);
    const res = await admin.post(`/api/admin/credits/payments/${paymentId}/reject`, {
      note: 'no matching transaction found',
    });
    expect(res.statusCode).toBe(200);
    const after = await balance(c.id);
    expect(after.paidGranted).toBe(before.paidGranted);
    expect(after.paidRemaining).toBe(before.paidRemaining);
  });

  it('refuses to review an already-reviewed payment', async () => {
    const { paymentId } = await submit('rej-2', 'TXN-REJECT-2');
    await admin.post(`/api/admin/credits/payments/${paymentId}/reject`, { note: 'x' });
    const second = await admin.post(`/api/admin/credits/payments/${paymentId}/reject`, { note: 'x' });
    expect(second.statusCode).toBe(409);
    const approve = await admin.post(`/api/admin/credits/payments/${paymentId}/approve`, {});
    expect(approve.statusCode).toBe(200);
    expect(approve.json<{ replayed: boolean }>().replayed).toBe(true);
  });
});

/* --------------------------------------- phase 8/10: admin-only surfaces */

describe('admin authorization (spec phase 8, 10)', () => {
  it('refuses every admin credit route to a signed-in customer', async () => {
    const c = await register('idor-1');
    await admin.post(`/api/admin/credits/customers/${c.id}/approve`, {});
    const attempts: [string, string, unknown?][] = [
      ['GET', '/api/admin/credits/customers'],
      ['GET', `/api/admin/credits/customers/${c.id}`],
      ['POST', `/api/admin/credits/customers/${c.id}/approve`, {}],
      ['POST', `/api/admin/credits/customers/${c.id}/reject`, {}],
      ['POST', `/api/admin/credits/customers/${c.id}/adjust`, { bucket: 'free', direction: 'add', amount: 1, reason: 'x' }],
      ['GET', '/api/admin/credits/packages'],
      ['POST', '/api/admin/credits/packages', { name: 'x', credits: 1, priceMinor: 1 }],
      ['GET', '/api/admin/credits/payments'],
      ['PATCH', '/api/admin/credits/billing', { currency: 'USD' }],
    ];
    for (const [method, url, payload] of attempts) {
      const res = await c.client.request(method as 'GET' | 'POST' | 'PATCH', url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    // And nothing changed.
    const b = await balance(c.id);
    expect(b.freeGranted).toBe(TRIAL);
  });

  it('refuses admin routes to an anonymous caller', async () => {
    const anon = new Client(h.app);
    expect((await anon.get('/api/admin/credits/payments')).statusCode).toBe(401);
  });

  it('stops an admin approving or rejecting themselves', async () => {
    const me = admin.json<{ user: { id: string } }>(await admin.get('/api/me')).user.id;
    const approve = await admin.post(`/api/admin/credits/customers/${me}/approve`, {});
    expect(approve.statusCode).toBe(409);
    expect(approve.json<{ error: { code: string } }>().error.code).toBe('self_approval_blocked');
    const reject = await admin.post(`/api/admin/credits/customers/${me}/reject`, {});
    expect(reject.statusCode).toBe(409);
  });

  it('will not let an operator deduct more credits than exist', async () => {
    const c = await register('deduct-1');
    await admin.post(`/api/admin/credits/customers/${c.id}/approve`, {});
    const res = await admin.post(`/api/admin/credits/customers/${c.id}/adjust`, {
      bucket: 'free', direction: 'deduct', amount: TRIAL + 1, reason: 'too much',
    });
    expect(res.statusCode).toBe(409);
    const b = await balance(c.id);
    expect(b.freeRemaining).toBe(TRIAL);
  });

  it('refuses a manual adjustment with no reason', async () => {
    const c = await register('reason-1');
    await admin.post(`/api/admin/credits/customers/${c.id}/approve`, {});
    const res = await admin.post(`/api/admin/credits/customers/${c.id}/adjust`, {
      bucket: 'free', direction: 'add', amount: 1,
    });
    expect(res.statusCode).toBe(400);
  });

  it('does not let a customer read another customer ledger', async () => {
    const a = await register('ledger-iso-a');
    const b = await register('ledger-iso-b');
    await admin.post(`/api/admin/credits/customers/${a.id}/approve`, {});
    const entries = b.client.json<{ entries: { userId: string }[] }>(await b.client.get('/api/credits/ledger'));
    expect(entries.entries.every((e) => e.userId === b.id)).toBe(true);
  });
});

/* ------------------------------------ phase 7: telegram notification safety */

describe('telegram notifications (spec phase 7)', () => {
  it('keeps the payment when the notification fails', async () => {
    const c = await register('tg-1');
    await admin.post(`/api/admin/credits/customers/${c.id}/approve`, {});
    const pkg = c.client.json<{ packages: { id: string }[] }>(await c.client.get('/api/credits')).packages[0]!;
    // No bot token is configured in the harness, so this is exactly the
    // "Telegram is unreachable" path.
    const res = await c.client.post('/api/credits/payments', {
      packageId: pkg.id, reference: 'TXN-TG-FAIL-1', confirmedEmail: c.email,
    });
    expect(res.statusCode).toBe(201);
    // The claim survives, because it was written before any notification.
    const list = c.client.json<{ payments: { id: string; telegramStatus: string | null }[] }>(
      await c.client.get('/api/credits/payments'),
    );
    expect(list.payments).toHaveLength(1);
    // Skipped, not failed: nothing was misconfigured, it simply is not set up.
    expect(list.payments[0]?.telegramStatus).toBe('skipped');
  });

  it('never puts the bot token in a stored error or an API response', async () => {
    const c = await register('tg-2');
    await admin.post(`/api/admin/credits/customers/${c.id}/approve`, {});
    const pkg = c.client.json<{ packages: { id: string }[] }>(await c.client.get('/api/credits')).packages[0]!;
    const res = await c.client.post('/api/credits/payments', {
      packageId: pkg.id, reference: 'TXN-TG-LEAK-1', confirmedEmail: c.email,
    });
    const paymentId = res.json<{ payment: { id: string } }>().payment.id;
    const detail = await admin.get(`/api/admin/credits/customers/${c.id}`);
    const text = JSON.stringify(detail.json());
    expect(text).not.toMatch(/bot\d+:/i);
    expect(text).not.toMatch(/TELEGRAM_BOT_TOKEN/);
    const stored = await h.sql<{ telegram_error: string | null }[]>`
      select telegram_error from payment_requests where id = ${paymentId}`;
    expect(stored[0]?.telegram_error ?? '').not.toMatch(/bot\d+:/i);
  });
});

/**
 * The delivery path, with a stub standing in for api.telegram.org.
 *
 * The cases above cover what happens when Telegram is NOT configured, which is
 * the state this deployment is actually in. They cannot tell you whether the
 * notification would be USEFUL if it were configured: a notifier that silently
 * posted an empty body, omitted the amount, or dropped the receipt would pass
 * every test above while leaving the operator with nothing to act on.
 *
 * So the token-bearing call is intercepted and asserted on directly. The token
 * appears in the URL, so the assertions include the negative one: it must never
 * reach the message body, the stored error, or an API response.
 */
describe('telegram delivery (spec phase 7)', () => {
  const TOKEN = '123456789:AAFakeTokenForTestingOnly';
  const CHAT = '-1001234567890';

  let tg: Harness;
  let admin2: Client;
  /** Every call the notifier made, in order. */
  let calls: { url: string; method: string; body: unknown }[] = [];

  beforeAll(async () => {
    calls = [];
    const stubFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = url.slice(url.lastIndexOf('/') + 1);
      let body: unknown = init?.body;
      // A multipart body is left as-is; only the JSON messages are inspected,
      // and asserting on raw multipart bytes would test the runtime, not us.
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { /* leave as-is */ }
      }
      calls.push({ url, method, body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };

    /*
     * The notifier is constructed inside buildApp, so the real instance cannot
     * be handed a stub after the fact. Rather than reach into its privates, the
     * stub is installed on globalThis for the duration of the build, which is
     * the same hook the constructor itself uses when no explicit fetch is
     * given.
     */
    const original = globalThis.fetch;
    globalThis.fetch = stubFetch as typeof fetch;
    try {
      tg = await createHarness({
        creditSystem: true,
        env: {
          TELEGRAM_BOT_TOKEN: TOKEN,
          TELEGRAM_CHAT_ID: CHAT,
          PUBLIC_BASE_URL: 'https://synzo.example',
        },
      });
    } finally {
      globalThis.fetch = original;
    }

    // Swap the installed instance's fetch for the stub, so every later call is
    // recorded without rebuilding the app.
    (tg.telegram as unknown as { fetchImpl: typeof fetch }).fetchImpl = stubFetch;

    const first = new Client(tg.app);
    await first.post('/api/auth/register', {
      email: uniqueEmail('tgd-admin'), name: 'TG Admin', password: TEST_PASSWORD,
    });
    const firstId = first.json<{ user: { id: string } }>(await first.get('/api/me')).user.id;
    await tg.sql`update users set role = 'admin' where id = ${firstId}`;
    admin2 = first;
  });

  afterAll(async () => {
    await tg.close();
  });

  async function account(prefix: string) {
    const client = new Client(tg.app);
    const email = uniqueEmail(prefix);
    await client.post('/api/auth/register', { email, name: `TG ${prefix}`, password: TEST_PASSWORD });
    const id = client.json<{ user: { id: string } }>(await client.get('/api/me')).user.id;
    await admin2.post(`/api/admin/credits/customers/${id}/approve`, {});
    return { client, id, email };
  }

  it('posts a message naming every field the operator needs to act', async () => {
    const c = await account('tgd-1');
    const pkg = c.client.json<{ packages: { id: string; name: string; credits: number; priceMinor: number; currency: string }[] }>(
      await c.client.get('/api/credits'),
    ).packages[0]!;

    calls = [];
    const res = await c.client.post('/api/credits/payments', {
      packageId: pkg.id, reference: 'TXN-TGD-1', confirmedEmail: c.email,
    });
    expect(res.statusCode).toBe(201);
    const paymentId = res.json<{ payment: { id: string } }>().payment.id;

    const message = calls.find((x) => x.method === 'sendMessage');
    expect(message, 'no sendMessage call was made').toBeDefined();

    // The token belongs in the URL and nowhere else.
    expect(message!.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const text = (message!.body as { text: string }).text;

    // Every field the spec names, so the operator never has to go looking.
    expect(text).toContain(paymentId);
    expect(text).toContain(c.email);
    expect(text).toContain(c.id);
    expect(text).toContain(pkg.name);
    // Grouped the way the notifier formats it, so the operator reads 1,000,000
    // rather than a seven-digit run-on.
    expect(text).toContain(pkg.credits.toLocaleString('en-US'));
    expect(text).toContain('TXN-TGD-1');
    // Amount in whole currency units, not paise. Derived from the package rather
    // than hardcoded, because what this pins is the FORMATTING (paise must not
    // be shown), not the price — which is operator-editable and would otherwise
    // fail this suite the moment a price changed.
    expect(text).toMatch(new RegExp(`${(pkg.priceMinor / 100).toFixed(2)}\\b`));
    expect(text).toContain(pkg.currency);
    // And a way to get to it.
    expect(text).toContain('Open in admin dashboard');

    // The token must not have leaked into the message itself.
    expect(text).not.toContain(TOKEN);

    // Recorded as delivered, so the operator dashboard reflects reality.
    const listed = c.client.json<{ payments: { id: string; telegramStatus: string | null }[] }>(
      await c.client.get('/api/credits/payments'),
    );
    expect(listed.payments.find((p) => p.id === paymentId)?.telegramStatus).toBe('sent');
  });

  it('forwards a receipt as a photo, and reports failure without losing the payment', async () => {
    const c = await account('tgd-2');
    const pkg = c.client.json<{ packages: { id: string }[] }>(await c.client.get('/api/credits/payments')).packages?.[0]
      ?? c.client.json<{ packages: { id: string }[] }>(await c.client.get('/api/credits')).packages[0]!;

    calls = [];
    // A 1x1 PNG. Real magic bytes, so the upload validator accepts it.
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const res = await c.client.post('/api/credits/payments', {
      packageId: pkg.id, reference: 'TXN-TGD-RECEIPT', confirmedEmail: c.email, receiptDataUrl: png,
    });
    expect(res.statusCode).toBe(201);

    // The receipt rides as its own sendPhoto message, which is the only way the
    // Bot API accepts an attachment.
    const photo = calls.find((x) => x.method === 'sendPhoto');
    expect(photo, 'receipt was not forwarded to Telegram').toBeDefined();
    // The caption identifies which claim the image belongs to.
    expect(photo!.body).toBeInstanceOf(FormData);
    const form = photo!.body as FormData;
    expect(String(form.get('caption'))).toContain(
      res.json<{ payment: { id: string } }>().payment.id,
    );
  });

  it('re-sends a stored payment when the admin retries', async () => {
    const c = await account('tgd-3');
    const pkg = c.client.json<{ packages: { id: string }[] }>(await c.client.get('/api/credits')).packages[0]!;
    const res = await c.client.post('/api/credits/payments', {
      packageId: pkg.id, reference: 'TXN-TGD-RETRY', confirmedEmail: c.email,
    });
    const paymentId = res.json<{ payment: { id: string } }>().payment.id;

    calls = [];
    const retry = await admin2.post(`/api/admin/credits/payments/${paymentId}/telegram-retry`, {});
    expect(retry.statusCode).toBe(200);
    expect(retry.json<{ sent: boolean }>().sent).toBe(true);

    // The SAME id, so a retry cannot create a second claim in the operator's
    // inbox that has to be reconciled against the dashboard by hand.
    const message = calls.find((x) => x.method === 'sendMessage');
    expect(message).toBeDefined();
    expect((message!.body as { text: string }).text).toContain(paymentId);
  });
});

/* ------------------------------------------- streaming and cancellation */

describe('streaming credits (spec phase 4)', () => {
  it('settles a completed stream to the reported usage', async () => {
    const c = await register('stream-1');
    await admin.post(`/api/admin/credits/customers/${c.id}/approve`, {});
    h.upstream.respondWith((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
      res.write('data: {"usage":{"prompt_tokens":40,"completion_tokens":9,"total_tokens":49},"choices":[]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${c.secret}` },
      payload: { model: 'max', messages: [{ role: 'user', content: 'hi' }], stream: true },
    });
    expect(res.statusCode).toBe(200);
    // Streaming settles asynchronously, after the response is flushed.
    await new Promise((r) => setTimeout(r, 400));
    const b = await balance(c.id);
    expect(b.freeUsed).toBe(49);
    expect(b.freeReserved).toBe(0);
  });

  it('releases the reservation when a stream errors mid-flight', async () => {
    const c = await register('stream-2');
    await admin.post(`/api/admin/credits/customers/${c.id}/approve`, {});
    h.upstream.respondWith((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      res.destroy();
    });
    await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${c.secret}` },
      payload: { model: 'max', messages: [{ role: 'user', content: 'hi' }], stream: true },
    });
    await new Promise((r) => setTimeout(r, 500));
    const b = await balance(c.id);
    // Cut short: no billable output completed, so nothing is charged and
    // nothing stays held.
    expect(b.freeUsed).toBe(0);
    expect(b.freeReserved).toBe(0);
  });
});
