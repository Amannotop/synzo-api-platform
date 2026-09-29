import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ledgerQuerySchema, submitPaymentSchema } from '@synzo/validation';
import type { AppConfig } from '@synzo/config';
import { badRequest, conflict, notFoundOrForbidden } from '../lib/errors.js';
import { decodeImageDataUrl } from '../lib/upload.js';
import { requireActiveAccount, requireSession } from '../middleware/session-auth.js';
import { presentBalance, type CreditRepository } from '../repositories/credit.repository.js';
import type { TelegramService } from '../services/telegram.service.js';
import type { UserRepository } from '../repositories/user.repository.js';
import type { AuditRepository } from '../repositories/audit.repository.js';
import { originContext, resolvePublicOrigin } from '../lib/public-origin.js';
import { parseAllowedModels } from '../lib/allowed-models.js';

interface CreditRouteDeps {
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
 * How the customer-facing half of the credit system is exposed.
 *
 * Three properties hold across every route here:
 *
 *  - The server decides the numbers. A customer names a package; the price and
 *    the credit count come from the database. There is no field anywhere in
 *    these schemas that would let a client state how many credits it wants.
 *
 *  - Nothing is granted on submission. A payment request is a CLAIM that a
 *    human verifies. Approval — and only approval — allocates credits, in the
 *    admin surface, in one transaction.
 *
 *  - A pending or rejected customer can reach all of it. They have to: the
 *    status has to be visible in their dashboard and the paywall has to be
 *    reachable, which is the only way a blocked applicant learns what to do
 *    next. The gate that actually matters is the API-key path.
 */
export async function registerCreditRoutes(app: FastifyInstance, deps: CreditRouteDeps): Promise<void> {
  const { config, credits, telegram, users, audit } = deps;

  /* ---------------------------------------------------------- balances */

  /**
   * Everything the customer dashboard needs to render the credits surface:
   * their approval state, whether that state permits API use, and both pools.
   *
   * Returned as one document because the dashboard shows them together and
   * three round trips would let the three panels disagree with each other —
   * a balance rendered beside a status that has since changed reads as a bug
   * to the customer even when both numbers were correct individually.
   */
  app.get('/api/credits', async (request: FastifyRequest) => {
    const user = requireSession(request);
    const [balance, packages, settings, payments] = await Promise.all([
      credits.getBalances(user.userId),
      credits.listPackages(false),
      credits.getBillingSettings(),
      credits.listPaymentsForUser(user.userId, 20),
    ]);

    return {
      account: {
        id: user.userId,
        name: user.name,
        email: user.email,
        status: user.status,
        role: user.role,
        /**
         * Whether this account can currently make API calls, and why not if
         * it cannot. The dashboard needs the REASON, not just the boolean: an
         * unapproved account and an exhausted one need different calls to
         * action, and showing a paywall to somebody who has not been approved
         * yet is worse than showing them nothing.
         */
        apiAccess: {
          allowed: user.status === 'active' && balance.freeRemaining - balance.freeReserved +
            (balance.paidRemaining - balance.paidReserved) > 0,
          reason:
            user.status !== 'active'
              ? (user.status === 'pending'
                  ? 'awaiting_approval'
                  : user.status === 'rejected'
                    ? 'account_rejected'
                    : 'account_suspended')
              : balance.freeRemaining - balance.freeReserved +
                    (balance.paidRemaining - balance.paidReserved) > 0
                ? null
                : 'credits_exhausted',
        },
      },
      balance: presentBalance(balance),
      packages: packages.map(presentPackage),
      billing: presentBilling(settings),
      payments: payments.map(presentPayment),
    };
  });

  /* ------------------------------------------------------------ ledger */

  app.get('/api/credits/ledger', async (request: FastifyRequest) => {
    const user = requireSession(request);
    const parsed = ledgerQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) fail(parsed.error.issues);
    const entries = await credits.listLedger(user.userId, parsed.data.limit);
    return {
      entries: entries.map((e) => ({
        id: e.id,
        bucket: e.bucket,
        kind: e.kind,
        amount: e.amount,
        balanceAfter: e.balanceAfter,
        reason: e.reason,
        referenceType: e.referenceType,
        referenceId: e.referenceId,
        actorUserId: e.actorUserId,
        createdAt: e.createdAt,
      })),
    };
  });

  /* ---------------------------------------------------------- payments */

  /**
   * The billing detail the paywall needs: the QR code, what it pays, and the
   * instructions.
   *
   * The QR may be absent (the operator has not uploaded one). That is a
   * legitimate state and it is reported as such rather than as an error, so
   * the dashboard can say "payments are not configured yet" instead of failing
   * to render a page the customer needs.
   */
  app.get('/api/credits/billing', async (request: FastifyRequest) => {
    requireSession(request);
    const [settings, packages] = await Promise.all([
      credits.getBillingSettings(),
      credits.listPackages(false),
    ]);
    return { billing: presentBilling(settings), packages: packages.map(presentPackage) };
  });

  /**
   * Submits a payment claim.
   *
   * Three things are checked before a row is written, and the order matters:
   *
   *  1. The confirmed email must equal the address on the ACCOUNT, compared
   *     against the session's own email rather than anything the client sent.
   *     The customer retyping their address is the anti-typo check; the
   *     session is what makes it an identity check. An email alone proves
   *     nothing — anyone can type anyone else's.
   *
   *  2. The package is looked up server-side. Its price and credit count are
   *     copied from the row, so a client that alters them changes nothing.
   *
   *  3. The reference is unique per customer, so a double-submitted form is
   *     rejected as a conflict rather than creating a second claim the admin
   *     would have to reconcile by hand.
   *
   * Nothing here grants anything. The response says PENDING and means it.
   */
  app.post('/api/credits/payments', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireActiveAccount(request);
    const parsed = submitPaymentSchema.safeParse(request.body);
    if (!parsed.success) fail(parsed.error.issues);

    // The account's own address, not the submitted one. See (1) above.
    const account = await users.findById(user.userId);
    if (!account) throw notFoundOrForbidden();
    if (account.email.toLowerCase() !== parsed.data.confirmedEmail) {
      throw badRequest(
        'The confirmed email does not match the email on your account',
        'email_mismatch',
        'confirmedEmail',
      );
    }

    const pkg = await credits.findPackage(parsed.data.packageId);
    if (!pkg || !pkg.active) throw notFoundOrForbidden();

    let receipt: { dataUrl: string; mime: string; bytes: number } | null = null;
    if (parsed.data.receiptDataUrl) {
      const decoded = decodeImageDataUrl(
        parsed.data.receiptDataUrl,
        config.credits.maxPaymentUploadBytes,
        'receiptDataUrl',
      );
      receipt = { dataUrl: decoded.dataUrl, mime: decoded.mime, bytes: decoded.bytes.byteLength };
    }

    const created = await credits.createPayment({
      userId: user.userId,
      packageId: pkg.id,
      packageName: pkg.name,
      // Price and credits are the SERVER's values, copied from the package at
      // the moment of submission. See (2) above.
      credits: pkg.credits,
      amountMinor: pkg.priceMinor,
      currency: pkg.currency,
      reference: parsed.data.reference,
      email: account.email,
      receiptDataUrl: receipt?.dataUrl ?? null,
      receiptMime: receipt?.mime ?? null,
      receiptBytes: receipt?.bytes ?? null,
    });

    if (!created.ok) {
      // The only conflict here is the duplicate reference, which is the
      // duplicate-submission guard doing its job.
      throw conflict('A payment with this reference has already been submitted', 'duplicate_reference');
    }

    const payment = created.payment;

    await audit.record({
      actorUserId: user.userId,
      action: 'payment.submitted',
      resourceType: 'payment_request',
      resourceId: payment.id,
      metadata: { packageId: pkg.id, reference: payment.reference, amountMinor: payment.amountMinor },
      ...meta(request),
    });

    /**
     * Telegram is notified AFTER the row is committed, and its outcome is
     * recorded rather than thrown.
     *
     * The ordering is the point: a Telegram outage must not lose the payment.
     * If the notification were sent first and failed, the customer's claim
     * would be lost with it. Recording the outcome on the row also means the
     * admin can see that a notification failed and retry it, instead of
     * silently never learning the payment exists.
     */
    const origin = resolvePublicOrigin(request, originContext(config), config.publicBaseUrl ?? '').origin;
    const notice = await telegram.notifyPayment({
      paymentId: payment.id,
      customerName: account.name,
      customerEmail: account.email,
      customerId: user.userId,
      packageName: pkg.name,
      credits: pkg.credits,
      amountMinor: pkg.priceMinor,
      currency: pkg.currency,
      reference: parsed.data.reference,
      submittedAt: payment.createdAt,
      adminUrl: origin ? `${origin}/admin/payments/${payment.id}` : null,
      receipt: receipt ? { bytes: Buffer.from(receipt.dataUrl.split(',')[1] ?? '', 'base64'), mime: receipt.mime } : null,
    });
    await credits.recordTelegramOutcome(
      payment.id,
      notice.sent ? 'sent' : telegram.configured ? 'failed' : 'skipped',
      notice.sent ? null : notice.error,
    );

    return reply.status(201).send({
      // 201 with an explicitly PENDING status. The customer is told their claim
      // was recorded AND that no credits have been added yet, because those
      // are different facts and conflating them is how a customer ends up
      // believing they have paid for access they do not have.
      payment: { ...presentPayment(payment), status: 'pending' as const },
      message: 'Payment request submitted. An administrator will verify it before credits are added.',
    });
  });

  app.get('/api/credits/payments', async (request: FastifyRequest) => {
    const user = requireSession(request);
    const payments = await credits.listPaymentsForUser(user.userId, 50);
    return { payments: payments.map(presentPayment) };
  });
}

/* -------------------------------------------------------------- present */

function presentPackage(pkg: {
  id: string;
  name: string;
  description: string | null;
  credits: number;
  allowedModels: string | null;
  imageLimit: number | null;
  durationDays: number | null;
  priceMinor: number;
  currency: string;
  sortOrder: number;
  active: boolean;
}) {
  return {
    id: pkg.id,
    name: pkg.name,
    description: pkg.description,
    // Still exposed, but it is the abuse guard rather than the headline. The
    // dashboard shows model access and treats this as the ceiling behind it.
    credits: pkg.credits,
    /**
     * Sent as a real array, or null for every model, so the dashboard never has
     * to parse a JSON string to decide what to show. The column is still a JSON
     * string, and `parseAllowedModels` is what turns it into this.
     */
    allowedModels: parseAllowedModels(pkg.allowedModels),
    /** 0 = none, a number = that many per request, null = no plan-level cap. */
    imageLimit: pkg.imageLimit,
    /** Term in days. null means the purchase does not expire. */
    durationDays: pkg.durationDays,
    priceMinor: pkg.priceMinor,
    currency: pkg.currency,
    sortOrder: pkg.sortOrder,
    active: pkg.active,
  };
}

function presentPayment(payment: {
  id: string;
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
  createdAt: Date;
  reviewedAt: Date | null;
  telegramStatus: string | null;
}) {
  return {
    id: payment.id,
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
    createdAt: payment.createdAt,
    reviewedAt: payment.reviewedAt,
    telegramStatus: payment.telegramStatus,
  };
}

/**
 * Billing settings as the customer sees them.
 *
 * The QR code is returned as a data URL when one was uploaded, so the paywall
 * renders it without a second authenticated fetch that a customer might block
 * or that a caching proxy might share between users.
 */
function presentBilling(settings: {
  paymentInstructions: string | null;
  qrCodeUrl: string | null;
  paymentMethodLabel: string | null;
  currency: string;
} | null) {
  if (!settings) {
    return {
      configured: false,
      paymentInstructions: null,
      qrCodeUrl: null,
      paymentMethodLabel: null,
      currency: 'INR',
    };
  }
  return {
    configured: Boolean(settings.qrCodeUrl),
    paymentInstructions: settings.paymentInstructions,
    qrCodeUrl: settings.qrCodeUrl,
    paymentMethodLabel: settings.paymentMethodLabel,
    currency: settings.currency,
  };
}
