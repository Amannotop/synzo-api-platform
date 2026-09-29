import { z } from 'zod';

/**
 * Validation for the credit, payment and billing surface.
 *
 * One rule runs through all of it: the client's word is never taken for a
 * value that money depends on. A customer names a PACKAGE and a transaction
 * reference; the server looks up the package and reads the price and the
 * credit amount from the database. There is deliberately no schema anywhere
 * that lets a client submit "credits: 100000000" or "amount: 1" and have it
 * believed.
 */

/* ------------------------------------------------------------- packages */

export const createPackageSchema = z
  .object({
    name: z.string().trim().min(1, 'name is required').max(80),
    description: z.string().trim().max(1000).nullable().optional(),
    credits: z.coerce.number().int().min(1, 'credits must be at least 1').max(1_000_000_000_000),
    /** Minor units, so money stays integral. 89900 = ₹899.00. */
    priceMinor: z.coerce.number().int().min(1, 'price must be at least 1').max(1_000_000_000),
    currency: z.string().trim().min(1).max(8).toUpperCase().default('INR'),
    sortOrder: z.coerce.number().int().min(-10_000).max(10_000).default(0),
    active: z.boolean().default(true),
  })
  .strict();

export const updatePackageSchema = createPackageSchema.partial().refine(
  (v) => Object.values(v).some((x) => x !== undefined),
  { message: 'at least one field must be provided' },
);

/* -------------------------------------------------------------- payments */

/**
 * Payment submission.
 *
 * `packageId` identifies what was bought; it is NOT a claim about the price or
 * the credit count. `confirmedEmail` is the anti-typo check the spec asks for:
 * the customer retypes the address on the account, and the server compares it
 * against the session's own address rather than trusting the submitted one.
 * Requiring the session's identity as well is what stops someone from paying
 * against an address they do not own.
 *
 * The receipt is a data URL rather than a multipart upload. It keeps the
 * endpoint JSON-only, which means the existing body-size limit and content-type
 * checks apply unchanged, and it avoids writing customer-uploaded bytes to a
 * path on disk. The size is validated again server-side against config, so a
 * client cannot lie about the length of its own data URL.
 */
export const submitPaymentSchema = z
  .object({
    packageId: z.string().uuid('packageId must be a valid id'),
    reference: z
      .string()
      .trim()
      .min(4, 'a transaction reference is required')
      .max(160)
      // A reference is pasted from a payment app, so control characters and
      // angle brackets are the realistic abuse here: they end up in a Telegram
      // message and an admin table cell.
      .regex(/^[\w\-.:/ ]+$/, 'reference contains unsupported characters'),
    confirmedEmail: z.string().trim().toLowerCase().pipe(z.string().email()),
    receiptDataUrl: z.string().max(8_000_000).optional(),
  })
  .strict();

/* -------------------------------------------------------- credit adjust */

export const adjustCreditsSchema = z
  .object({
    bucket: z.enum(['free', 'paid']),
    direction: z.enum(['add', 'deduct']),
    amount: z.coerce.number().int().min(1, 'amount must be at least 1').max(1_000_000_000_000),
    /**
     * Required for every manual adjustment. This is the difference between an
     * auditable ledger and a number that changed for no recorded reason.
     */
    reason: z.string().trim().min(3, 'a reason is required').max(500),
  })
  .strict();

/* ------------------------------------------------------ admin decisions */

export const adminDecisionSchema = z
  .object({
    note: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();

export const adminStatusSchema = z
  .object({
    status: z.enum(['active', 'suspended', 'pending', 'rejected']),
  })
  .strict();

/* ----------------------------------------------------- billing settings */

/**
 * Billing configuration.
 *
 * The QR may be a data URL (an upload) or an https URL (an already-hosted
 * image). http is rejected for the URL form: a payment QR served over plain
 * http can be swapped in transit, and a customer who scans the wrong one pays
 * the wrong person. The admin is editing their own payment destination, so
 * this is a genuine security boundary rather than a formality.
 */
const qrValue = z
  .string()
  .trim()
  .max(4_000_000)
  .refine(
    (v) =>
      v === '' ||
      v.startsWith('data:image/') ||
      v.startsWith('https://'),
    'QR must be an https URL or a data URL',
  );

export const billingSettingsSchema = z
  .object({
    paymentInstructions: z.string().trim().max(4000).nullable().optional(),
    /**
     * Either an https URL for an already-hosted image, or a data URL carrying
     * an upload. Both are re-verified server-side: a data URL is decoded and
     * its magic bytes checked, and an https URL is the only URL scheme
     * accepted, because a payment QR fetched over plain http can be swapped in
     * transit and the customer would scan the wrong destination.
     */
    qrCodeUrl: qrValue.nullable().optional(),
    paymentMethodLabel: z.string().trim().max(120).nullable().optional(),
    currency: z.string().trim().min(1).max(8).toUpperCase().optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'at least one field must be provided',
  });

/* ------------------------------------------------------------- queries */

export const paymentQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const ledgerQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export type CreatePackageInput = z.infer<typeof createPackageSchema>;
export type UpdatePackageInput = z.infer<typeof updatePackageSchema>;
export type SubmitPaymentInput = z.infer<typeof submitPaymentSchema>;
export type AdjustCreditsInput = z.infer<typeof adjustCreditsSchema>;
export type BillingSettingsInput = z.infer<typeof billingSettingsSchema>;
