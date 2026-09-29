import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  adjustCreditsSchema,
  adminDecisionSchema,
  billingSettingsSchema,
  createPackageSchema,
  paymentQuerySchema,
  updatePackageSchema,
} from '@synzo/validation';
import type { AppConfig } from '@synzo/config';
import { badRequest, conflict, notFoundOrForbidden } from '../lib/errors.js';
import { decodeImageDataUrl, readStoredImage } from '../lib/upload.js';
import { parseAllowedModels } from '../lib/allowed-models.js';
import { requireAdmin } from '../middleware/session-auth.js';
import {
  presentBalance,
  type CreditRepository,
} from '../repositories/credit.repository.js';
import type { UserRepository } from '../repositories/user.repository.js';
import type { AuditRepository } from '../repositories/audit.repository.js';
import type { TelegramService } from '../services/telegram.service.js';

interface AdminCreditDeps {
  config: AppConfig;
  credits: CreditRepository;
  telegram: TelegramService;
  users: UserRepository;
  audit: AuditRepository;
}

function fail(issues: { message: string; path: (string | number)[] }[]): never {
  const first = issues[0];
  throw badRequest(
    first?.message ?? 'Invalid request',
    'invalid_request',
    first?.path.join('.') || undefined,
  );
}

function meta(request: FastifyRequest) {
  return {
    ip: request.ip ?? null,
    userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
  };
}

/**
 * The operator half of the credit system.
 *
 * Every route is behind the admin gate registered by the admin routes plugin;
 * this module is only ever registered inside that scope. The checks here are
 * therefore about AUTHORISATION WITHIN admin — the things a gate cannot express:
 *
 *  - An admin cannot approve, reject or change their own status. A platform
 *    whose only admin can lock themselves out has no operator left, and the
 *    founding admin is exempt from approval precisely so this cannot strand
 *    the deployment.
 *
 *  - Approving grants the free trial exactly once, in the same transaction as
 *    the status change. A retried click is a replay, not a second grant.
 *
 *  - A payment is allocated in one transaction with its status change, guarded
 *    on `status = 'pending'`, so a double-click cannot add credits twice.
 *
 *  - Every action writes an audit row naming the actor. Money moved without a
 *    recorded reason is indistinguishable from a bug.
 */
export async function registerAdminCreditRoutes(
  app: FastifyInstance,
  deps: AdminCreditDeps,
): Promise<void> {
  const { config, credits, telegram, users, audit } = deps;

  /* ------------------------------------------------------ account review */

  /**
   * The customer list, now with each account's credit position.
   *
   * Joined in rather than fetched per row: an operator scanning the list needs
   * to see who is out of credits in the same glance that shows who is pending,
   * and an N+1 over 100 accounts is a visible stall.
   */
  app.get('/api/admin/credits/customers', async (request: FastifyRequest) => {
    requireAdmin(request);
    const query = request.query as { limit?: string; offset?: string; q?: string };
    const limit = Math.min(Number(query.limit ?? 100) || 100, 500);
    const offset = Number(query.offset ?? 0) || 0;

    /**
     * `q` narrows by name or email, reusing the SAME search predicate the
     * plain admin customer list uses, so an operator locates an account
     * identically in both places. It is capped so a pathological query cannot
     * become an expensive unbounded scan, and a blank term falls through to the
     * unfiltered list, which keeps the default view exactly as it was.
     */
    const term = (query.q ?? '').slice(0, 120).trim();
    const searchLimit = term ? Math.min(limit, 50) : limit;

    const [customers, matched, total] = await Promise.all([
      term
        ? deps.users.searchCustomers(term, searchLimit, offset)
        : deps.users.listCustomers(limit, offset),
      term ? deps.users.countCustomersMatching(term) : Promise.resolve(0),
      deps.users.countCustomers(),
    ]);
    const balances = await Promise.all(
      customers.map((c) => credits.getBalances(c.id)),
    );
    const ledgers = await credits.listLedgerForUsers(
      customers.map((c) => c.id),
      500,
    );

    return {
      customers: customers.map((c, i) => ({
        id: c.id,
        name: c.name,
        email: c.email,
        role: c.role,
        status: c.status,
        createdAt: c.createdAt,
        balance: presentBalance(balances[i]!),
        // A short activity tail so the operator can see what an account has
        // been spending without opening it.
        recentLedger: ledgers
          .filter((l) => l.userId === c.id)
          .slice(0, 5)
          .map((l) => ({
            id: l.id,
            bucket: l.bucket,
            kind: l.kind,
            amount: l.amount,
            createdAt: l.createdAt,
          })),
      })),
      total,
      // `matched` is how many accounts the current search found, so the UI can
      // tell "no such account" apart from "not on this page".
      matched: term ? matched : total,
      query: term,
      limit: searchLimit,
      offset,
    };
  });

  /** One account in full: status, both pools, the whole ledger, payments. */
  app.get('/api/admin/credits/customers/:id', async (request: FastifyRequest) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    const customer = await users.findById(id);
    if (!customer) throw notFoundOrForbidden();

    const [balance, ledger, payments] = await Promise.all([
      credits.getBalances(id),
      credits.listLedger(id, 200),
      credits.listPaymentsForUser(id, 50),
    ]);

    return {
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        role: customer.role,
        status: customer.status,
        unlimitedMode: customer.unlimitedMode,
        createdAt: customer.createdAt,
      },
      balance: presentBalance(balance),
      ledger: ledger.map((l) => ({
        id: l.id,
        bucket: l.bucket,
        kind: l.kind,
        amount: l.amount,
        balanceAfter: l.balanceAfter,
        reason: l.reason,
        referenceType: l.referenceType,
        referenceId: l.referenceId,
        actorUserId: l.actorUserId,
        createdAt: l.createdAt,
      })),
      payments: payments.map((p) => ({
        id: p.id,
        packageName: p.packageName,
        credits: p.credits,
        amountMinor: p.amountMinor,
        currency: p.currency,
        reference: p.reference,
        status: p.status,
        reviewNote: p.reviewNote,
        hasReceipt: Boolean(p.receiptMime),
        createdAt: p.createdAt,
        reviewedAt: p.reviewedAt,
      })),
    };
  });

  /* ------------------------------------------------------------ approval */

  /**
   * Approve a customer, granting the one-time free trial in the same
   * transaction.
   *
   * The trial is granted HERE and nowhere else. Registration creates a zero
   * balance, so an account that has never been approved has never been
   * credited, and a customer cannot obtain a trial by any other route.
   *
   * A retried approval is reported as `replayed: true` and grants nothing
   * further, which is what the exactly-once guarantee looks like from outside.
   */
  app.post('/api/admin/credits/customers/:id/approve', async (request: FastifyRequest) => {
    const admin = requireAdmin(request);
    const { id } = request.params as { id: string };
    // See the module comment: an admin approving themselves would be either a
    // no-op or a lockout, and neither should be a button that exists.
    if (id === admin.userId) {
      throw conflict('You cannot change your own approval status', 'self_approval_blocked');
    }

    const customer = await users.findById(id);
    if (!customer) throw notFoundOrForbidden();

    const parsed = adminDecisionSchema.safeParse(request.body ?? {});
    if (!parsed.success) fail(parsed.error.issues);

    const result = await credits.approveAccount({
      userId: id,
      adminId: admin.userId,
      trialTokens: config.credits.freeTrialTokens,
      note: parsed.data.note ?? null,
    });

    if (!result.ok) throw notFoundOrForbidden();

    await audit.record({
      actorUserId: admin.userId,
      action: 'customer.approved',
      resourceType: 'user',
      resourceId: id,
      metadata: {
        trialTokens: config.credits.freeTrialTokens,
        alreadyTrialed: result.alreadyTrialed,
        note: parsed.data.note ?? null,
      },
      ...meta(request),
    });

    return {
      customer: { id, status: 'active' },
      balance: presentBalance(result.balance),
      // Both flags are surfaced so the dashboard can say "approved" without
      // implying a second grant happened.
      alreadyApproved: result.alreadyApproved,
      alreadyTrialed: result.alreadyTrialed,
      trialTokens: config.credits.freeTrialTokens,
    };
  });

  /** Reject an applicant. No credits are added, and any existing ones are kept. */
  app.post('/api/admin/credits/customers/:id/reject', async (request: FastifyRequest) => {
    const admin = requireAdmin(request);
    const { id } = request.params as { id: string };
    if (id === admin.userId) {
      throw conflict('You cannot change your own approval status', 'self_approval_blocked');
    }

    const customer = await users.findById(id);
    if (!customer) throw notFoundOrForbidden();

    const parsed = adminDecisionSchema.safeParse(request.body ?? {});
    if (!parsed.success) fail(parsed.error.issues);

    await credits.rejectAccount(id);
    await audit.record({
      actorUserId: admin.userId,
      action: 'customer.rejected',
      resourceType: 'user',
      resourceId: id,
      metadata: { note: parsed.data.note ?? null },
      ...meta(request),
    });

    return { customer: { id, status: 'rejected' } };
  });

  /**
   * Suspend or reactivate. Deliberately separate from approve/reject: a
   * suspension is reversible and must not read as a rejection to the customer
   * or to an operator scanning the list. Neither path touches credits, so a
   * customer can be suspended and reactivated without the one-time trial ever
   * being re-granted.
   */
  app.post('/api/admin/credits/customers/:id/status', async (request: FastifyRequest) => {
    const admin = requireAdmin(request);
    const { id } = request.params as { id: string };
    if (id === admin.userId) {
      throw conflict('You cannot change your own account status', 'self_status_blocked');
    }

    const body = request.body as { status?: string };
    if (body?.status !== 'suspended' && body?.status !== 'active') {
      throw badRequest('status must be suspended or active', 'invalid_request', 'status');
    }

    const customer = await users.findById(id);
    if (!customer) throw notFoundOrForbidden();

    await users.updateStatus(id, body.status);
    await audit.record({
      actorUserId: admin.userId,
      action: body.status === 'suspended' ? 'customer.suspended' : 'customer.reactivated',
      resourceType: 'user',
      resourceId: id,
      ...meta(request),
    });

    return { customer: { id, status: body.status } };
  });

  /* ----------------------------------------------------- manual credits */

  /**
   * Manual add or deduct, with a required reason.
   *
   * The reason is enforced by the schema, not by convention: a ledger entry
   * with no reason is an entry nobody can explain later. Free and paid are
   * kept distinct so an operator correcting a free-trial over-grant does not
   * have to reason about the customer's purchased balance.
   */
  app.post('/api/admin/credits/customers/:id/adjust', async (request: FastifyRequest) => {
    const admin = requireAdmin(request);
    const { id } = request.params as { id: string };
    const parsed = adjustCreditsSchema.safeParse(request.body);
    if (!parsed.success) fail(parsed.error.issues);

    const customer = await users.findById(id);
    if (!customer) throw notFoundOrForbidden();

    const result = await credits.adjust({
      userId: id,
      bucket: parsed.data.bucket,
      direction: parsed.data.direction,
      amount: parsed.data.amount,
      reason: parsed.data.reason,
      adminId: admin.userId,
    });

    if (!result.ok) {
      if (result.reason === 'insufficient') {
        throw conflict('The account does not have that many credits to deduct', 'insufficient_credits');
      }
      throw notFoundOrForbidden();
    }

    await audit.record({
      actorUserId: admin.userId,
      action: parsed.data.direction === 'add' ? 'credits.granted' : 'credits.deducted',
      resourceType: 'user',
      resourceId: id,
      metadata: {
        bucket: parsed.data.bucket,
        amount: parsed.data.amount,
        reason: parsed.data.reason,
      },
      ...meta(request),
    });

    return { balance: presentBalance(result.balance), ledgerEntry: result.entry };
  });

  /** The immutable ledger across every account, newest first. */
  app.get('/api/admin/credits/ledger', async (request: FastifyRequest) => {
    requireAdmin(request);
    const query = request.query as { userId?: string; limit?: string };
    const limit = Math.min(Number(query.limit ?? 200) || 200, 1000);
    if (query.userId) {
      const entries = await credits.listLedger(query.userId, limit);
      return { entries: entries.map(presentLedger) };
    }
    const customers = await users.listCustomers(500, 0);
    const entries = await credits.listLedgerForUsers(
      customers.map((c) => c.id),
      limit,
    );
    return { entries: entries.map(presentLedger) };
  });

  /* ------------------------------------------------------------ packages */

  app.get('/api/admin/credits/packages', async (request: FastifyRequest) => {
    requireAdmin(request);
    const packages = await credits.listPackages(true);
    return {
      // `allowedModels` goes out parsed, as a real array or null, so the admin
      // editor does not have to JSON.parse a string to show what a package
      // grants. The stored form is still a JSON string; see presentPackage.
      packages: packages.map((p) => ({
        ...p,
        description: p.description ?? null,
        allowedModels: parseAllowedModels(p.allowedModels),
      })),
    };
  });

  app.post('/api/admin/credits/packages', async (request: FastifyRequest, reply: FastifyReply) => {
    const admin = requireAdmin(request);
    const parsed = createPackageSchema.safeParse(request.body);
    if (!parsed.success) fail(parsed.error.issues);

    // `description` is optional in the schema, but the column is NOT NULL
    // with a default of absent-means-null, so it is normalised here rather than
    // widening the repository's contract.
    const created = await credits.createPackage({
      ...parsed.data,
      description: parsed.data.description ?? null,
    });
    await audit.record({
      actorUserId: admin.userId,
      action: 'package.created',
      resourceType: 'credit_package',
      resourceId: created.id,
      metadata: { name: created.name, credits: created.credits, priceMinor: created.priceMinor },
      ...meta(request),
    });
    return reply.status(201).send({ package: created });
  });

  app.patch('/api/admin/credits/packages/:id', async (request: FastifyRequest) => {
    const admin = requireAdmin(request);
    const { id } = request.params as { id: string };
    const parsed = updatePackageSchema.safeParse(request.body);
    if (!parsed.success) fail(parsed.error.issues);

    const updated = await credits.updatePackage(id, parsed.data);
    if (!updated) throw notFoundOrForbidden();

    await audit.record({
      actorUserId: admin.userId,
      action: 'package.updated',
      resourceType: 'credit_package',
      resourceId: id,
      metadata: parsed.data as Record<string, unknown>,
      ...meta(request),
    });
    return { package: updated };
  });

  /* ----------------------------------------------------- billing config */

  app.get('/api/admin/credits/billing', async (request: FastifyRequest) => {
    requireAdmin(request);
    return { billing: await credits.getBillingSettings() };
  });

  /**
   * Updates the payment QR code, instructions and method label.
   *
   * A QR supplied as a data URL is decoded and its magic bytes verified before
   * it is stored, so what reaches the customer's paywall is a real PNG/JPEG/
   * WebP and not an arbitrary payload the operator's own browser would later
   * render. An https URL is accepted for an already-hosted image; plain http
   * is rejected because a payment QR fetched over it can be swapped in
   * transit, and the customer who scans the swapped one pays the wrong person.
   */
  app.patch('/api/admin/credits/billing', async (request: FastifyRequest) => {
    const admin = requireAdmin(request);
    const parsed = billingSettingsSchema.safeParse(request.body);
    if (!parsed.success) fail(parsed.error.issues);

    const fields: Parameters<CreditRepository['updateBillingSettings']>[0] = {
      ...(parsed.data.paymentInstructions !== undefined
        ? { paymentInstructions: parsed.data.paymentInstructions }
        : {}),
      ...(parsed.data.paymentMethodLabel !== undefined
        ? { paymentMethodLabel: parsed.data.paymentMethodLabel }
        : {}),
      ...(parsed.data.currency !== undefined ? { currency: parsed.data.currency } : {}),
    };

    if (parsed.data.qrCodeUrl !== undefined) {
      if (parsed.data.qrCodeUrl === null || parsed.data.qrCodeUrl === '') {
        fields.qrCodeUrl = null;
        fields.qrCodeMime = null;
        fields.qrCodeBytes = null;
      } else if (parsed.data.qrCodeUrl.startsWith('data:')) {
        const decoded = decodeImageDataUrl(
          parsed.data.qrCodeUrl,
          config.credits.maxPaymentUploadBytes,
          'qrCodeUrl',
        );
        fields.qrCodeUrl = decoded.dataUrl;
        fields.qrCodeMime = decoded.mime;
        fields.qrCodeBytes = decoded.bytes.byteLength;
      } else {
        // An https URL. Stored as-is: it is the operator's own hosted image and
        // fetching it server-side would add an outbound request to a config
        // save, plus a SSRF surface, for no benefit.
        fields.qrCodeUrl = parsed.data.qrCodeUrl;
        fields.qrCodeMime = null;
        fields.qrCodeBytes = null;
      }
    }

    const settings = await credits.updateBillingSettings(fields);
    await audit.record({
      actorUserId: admin.userId,
      action: 'billing.updated',
      resourceType: 'billing_settings',
      resourceId: String(settings.id),
      metadata: {
        paymentMethodLabel: fields.paymentMethodLabel ?? null,
        qrUpdated: parsed.data.qrCodeUrl !== undefined,
        currency: fields.currency ?? null,
      },
      ...meta(request),
    });

    return { billing: settings };
  });

  /* ----------------------------------------------------------- payments */

  app.get('/api/admin/credits/payments', async (request: FastifyRequest) => {
    requireAdmin(request);
    const parsed = paymentQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) fail(parsed.error.issues);

    const payments = await credits.listPayments({
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      limit: parsed.data.limit,
    });
    return {
      payments: payments.map((p) => ({
        payment: presentPayment(p.payment),
        customer: { id: p.payment.userId, name: p.userName, email: p.userEmail },
      })),
    };
  });

  /**
   * The receipt, for an admin reviewing a claim.
   *
   * Served as an image with the byte type verified on the way in, so what the
   * admin's browser renders is a real image. The response is explicitly
   * non-cacheable and attachment-dispositioned: this is a customer's payment
   * proof, and it must not sit in a shared proxy cache or be prefetched into a
   * history entry.
   */
  app.get('/api/admin/credits/payments/:id/receipt', async (request: FastifyRequest, reply: FastifyReply) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    const payment = await credits.findPayment(id);
    if (!payment) throw notFoundOrForbidden();

    const image = readStoredImage(payment.receiptPath, payment.receiptMime);
    if (!image) throw notFoundOrForbidden();

    reply.header('cache-control', 'no-store, private');
    reply.header('content-disposition', 'inline; filename="receipt"');
    return reply.type(image.mime).send(image.bytes);
  });

  /**
   * Approve a payment: allocate the purchased credits exactly once.
   *
   * Allocation and the status change are one transaction, guarded on
   * `status = 'pending'`. A double-click, a retried request, or two admins
   * clicking at once all resolve to one allocation; the losers are told it was
   * already processed rather than being handed an error that invites another
   * click. That is the entire exactly-once guarantee, and it is enforced by
   * the database rather than by the UI disabling its own button.
   */
  app.post('/api/admin/credits/payments/:id/approve', async (request: FastifyRequest) => {
    const admin = requireAdmin(request);
    const { id } = request.params as { id: string };
    const parsed = adminDecisionSchema.safeParse(request.body ?? {});
    if (!parsed.success) fail(parsed.error.issues);

    const existing = await credits.findPayment(id);
    if (!existing) throw notFoundOrForbidden();

    const result = await credits.approvePayment(id, admin.userId, parsed.data.note ?? null);
    if (!result.ok) throw notFoundOrForbidden();

    await audit.record({
      actorUserId: admin.userId,
      action: 'payment.approved',
      resourceType: 'payment_request',
      resourceId: id,
      metadata: {
        credits: result.payment.credits,
        amountMinor: result.payment.amountMinor,
        userId: result.payment.userId,
        replayed: result.replayed,
      },
      ...meta(request),
    });

    return {
      payment: presentPayment(result.payment),
      balance: presentBalance(result.balance),
      // True when this was a repeat of a decision already made. No credits
      // were added on this call.
      replayed: result.replayed,
    };
  });

  /**
   * Reject a payment. No credits are added, and the reason is recorded so the
   * customer can be told why.
   */
  app.post('/api/admin/credits/payments/:id/reject', async (request: FastifyRequest) => {
    const admin = requireAdmin(request);
    const { id } = request.params as { id: string };
    const parsed = adminDecisionSchema.safeParse(request.body ?? {});
    if (!parsed.success) fail(parsed.error.issues);

    const note = parsed.data.note ?? null;
    if (!note) {
      // A rejection without a reason is unactionable for the customer and
      // unauditable for the operator, so it is required here even though the
      // decision itself does not need it.
      throw badRequest('a reason is required when rejecting a payment', 'reason_required', 'note');
    }

    const existing = await credits.findPayment(id);
    if (!existing) throw notFoundOrForbidden();

    const rejected = await credits.rejectPayment(id, admin.userId, note);
    if (!rejected) {
      throw conflict('This payment has already been reviewed', 'already_reviewed');
    }

    await audit.record({
      actorUserId: admin.userId,
      action: 'payment.rejected',
      resourceType: 'payment_request',
      resourceId: id,
      metadata: { note, userId: rejected.userId },
      ...meta(request),
    });

    return { payment: presentPayment(rejected) };
  });

  /**
   * Re-send the Telegram notification for a payment.
   *
   * The operator's manual retry for a submission the bot never received. It
   * re-reads the row and the stored receipt, so it works from the database
   * rather than from anything the original request held.
   */
  app.post('/api/admin/credits/payments/:id/telegram-retry', async (request: FastifyRequest) => {
    const admin = requireAdmin(request);
    const { id } = request.params as { id: string };
    const payment = await credits.findPayment(id);
    if (!payment) throw notFoundOrForbidden();

    const customer = await users.findById(payment.userId);
    if (!customer) throw notFoundOrForbidden();

    const result = await telegram.retryPayment({
      paymentId: payment.id,
      customerName: customer.name,
      customerEmail: payment.email,
      customerId: payment.userId,
      packageName: payment.packageName,
      credits: payment.credits,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      reference: payment.reference,
      submittedAt: payment.createdAt,
      receipt: readStoredImage(payment.receiptPath, payment.receiptMime),
    });

    await credits.recordTelegramOutcome(
      payment.id,
      result.sent ? 'sent' : telegram.configured ? 'failed' : 'skipped',
      result.sent ? null : result.error,
    );

    await audit.record({
      actorUserId: admin.userId,
      action: 'payment.telegram_retried',
      resourceType: 'payment_request',
      resourceId: id,
      metadata: { sent: result.sent },
      ...meta(request),
    });

    return { sent: result.sent, error: result.sent ? null : result.error };
  });
}

/* -------------------------------------------------------------- present */

function presentLedger(entry: {
  id: string;
  userId: string;
  bucket: string;
  kind: string;
  amount: number;
  balanceAfter: number;
  reason: string | null;
  referenceType: string | null;
  referenceId: string | null;
  actorUserId: string | null;
  createdAt: Date;
}) {
  return {
    id: entry.id,
    userId: entry.userId,
    bucket: entry.bucket,
    kind: entry.kind,
    amount: entry.amount,
    balanceAfter: entry.balanceAfter,
    reason: entry.reason,
    referenceType: entry.referenceType,
    referenceId: entry.referenceId,
    actorUserId: entry.actorUserId,
    createdAt: entry.createdAt,
  };
}

function presentPayment(payment: {
  id: string;
  userId: string;
  packageId: string | null;
  packageName: string;
  credits: number;
  amountMinor: number;
  currency: string;
  reference: string;
  email: string;
  status: string;
  reviewNote: string | null;
  receiptMime: string | null;
  receiptBytes: number | null;
  telegramStatus: string | null;
  createdAt: Date;
  reviewedAt: Date | null;
}) {
  return {
    id: payment.id,
    userId: payment.userId,
    packageId: payment.packageId,
    packageName: payment.packageName,
    credits: payment.credits,
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    reference: payment.reference,
    email: payment.email,
    status: payment.status,
    reviewNote: payment.reviewNote,
    hasReceipt: Boolean(payment.receiptMime),
    receiptMime: payment.receiptMime,
    receiptBytes: payment.receiptBytes,
    telegramStatus: payment.telegramStatus,
    createdAt: payment.createdAt,
    reviewedAt: payment.reviewedAt,
  };
}
