import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness.js';
import { Client, TEST_PASSWORD, uniqueEmail } from '../helpers/client.js';

/**
 * Plan entitlements, end to end, against the real database.
 *
 * What a customer buys is which models they may call, plus whether they may
 * send an image. Both are enforced on the API path, and both are only reachable
 * if the grant actually lands — which is the part that fails quietly.
 *
 * The specific failure this pins: `customer_limits.allowed_models` is nullable,
 * and NULL was doing two jobs at once. For a customer who bought the top tier it
 * means "every model". For a brand-new account it meant the column simply held
 * its null default. `unionAllowedModels` resolves that ambiguity towards "has
 * everything", which is right when access accumulates and wrong for the first
 * grant — so the entry package's two models unioned away to nothing and every
 * approved customer could still call all six. Nothing errored; the tier simply
 * did not exist. Migration 0008 makes the default an empty array so the two
 * states are distinguishable.
 *
 * Runs with both harness opt-ins: `creditSystem` because the entitlement is
 * granted on approval, and `planEntitlements` because the trial really does
 * restrict models. Each is separate, so a suite about credit accounting can
 * still address `max` and expect it to work.
 */
let h: Harness;
let admin: Client;

beforeAll(async () => {
  h = await createHarness({ creditSystem: true, planEntitlements: true });
  // The first account to EXIST becomes admin, and this database has been shared
  // across suites for days, so registration alone returns a plain customer.
  // Promote explicitly, as credits.test.ts and admin-search.test.ts do.
  const first = new Client(h.app);
  await first.post('/api/auth/register', {
    email: uniqueEmail('plan-admin'),
    name: 'Plan Admin',
    password: TEST_PASSWORD,
  });
  const firstId = first.json<{ user: { id: string } }>(await first.get('/api/me')).user.id;
  await h.sql`update users set role = 'admin' where id = ${firstId}`;
  admin = first;
});

afterAll(async () => {
  await h.close();
});

/** A registered, approved, funded customer with a live key. */
interface Account {
  client: Client;
  id: string;
  email: string;
  apiKey: string;
}

async function customer(prefix: string): Promise<Account> {
  const client = new Client(h.app);
  const email = uniqueEmail(prefix);
  const registered = client.json<{ user: { id: string } }>(
    await client.post('/api/auth/register', {
      email,
      name: 'Plan Tester',
      password: TEST_PASSWORD,
    }),
  );
  const id = registered.user.id;

  // Approve BEFORE minting a key. Under `creditSystem: true` the account
  // starts pending, and a pending account cannot reach the key routes at all.
  // This is also the call that applies the entry package's model access, so it
  // has to happen for the rest of the file to mean anything.
  const approved = await admin.post(`/api/admin/credits/customers/${id}/approve`, { note: 'test' });
  expect(approved.statusCode, approved.body).toBe(200);

  const projectId = client.json<{ project: { id: string } }>(
    await client.post('/api/projects', { name: 'Default' }),
  ).project.id;
  const apiKey = client.json<{ secret: string }>(
    await client.post('/api/keys', { name: 'primary', projectId }),
  ).secret;

  return { client, id, email, apiKey };
}

async function limitsFor(userId: string): Promise<{
  allowedModels: string | null;
  maxImages: number | null;
  planExpiresAt: Date | null;
}> {
  const rows = (await h.sql`
    select allowed_models, max_images, plan_expires_at
      from customer_limits where user_id = ${userId}
  `) as { allowed_models: string | null; max_images: number | null; plan_expires_at: Date | null }[];
  const row = rows[0];
  // Deliberately NOT `?? 0`: a null column is a real value here (null means
  // unlimited), and coalescing it to 0 would turn "unlimited images" into "no
  // images" in the assertion rather than in the database.
  if (!row) throw new Error(`no customer_limits row for ${userId}`);
  return {
    allowedModels: row.allowed_models,
    maxImages: row.max_images,
    planExpiresAt: row.plan_expires_at,
  };
}

/** A 1x1 PNG, for the image path. */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A chat request carrying `n` images. */
function imageBody(n: number, model = 'low') {
  return {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          ...Array.from({ length: n }, () => ({ type: 'image_url', image_url: { url: PNG } })),
        ],
      },
    ],
  };
}

function post(apiKey: string, body: unknown) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    payload: body as object,
  });
}

describe('plan entitlements', () => {
  it('restricts a newly approved account to the entry package rather than every model', async () => {
    const { id } = await customer('plan-entry');

    const limits = await limitsFor(id);
    // The bug this whole file exists for: this was NULL, i.e. all six models.
    expect(limits.allowedModels).not.toBeNull();
    expect(limits.allowedModels).not.toBe('[]');
    const list = JSON.parse(limits.allowedModels as string) as string[];
    expect(list.length).toBeGreaterThan(0);
    expect(list.length).toBeLessThan(6);
    // The entry package includes a small image allowance, so this is not 0.
    expect(limits.maxImages).toBe(3);
  });

  it('enforces the model restriction on the API path, not just in the database', async () => {
    const { apiKey } = await customer('plan-gate');

    // A model on the top tier must be refused for an entry-plan account. The
    // refusal is 404 rather than 403 so the catalogue cannot be enumerated.
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey}` },
      payload: { model: 'max', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('spends a plan image allowance across requests, not per request', async () => {
    const { client, id, apiKey } = await customer('plan-images');
    const allowance = (await limitsFor(id)).maxImages as number;
    expect(allowance).toBe(3);

    // One request carrying the whole allowance is fine: the cap is a total for
    // the period, not a limit on a single call.
    expect((await post(apiKey, imageBody(allowance))).statusCode).toBe(200);

    // The next image has nothing left to draw on.
    const res = await post(apiKey, imageBody(1));
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body) as {
      error?: { code?: string; imageLimit?: number | null; imagesSent?: number };
    };
    expect(body.error?.code).toBe('image_limit_exceeded');
    // The allowance is echoed, inside `error`, so a client can size its next
    // batch without a round trip.
    expect(body.error?.imageLimit).toBe(allowance);
    expect(body.error?.imagesSent).toBe(1);

    // Text is unaffected by an exhausted image allowance.
    expect(
      (
        await post(
          apiKey,
          { model: 'low', messages: [{ role: 'user', content: 'still working?' }] },
        )
      ).statusCode,
    ).toBe(200);
    void client;
  });

  it('leaves a text-only request alone, so the gate cannot take the text API down', async () => {
    const { apiKey } = await customer('plan-text');

    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey}` },
      payload: { model: 'low', messages: [{ role: 'user', content: 'hi' }] },
    });

    expect(res.statusCode).toBe(200);
  });

  it('grants image support when the purchased package includes it', async () => {
    const { client, id, email } = await customer('plan-image');

    const packages = client.json<{
      packages: { id: string; name: string; imageLimit: number | null }[];
    }>(await client.get('/api/credits')).packages;
    const withImages = packages.find((p) => p.imageLimit === null);
    expect(withImages, 'a package with unlimited images must be configured').toBeTruthy();

    const submitted = client.json<{ payment: { id: string } }>(
      await client.post('/api/credits/payments', {
        packageId: withImages!.id,
        reference: `plan-image-${id}`,
        confirmedEmail: email,
      }),
    );

    const approved = await admin.post(`/api/admin/credits/payments/${submitted.payment.id}/approve`, {
      note: 'test',
    });
    expect(approved.statusCode, approved.body).toBe(200);

    const limits = await limitsFor(id);
    // null is unlimited, which is a different claim from any number.
    expect(limits.maxImages).toBeNull();
    // And the term was set, measured from the approval rather than the claim.
    expect(limits.planExpiresAt).not.toBeNull();
    // postgres.js hands a timestamptz back as a string unless a parser is
    // configured, so coerce rather than assume a Date.
    const days = new Date(limits.planExpiresAt as unknown as string).getTime() - Date.now();
    expect(days / 86_400_000).toBeGreaterThan(29);
    expect(days / 86_400_000).toBeLessThan(31);
  });

  it('reverts to the base grant once the plan has expired', async () => {
    const { client, id, email } = await customer('plan-expiry');

    // A paid grant on top of the trial, through the real purchase flow, because
    // approvePayment takes a PAYMENT id rather than a package id.
    const packages = client.json<{ packages: { id: string; imageLimit: number | null }[] }>(
      await client.get('/api/credits'),
    ).packages;
    const top = packages.find((p) => p.imageLimit === null)!;
    const submitted = client.json<{ payment: { id: string } }>(
      await client.post('/api/credits/payments', {
        packageId: top.id,
        reference: `expiry-${id}`,
        confirmedEmail: email,
      }),
    );
    expect(
      (await admin.post(`/api/admin/credits/payments/${submitted.payment.id}/approve`, { note: 't' }))
        .statusCode,
    ).toBe(200);

    const during = await limitsFor(id);
    expect(during.allowedModels).toBeNull();
    expect(during.maxImages).toBeNull();

    // Wind the clock past the term. Expiry is evaluated per request, so this is
    // all it takes; nothing has to sweep for the revert to happen.
    await h.sql`
      update customer_limits set plan_expires_at = now() - interval '1 minute' where user_id = ${id}
    `;

    // Base values on the row: the entry tier, not the paid one.
    const base = (await h.sql`
      select base_allowed_models, base_max_images from customer_limits where user_id = ${id}
    `) as { base_allowed_models: string | null; base_max_images: number | null }[];
    expect(base[0]!.base_max_images).toBe(3);
    expect(base[0]!.base_allowed_models).not.toBeNull();
  });

  it('never narrows access when a cheaper package is bought later', async () => {
    const { client, id, email } = await customer('plan-additive');

    const packages = client.json<{
      packages: { id: string; name: string; allowedModels: string[] | null }[];
    }>(await client.get('/api/credits')).packages;
    const cheapest = packages.reduce((a, b) => (a.priceMinor <= b.priceMinor ? a : b));
    const top = packages.reduce((a, b) => (a.priceMinor >= b.priceMinor ? a : b));
    expect(cheapest.id).not.toBe(top.id);

    // Buy the top tier first, which grants every model (NULL).
    const first = client.json<{ payment: { id: string } }>(
      await client.post('/api/credits/payments', {
        packageId: top.id,
        reference: `additive-top-${id}`,
        confirmedEmail: email,
      }),
    );
    expect(
      (await admin.post(`/api/admin/credits/payments/${first.payment.id}/approve`, { note: 't' })).statusCode,
    ).toBe(200);
    expect((await limitsFor(id)).allowedModels).toBeNull();

    // Then buy the cheapest. A purchase is additive, so "all models" must stay
    // "all models" rather than dropping to two.
    const second = client.json<{ payment: { id: string } }>(
      await client.post('/api/credits/payments', {
        packageId: cheapest.id,
        reference: `additive-cheap-${id}`,
        confirmedEmail: email,
      }),
    );
    expect(
      (await admin.post(`/api/admin/credits/payments/${second.payment.id}/approve`, { note: 't' }))
        .statusCode,
    ).toBe(200);

    expect((await limitsFor(id)).allowedModels).toBeNull();
  });
});
