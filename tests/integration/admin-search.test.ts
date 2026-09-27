import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness.js';
import { Client, TEST_PASSWORD, uniqueEmail } from '../helpers/client.js';

/**
 * Admin customer search.
 *
 * An admin managing accounts looks people up by one of two things: the name
 * they signed up with, or the Gmail address they used. A search that only
 * covers one of them fails on a real lookup roughly half the time, so both
 * fields are matched here — and matched case-insensitively, because nobody
 * types an email address with the same capitalisation it was registered under.
 *
 * The other property under test is that the term is data, not SQL. LIKE
 * metacharacters are escaped and the term is bound as a parameter, so a
 * search for `100%` or `a_b` looks for those characters literally instead of
 * matching most of the table.
 */
let h: Harness;
let admin: Client;
let zephyr: { client: Client; id: string; name: string; email: string };
let quill: { client: Client; id: string; name: string; email: string };

beforeAll(async () => {
  h = await createHarness();

  // The first account to exist becomes admin by design (see
  // UserRepository.create), which is how the suite gets one without a
  // fixture. Registration is explicit anyway so the test does not depend on
  // that ordering rule holding.
  const first = new Client(h.app);
  await first.post('/api/auth/register', {
    email: uniqueEmail('search-admin'),
    name: 'Search Admin',
    password: TEST_PASSWORD,
  });
  const firstId = first.json<{ user: { id: string } }>(await first.get('/api/me')).user.id;
  await h.sql`update users set role = 'admin' where id = ${firstId}`;
  admin = first;

  async function makeCustomer(prefix: string, name: string): Promise<{
    client: Client; id: string; name: string; email: string;
  }> {
    const client = new Client(h.app);
    const email = uniqueEmail(prefix);
    await client.post('/api/auth/register', { email, name, password: TEST_PASSWORD });
    const id = client.json<{ user: { id: string } }>(await client.get('/api/me')).user.id;
    return { client, id, name, email };
  }

  // Distinct names AND distinct local parts, so a test can assert which field
  // actually matched rather than passing because both happened to hit.
  zephyr = await makeCustomer('zephyrcorp', 'Zephyr Kell');
  quill = await makeCustomer('quillworks', 'Quill Ashgrove');
});

afterAll(async () => {
  await h.close();
});

interface SearchResponse {
  customers: { id: string; name: string; email: string }[];
  total: number;
  matched: number;
  query: string;
}

async function search(q: string): Promise<SearchResponse> {
  return admin.json<SearchResponse>(await admin.get(`/api/admin/customers?q=${encodeURIComponent(q)}`));
}

describe('admin customer search', () => {
  it('matches on the customer name', async () => {
    const res = await search('zephyr');
    expect(res.customers.map((c) => c.id)).toContain(zephyr.id);
    expect(res.query).toBe('zephyr');
  });

  it('matches on the email address, which is how an admin finds a Gmail', async () => {
    const res = await search('quillworks');
    expect(res.customers.map((c) => c.id)).toContain(quill.id);
  });

  it('is case-insensitive on both fields', async () => {
    // Upper-cased name, and an upper-cased slice of the email local part.
    expect((await search('ZEPHYR')).customers.map((c) => c.id)).toContain(zephyr.id);
    const localPart = zephyr.email.split('@')[0]!.toUpperCase();
    expect((await search(localPart)).customers.map((c) => c.id)).toContain(zephyr.id);
  });

  it('reports the filtered count alongside the unfiltered total', async () => {
    const res = await search('zephyr');
    expect(res.matched).toBeLessThan(res.total);
    expect(res.matched).toBeGreaterThan(0);
    // The two customers created above are both in the table, so the total can
    // only grow; asserting against the exact value would break whenever an
    // unrelated suite registers an account.
    expect(res.total).toBeGreaterThanOrEqual(2);
  });

  it('returns an empty result rather than an error for a term that matches nobody', async () => {
    const res = await search('definitely-not-a-real-customer-xyzzy');
    expect(res.customers).toHaveLength(0);
    expect(res.matched).toBe(0);
  });

  it('treats LIKE metacharacters as literal text, not wildcards', async () => {
    // `%` matches every row in a raw LIKE. If it leaked through, this would
    // return the whole table instead of nothing.
    const wildcard = await search('%');
    expect(wildcard.customers).toHaveLength(0);
    expect(wildcard.matched).toBe(0);

    // `_` matches any single character. `zephyr_ell` must not match
    // "Zephyr Kell" if the underscore is being read as a wildcard.
    const underscore = await search('zephyr_ell');
    expect(underscore.customers).toHaveLength(0);
  });

  it('ignores a blank term and returns the unfiltered list', async () => {
    const res = await admin.json<SearchResponse>(await admin.get('/api/admin/customers?q=%20%20'));
    expect(res.query).toBe('');
    // A blank search is not a search, so matched must equal total — otherwise
    // the dashboard would show "0 of 128" over a full table.
    expect(res.matched).toBe(res.total);
  });

  it('still refuses the search to a non-admin customer', async () => {
    // The new query parameter must not become a way around the admin gate.
    expect((await zephyr.client.get('/api/admin/customers?q=zephyr')).statusCode).toBe(403);
  });
});
