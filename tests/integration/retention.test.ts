import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness.js';
import { Client, uniqueEmail, TEST_PASSWORD } from '../helpers/client.js';
import { completionBody, json } from '../helpers/local-upstream.js';

/**
 * Retention.
 *
 * `requests` is the only table that grows with traffic, and it had no pruning
 * at all. The rule that matters is not "delete old rows" but "delete old rows
 * without changing a number anyone was told": `usage_daily` is the durable
 * aggregate the dashboard and invoicing read from, so it has to outlive the raw
 * rows it was built from.
 *
 * The suite shares one database, so every case tags what it inserts and clears
 * it afterwards. A fixed id would collide with the previous case's row and the
 * failure would look like a bug in the code under test.
 */
describe('retention sweep', () => {
  let h: Harness;
  let userId: string;
  let projectId: string;
  let tag: string;
  let email: string;
  let client: Client;

  beforeEach(async () => {
    h = await createHarness();
    tag = uniqueEmail('ret').replace(/[^a-z0-9]/gi, '').slice(-10);
    // One client for the whole case, so the cookie set at sign-in is still
    // present when a later step needs an authenticated request.
    client = new Client(h.app);
    email = uniqueEmail('retention');
    await client.post('/api/auth/register', {
      email,
      name: 'Retention Owner',
      password: TEST_PASSWORD,
    });
    // Registration leaves the account unverified, so the session it sets is
    // not yet usable. Signing in is what produces a session that can actually
    // authenticate, which several cases below depend on.
    const login = await client.post('/api/auth/login', { email, password: TEST_PASSWORD });
    expect(login.statusCode).toBe(200);
    userId = client.json<{ user: { id: string } }>(login).user.id;
    projectId = client.json<{ project: { id: string } }>(
      await client.post('/api/projects', { name: 'Default project' }),
    ).project.id;
  });

  afterEach(async () => {
    // Scoped to this case's tag, so cleanup cannot delete another case's rows
    // and a failure here cannot cascade into unrelated tests.
    await h.sql`delete from requests where request_id like ${`ret-${tag}-%`}`;
    await h.sql`delete from account_tokens where token_hash like ${`${tag}-%`}`;
    // `usage_daily.day` is a varchar, so the comparison is on the string form
    // of the cutoff. Comparing it to a timestamp is an error, not a result.
    await h.sql`delete from usage_daily where day < ${'2000-01-01'}::text`;
    await h.close();
  });

  /** Inserts a request row dated `daysAgo` days into the past. */
  async function insertRequest(daysAgo: number, label: string): Promise<string> {
    const requestId = `ret-${tag}-${label}`;
    await h.sql`
      insert into requests
        (request_id, user_id, project_id, model_name, provider, status, http_status, latency_ms, created_at)
      values (
        ${requestId}, ${userId}, ${projectId}, 'max', 'opencode', 'success', 200, 42,
        now() - (${daysAgo}::int * interval '1 day')
      )`;
    return requestId;
  }

  it('deletes rows past the cutoff and keeps recent ones', async () => {
    const old = await insertRequest(200, 'old');
    const mid = await insertRequest(120, 'mid');
    const recent = await insertRequest(2, 'recent');

    await h.retention.sweepNow();

    // The sweep is global — it prunes every tenant's rows past the cutoff — so
    // this asserts on which of ITS OWN rows survived rather than on a total
    // count, which would couple the case to whatever other tests left behind in
    // the shared database.
    const survivors = await h.sql`
      select request_id from requests
      where request_id in (${old}, ${mid}, ${recent})`;
    expect(survivors.map((r) => r.request_id)).toEqual([recent]);
  });

  it('reports a cutoff matching the configured window', async () => {
    const result = await h.retention.sweepNow();
    const ageDays = (Date.now() - new Date(result.cutoff).getTime()) / 86_400_000;
    expect(ageDays).toBeGreaterThan(h.config.retention.requestDays - 1);
    // A fraction over the window is expected: the cutoff is computed before
    // the sweep runs, so a few milliseconds elapse between the two readings.
    expect(ageDays).toBeLessThan(h.config.retention.requestDays + 0.01);
  });

  it('leaves usage_daily untouched, so a billed number cannot change', async () => {
    // A rollup for a day far outside the retention window. If the sweep pruned
    // this, a customer asking about a month they have already been billed for
    // would get a different answer than the one on their invoice.
    const oldDay = new Date(Date.now() - 200 * 86_400_000).toISOString().slice(0, 10);
    await h.sql`
      insert into usage_daily
        (user_id, project_id, model_name, day, requests, successful_requests, total_tokens)
      values (${userId}, ${projectId}, 'max', ${oldDay}, 10, 10, 1234)`;
    await insertRequest(200, 'agg');

    const before = await h.sql`select count(*)::int as n from usage_daily`;
    await h.retention.sweepNow();
    const after = await h.sql`select count(*)::int as n from usage_daily`;

    expect(after[0].n).toBe(before[0].n);
    const rows = await h.sql`select requests, total_tokens from usage_daily where day = ${oldDay}`;
    expect(Number(rows[0].requests)).toBe(10);
    expect(Number(rows[0].total_tokens)).toBe(1234);

    await h.sql`delete from usage_daily where day = ${oldDay}`;
  });

  it('keeps a live request that is inside the window', async () => {
    const requestId = await insertRequest(1, 'live');
    await h.retention.sweepNow();
    const rows = await h.sql`select request_id from requests where request_id = ${requestId}`;
    expect(rows.length).toBe(1);
  });

  it('prunes expired sessions but leaves a live one alone', async () => {
    // beforeEach signed in, so there is a known live session to protect.
    expect((await client.get('/api/me')).statusCode).toBe(200);

    const liveRows = await h.sql`
      select id from sessions where user_id = ${userId} and expires_at > now()`;
    expect(liveRows.length).toBeGreaterThan(0);

    await h.sql`
      insert into sessions (user_id, token_hash, expires_at, created_at)
      values (${userId}, ${`${tag}-expired`}, now() - interval '1 hour', now() - interval '2 hours')`;

    await h.retention.sweepNow();

    // The expired one is gone, and the live one is still usable: the sweep
    // must not end the caller's own session.
    const expired = await h.sql`select id from sessions where token_hash = ${`${tag}-expired`}`;
    expect(expired.length).toBe(0);
    expect((await client.get('/api/me')).statusCode).toBe(200);
  });

  it('prunes an expired account token but not a live one', async () => {
    await h.sql`
      insert into account_tokens (user_id, purpose, token_hash, expires_at, created_at)
      values
        (${userId}, 'email_verification', ${`${tag}-expired`}, now() - interval '1 hour', now() - interval '2 hours'),
        (${userId}, 'email_verification', ${`${tag}-live`}, now() + interval '1 hour', now())`;

    const result = await h.retention.sweepNow();
    expect(result.accountTokensDeleted).toBe(1);

    const rows = await h.sql`
      select token_hash from account_tokens where token_hash like ${`${tag}-%`}`;
    expect(rows.map((r) => r.token_hash)).toEqual([`${tag}-live`]);
  });

  it('is safe to run twice in a row', async () => {
    await insertRequest(200, 'twice');
    const first = await h.retention.sweepNow();
    const second = await h.retention.sweepNow();
    // The second sweep having nothing to do is what makes the job safe to
    // schedule without tracking whether the previous run finished.
    expect(first.requestsDeleted).toBe(1);
    expect(second.requestsDeleted).toBe(0);
  });

  it('leaves a real customer request untouched, since it is inside the window', async () => {
    h.upstream.respondWith((_req, res) => json(res, 200, completionBody()));
    const secret = client.json<{ secret: string }>(
      await client.post('/api/keys', { name: 'primary', projectId }),
    ).secret;

    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'max', messages: [{ role: 'user', content: 'hi' }] },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    });
    expect(res.statusCode).toBe(200);

    const before = await h.sql`select count(*)::int as n from requests where user_id = ${userId}`;
    await h.retention.sweepNow();
    const after = await h.sql`select count(*)::int as n from requests where user_id = ${userId}`;

    // A request made moments ago is inside the window, so the sweep must not
    // have removed it.
    expect(after[0].n).toBe(before[0].n);
    expect(after[0].n).toBe(1);
  });
});
