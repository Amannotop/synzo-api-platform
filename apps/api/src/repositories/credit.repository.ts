import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { AppConfig } from '@synzo/config';
import type { Database } from '@synzo/database';
import {
  billingSettings,
  creditBalances,
  creditLedger,
  creditPackages,
  creditReservations,
  customerLimits,
  paymentRequests,
  users,
  type CreditBalance,
  type CreditLedgerEntry,
  type CreditPackage,
  type PaymentRequest,
} from '@synzo/database';

/** Whole days from `from`, as a timestamp. */
function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

import { unionAllowedModels } from '../lib/allowed-models.js';

/** The transaction handle Drizzle hands to a `db.transaction` callback. */
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Why a credit operation failed in a way the caller must distinguish.
 *
 * The distinctions are load-bearing, not cosmetic. `already_granted` lets an
 * approval succeed idempotently instead of erroring, and `insufficient` is the
 * one case that has to surface to the customer as a paywall rather than a 500.
 */
export type CreditFailure =
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'already_granted' }
  | { ok: false; reason: 'insufficient'; freeRemaining: number; paidRemaining: number }
  | { ok: false; reason: 'conflict' };

export type GrantResult =
  | { ok: true; entry: CreditLedgerEntry; balance: CreditBalance; replayed: boolean }
  | CreditFailure;

export interface GrantInput {
  userId: string;
  bucket: 'free' | 'paid';
  kind: 'free_trial_grant' | 'admin_grant' | 'payment_credit' | 'reversal';
  amount: number;
  reason: string;
  actorUserId: string | null;
  referenceType?: string;
  referenceId?: string;
  /**
   * When set, the whole grant is a no-op if a ledger row with this key already
   * exists. This is what makes a retried payment approval safe: the retry
   * finds the key, returns the existing entry, and allocates nothing.
   */
  idempotencyKey?: string;
}

/** What a reservation actually held, per bucket. */
export interface Reservation {
  requestId: string;
  userId: string;
  freeAmount: number;
  paidAmount: number;
  reservedTotal: number;
}

export type ReserveResult =
  | { ok: true; reservation: Reservation; balance: CreditBalance }
  | { ok: false; reason: 'insufficient'; freeRemaining: number; paidRemaining: number }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'conflict' };

export type SettleResult =
  | {
      ok: true;
      /** True when this call did the settling; false when it was already done. */
      settled: boolean;
      /** Tokens actually converted from reservation into usage. */
      charged: number;
      /** Tokens handed back because the request used less than it reserved. */
      released: number;
      bucket: 'free' | 'paid' | null;
      freeRemaining: number;
      paidRemaining: number;
    }
  | CreditFailure;

/** The two pools a customer holds, as the customer sees them. */
export interface BalanceView {
  freeGranted: number;
  freeUsed: number;
  freeRemaining: number;
  /** Free tokens held by requests currently in flight. */
  freeReserved: number;
  paidGranted: number;
  paidUsed: number;
  paidRemaining: number;
  paidReserved: number;
  /** What the customer can actually spend right now. */
  totalRemaining: number;
  freeTrialGrantedAt: Date | null;
  hasFreeTrial: boolean;
}

const ZERO_BALANCE: Omit<CreditBalance, 'userId' | 'createdAt' | 'updatedAt'> = {
  freeGranted: 0,
  freeUsed: 0,
  freeRemaining: 0,
  freeReserved: 0,
  paidGranted: 0,
  paidUsed: 0,
  paidRemaining: 0,
  paidReserved: 0,
  freeTrialGrantedAt: null,
};

/** Projects a stored row into the shape the dashboard renders. */
export function presentBalance(row: CreditBalance): BalanceView {
  return {
    freeGranted: row.freeGranted,
    freeUsed: row.freeUsed,
    freeRemaining: row.freeRemaining,
    freeReserved: row.freeReserved,
    paidGranted: row.paidGranted,
    paidUsed: row.paidUsed,
    paidRemaining: row.paidRemaining,
    paidReserved: row.paidReserved,
    totalRemaining: row.freeRemaining - row.freeReserved + (row.paidRemaining - row.paidReserved),
    freeTrialGrantedAt: row.freeTrialGrantedAt,
    hasFreeTrial: row.freeTrialGrantedAt !== null,
  };
}

/**
 * All credit accounting lives here.
 *
 * The invariants this class exists to hold:
 *
 *  - Free and paid balances are separate, and a grant to one never touches
 *    the other.
 *  - The free trial happens at most once per customer, enforced by a partial
 *    unique index rather than by a check-then-insert (see migration 0004 for
 *    why that distinction is the whole guarantee).
 *  - Concurrent requests cannot overspend. A request CLAIMS its worst-case
 *    cost before the upstream is called, and the claim is a conditional UPDATE
 *    guarded by the balance columns themselves, so the database — not the
 *    application — decides the winner.
 *  - Every movement writes a ledger row in the same transaction as the balance
 *    change, so the two can never disagree.
 */
export class CreditRepository {
  /**
   * `config` is needed for one thing: which package a trial grants model
   * access to. Kept as a required second argument rather than reaching for a
   * module-level singleton, so a test harness can point it at a different
   * policy without patching the module.
   */
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {}

  /* ------------------------------------------------------------- balances */

  /**
   * What a newly approved account is entitled to, or null to apply nothing.
   *
   * `allowedModels` is the JSON-array string, where null means every model.
   * That matters for the unrestricted case: a fresh account's row starts as an
   * empty array ("granted nothing"), so an unrestricted trial has to actively
   * write null rather than skip, or the customer would be left with no models
   * at all — the opposite of unrestricted.
   */
  private async entryPlan(
    tx: Tx,
  ): Promise<{ allowedModels: string | null; maxImages: number | null } | null> {
    const configured = this.config.credits.entryPackage;

    // FREE_TRIAL_PACKAGE=none: no model restriction, and no image support
    // either, because image support is only ever sold in a package.
    if (configured === false) return { allowedModels: null, maxImages: 0 };

    const pkg = await this.findEntryPackage(tx, configured);
    // No package is active or named: leave the account's own state alone. With
    // no tiers configured there is nothing to grant, and inventing an allowlist
    // from nothing would lock a customer out of models they could previously
    // call.
    if (!pkg) return null;

    return { allowedModels: pkg.allowedModels, maxImages: pkg.imageLimit };
  }

  private async findEntryPackage(
    tx: Tx,
    configured: string | null,
  ): Promise<CreditPackage | undefined> {
    const rows = await tx
      .select()
      .from(creditPackages)
      .where(
        configured === null
          ? eq(creditPackages.active, true)
          : and(eq(creditPackages.active, true), eq(creditPackages.name, configured)),
      )
      .orderBy(asc(creditPackages.priceMinor))
      .limit(1);
    return rows[0];
  }

  /**
   * Writes a granted entitlement onto the customer's limits row, as a union
   * with what they already have.
   *
   * An UPDATE, not an upsert, and the reason is that the row always exists:
   * `UserRepository.createUser` inserts it in the same transaction as the
   * account. An upsert here would have to invent the other four limit columns
   * from config to fill a row that cannot be missing, and would silently
   * overwrite an operator's hand-tuned rate limits if it ever were. A missing
   * row is therefore treated as "nothing to add to" and left alone.
   */
  private async applyPlanAccess(
    tx: Tx,
    userId: string,
    plan: { allowedModels: string | null; maxImages: number | null } | null,
    options: { base?: boolean; expiresAt?: Date | null } = {},
  ): Promise<void> {
    if (!plan) return;

    const current = await tx
      .select({
        allowedModels: customerLimits.allowedModels,
        maxImages: customerLimits.maxImages,
      })
      .from(customerLimits)
      .where(eq(customerLimits.userId, userId))
      .limit(1);
    const existing = current[0];
    if (!existing) return;

    await tx
      .update(customerLimits)
      .set({
        // Union, so buying a cheaper tier later never takes away models that
        // were paid for. See unionAllowedModels for the three-state table.
        allowedModels: unionAllowedModels(existing.allowedModels, plan.allowedModels),
        /**
         * Images combine by taking the LOOSER of the two, which is the mirror of
         * the model union and the same reasoning: a purchase only ever adds.
         *
         * The three states make "looser" mean two different things. null is
         * unlimited, so it absorbs anything. Otherwise the larger number wins.
         * Written as SQL rather than JS because a null in either input has to
         * come back as null, and a plain greatest() would quietly return the
         * other side instead.
         *
         * The casts are load-bearing. A parameter used only in `IS NULL` gives
         * the planner no type to work from, and the statement fails with
         * "could not determine data type of parameter". The same applies to the
         * timestamptz below.
         */
        maxImages: sql`CASE
          WHEN ${customerLimits.maxImages} IS NULL OR ${plan.maxImages}::int IS NULL
            THEN NULL
          ELSE GREATEST(${customerLimits.maxImages}, ${plan.maxImages}::int)
        END`,
        // The base grant is what an expiry reverts to, so it is recorded once,
        // when the trial is granted, and never overwritten by a later purchase.
        ...(options.base
          ? { baseAllowedModels: plan.allowedModels, baseMaxImages: plan.maxImages }
          : {}),
        // A purchase sets the term. Repeated purchases take the later expiry
        // rather than shortening an existing one, so buying twice cannot make a
        // customer's access end sooner than it otherwise would.
        ...(options.expiresAt !== undefined
          ? {
              /**
               * An ISO string, not a Date. A Date reaches a cast parameter as
               * `Mon Oct 05 2026 22:58:20 GMT+0530 (India Standard Time)`, which
               * Postgres rejects with `time zone "gmt+0530" not recognized` —
               * and only off UTC, so it would have passed on a server in London
               * and failed on this one. `toISOString()` is unambiguous wherever
               * the process runs.
               */
              planExpiresAt: sql`GREATEST(
                COALESCE(${customerLimits.planExpiresAt}, '-infinity'::timestamptz),
                ${(options.expiresAt ?? new Date(0)).toISOString()}::timestamptz
              )`,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(customerLimits.userId, userId));
  }

  /**
   * Returns the customer's balances, or a zeroed record when they have never
   * been granted anything. Callers get a usable shape without having to
   * branch on "does this row exist".
   */
  async getBalances(userId: string): Promise<CreditBalance> {
    const rows = await this.db
      .select()
      .from(creditBalances)
      .where(eq(creditBalances.userId, userId))
      .limit(1);
    return rows[0] ?? this.emptyBalance(userId);
  }

  private emptyBalance(userId: string): CreditBalance {
    return { userId, ...ZERO_BALANCE, createdAt: new Date(0), updatedAt: new Date(0) };
  }

  /** Token credits the customer can actually spend right now. */
  async getSpendable(userId: string): Promise<number> {
    const b = await this.getBalances(userId);
    return b.freeRemaining - b.freeReserved + (b.paidRemaining - b.paidReserved);
  }

  /**
   * Creates the zero balance row if it is missing, and returns it.
   *
   * A customer who has never been granted anything still needs a
   * `credit_balances` row for a conditional UPDATE to match, so the row is
   * created on first touch. `ON CONFLICT DO NOTHING` makes this safe under
   * concurrency: two racing requests both try to create it, one wins, and the
   * other proceeds against the row that now exists.
   */
  private async ensureBalance(tx: Tx, userId: string): Promise<CreditBalance | null> {
    const owner = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (owner.length === 0) return null;

    await tx.insert(creditBalances).values({ userId }).onConflictDoNothing();

    const rows = await tx
      .select()
      .from(creditBalances)
      .where(eq(creditBalances.userId, userId))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Same as `ensureBalance` but takes a row lock.
   *
   * Used only where a decision has to be made across BOTH buckets at once —
   * reserving a request whose worst case exceeds the free pool has to take
   * part from free and part from paid, and a read-then-write without this lock
   * lets two concurrent requests both decide they can have the same tokens.
   * A single conditional UPDATE per bucket cannot express that split.
   */
  private async lockBalance(tx: Tx, userId: string): Promise<CreditBalance | null> {
    const created = await this.ensureBalance(tx, userId);
    if (!created) return null;
    const locked = await tx
      .select()
      .from(creditBalances)
      .where(eq(creditBalances.userId, userId))
      .for('update')
      .limit(1);
    return locked[0] ?? null;
  }

  /* -------------------------------------------------------------- grants */

  /**
   * Adds credits to a bucket and records the movement.
   *
   * Runs in a transaction so the balance and its ledger row commit together.
   * A grant that finds an existing `idempotencyKey` returns the original entry
   * untouched — that is the payment-approval path, and it has to be safe to
   * call twice.
   */
  async grant(input: GrantInput): Promise<GrantResult> {
    if (input.amount <= 0) return { ok: false, reason: 'conflict' };

    const free = input.bucket === 'free';
    try {
      return await this.db.transaction(async (tx) => {
        // Replay guard, read inside the transaction. A concurrent retry either
        // sees the row and returns it, or blocks on the insert below and then
        // loses the unique-index race — which rolls back cleanly.
        if (input.idempotencyKey) {
          const existing = await tx
            .select()
            .from(creditLedger)
            .where(eq(creditLedger.idempotencyKey, input.idempotencyKey))
            .limit(1);
          if (existing[0]) {
            const balance = await this.readBalance(tx, input.userId);
            if (balance) return { ok: true as const, entry: existing[0], balance, replayed: true };
          }
        }

        const before = await this.ensureBalance(tx, input.userId);
        if (!before) return { ok: false as const, reason: 'not_found' as const };

        const [updated] = await tx
          .update(creditBalances)
          .set({
            ...(free
              ? {
                  freeGranted: sql`${creditBalances.freeGranted} + ${input.amount}`,
                  freeRemaining: sql`${creditBalances.freeRemaining} + ${input.amount}`,
                }
              : {
                  paidGranted: sql`${creditBalances.paidGranted} + ${input.amount}`,
                  paidRemaining: sql`${creditBalances.paidRemaining} + ${input.amount}`,
                }),
            updatedAt: new Date(),
          })
          .where(eq(creditBalances.userId, input.userId))
          .returning();

        if (!updated) return { ok: false as const, reason: 'not_found' as const };

        // An explicit bucket ternary, not a column comparison: Drizzle column
        // objects are not reference-equal, so `a === b` is always false and
        // the free case silently reported the paid balance.
        const balanceAfter = free ? updated.freeRemaining : updated.paidRemaining;

        const [entry] = await tx
          .insert(creditLedger)
          .values({
            userId: input.userId,
            bucket: input.bucket,
            kind: input.kind,
            amount: input.amount,
            balanceAfter,
            reason: input.reason,
            referenceType: input.referenceType ?? null,
            referenceId: input.referenceId ?? null,
            actorUserId: input.actorUserId,
            idempotencyKey: input.idempotencyKey ?? null,
          })
          .returning();

        return { ok: true as const, entry: entry!, balance: updated, replayed: false };
      });
    } catch (err) {
      // The partial unique index on (user_id) WHERE kind = 'free_trial_grant'
      // is what makes the trial once-only. Its violation is a normal, expected
      // outcome of a retried approval, not a fault, so it becomes a typed
      // failure rather than a 500.
      if (isUniqueViolation(err)) {
        if (input.kind === 'free_trial_grant') return { ok: false, reason: 'already_granted' };
        return { ok: false, reason: 'conflict' };
      }
      throw err;
    }
  }

  /**
   * Grants the one-time free trial, atomically with the account's move to
   * 'active'.
   *
   * These are one transaction on purpose. Doing the status flip and the grant
   * separately means a crash between them leaves a customer who is approved
   * with no credits, or — worse — one who has been credited but is still
   * blocked, with the admin UI showing success for both. The trial's
   * once-only guarantee comes from the partial unique index, so a retried
   * approval simply loses that race and reports the replay.
   *
   * Returns `alreadyTrialed` when this customer has had the trial, which the
   * caller treats as success: an admin re-approving an account should see
   * "approved", not an error, and must not receive a second grant.
   *
   * ----
   *
   * This is the ONLY place a free trial is ever granted. Registration does not
   * grant it, which is the spec's explicit requirement, and it is why
   * `APPROVAL_REQUIRED` has a defined meaning in both directions:
   *
   *  - ON  (the default): a signup is 'pending', and the admin's approval here
   *    is the transition that both approves the account and grants the trial.
   *
   *  - OFF: a signup is already 'active' and so never passes through this
   *    method, which would leave every customer permanently at zero credits and
   *    the API permanently unusable. To make that configuration coherent, an
   *    account that is ALREADY 'active' and has never been trialed is treated
   *    as having activated without approval and is granted the trial here.
   *
   * So the grant follows ACTIVATION, not the admin's click. That keeps the
   * exactly-once guarantee intact in both modes — the partial unique index
   * still admits exactly one `free_trial_grant` row per account, whether the
   * activation came from an approval or from a self-serve signup — while
   * making the "no approval required" mode actually usable.
   */
  async approveAccount(input: {
    userId: string;
    /**
     * The admin who approved, or null when the account activated on its own
     * (APPROVAL_REQUIRED off). The ledger's `actor_user_id` is a nullable
     * uuid: null means "nobody clicked a button", which is the truth for a
     * self-serve signup, and an empty string is simply not a valid uuid.
     */
    adminId: string | null;
    trialTokens: number;
    note?: string | null;
  }): Promise<
    | {
        ok: true;
        alreadyApproved: boolean;
        alreadyTrialed: boolean;
        balance: CreditBalance;
      }
    | CreditFailure
  > {
    try {
      return await this.db.transaction(async (tx) => {
        const target = await tx
          .select({ id: users.id, status: users.status })
          .from(users)
          .where(eq(users.id, input.userId))
          .limit(1);
        if (!target[0]) return { ok: false as const, reason: 'not_found' as const };

        const wasActive = target[0].status === 'active';

        // Guarded on the current status so a concurrent approval cannot both
        // decide they were first. The second writer's WHERE matches nothing
        // and simply proceeds to the grant, which is idempotent anyway.
        await tx
          .update(users)
          .set({ status: 'active', updatedAt: new Date() })
          .where(and(eq(users.id, input.userId), sql`${users.status} <> 'active'`));

        const balance = await this.ensureBalance(tx, input.userId);
        if (!balance) return { ok: false as const, reason: 'not_found' as const };

        if (input.trialTokens <= 0) {
          return { ok: true as const, alreadyApproved: wasActive, alreadyTrialed: balance.freeTrialGrantedAt !== null, balance };
        }

        // Already approved, and already holding credits: a repeat approval.
        // Nothing to do, and in particular nothing to grant.
        if (wasActive && balance.freeRemaining + balance.paidRemaining > 0) {
          return {
            ok: true as const,
            alreadyApproved: true,
            alreadyTrialed: balance.freeTrialGrantedAt !== null,
            balance,
          };
        }

        /**
         * The entry package's model access lands with the trial, in the same
         * transaction as the credit grant. Both are "what this customer is
         * entitled to as of approval", and splitting them across two commits
         * would leave a window where a customer has credits but no model
         * access, or access to every model with nothing to spend.
         */
        await this.applyPlanAccess(tx, input.userId, await this.entryPlan(tx), { base: true });

        // The authoritative once-only check. The index below is what actually
        // enforces it under concurrency; this read only avoids taking the
        // error path in the common case.
        const seen = await tx
          .select({ id: creditLedger.id })
          .from(creditLedger)
          .where(
            and(
              eq(creditLedger.userId, input.userId),
              eq(creditLedger.kind, 'free_trial_grant'),
            ),
          )
          .limit(1);

        if (seen.length > 0) {
          const refreshed = await this.readBalance(tx, input.userId);
          return {
            ok: true as const,
            alreadyApproved: wasActive,
            alreadyTrialed: true,
            balance: refreshed ?? balance,
          };
        }

        const [updated] = await tx
          .update(creditBalances)
          .set({
            freeGranted: sql`${creditBalances.freeGranted} + ${input.trialTokens}`,
            freeRemaining: sql`${creditBalances.freeRemaining} + ${input.trialTokens}`,
            freeTrialGrantedAt: sql`COALESCE(${creditBalances.freeTrialGrantedAt}, now())`,
            updatedAt: new Date(),
          })
          .where(eq(creditBalances.userId, input.userId))
          .returning();

        if (!updated) return { ok: false as const, reason: 'not_found' as const };

        await tx.insert(creditLedger).values({
          userId: input.userId,
          bucket: 'free',
          kind: 'free_trial_grant',
          amount: input.trialTokens,
          balanceAfter: updated.freeRemaining,
          reason: 'One-time free trial on account approval',
          referenceType: 'approval',
          referenceId: input.userId,
          actorUserId: input.adminId,
          // Belt and braces with the partial unique index: even if that index
          // were dropped by a future migration, this key still blocks a
          // second grant for the same account.
          idempotencyKey: `trial:${input.userId}`,
        });

        return { ok: true as const, alreadyApproved: wasActive, alreadyTrialed: false, balance: updated };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Lost the one-time race. The account is still approved (that UPDATE
        // committed in the same transaction... or rolled back with it), so
        // re-read and report the replay rather than an error.
        const balance = await this.getBalances(input.userId);
        return { ok: true, alreadyApproved: true, alreadyTrialed: true, balance };
      }
      throw err;
    }
  }

  /**
   * Moves an account to 'rejected' and blocks API access.
   *
   * Any credits already granted are left alone: rejecting an applicant is a
   * decision about a person who never had access, and clawing back a balance
   * would be a silent, unannounced loss of something the customer can see.
   * An operator who wants the credits back uses the manual deduct, which is
   * recorded with a reason.
   */
  async rejectAccount(userId: string): Promise<boolean> {
    const [updated] = await this.db
      .update(users)
      .set({ status: 'rejected', updatedAt: new Date() })
      .where(and(eq(users.id, userId), sql`${users.status} <> 'rejected'`))
      .returning({ id: users.id });
    return updated !== undefined;
  }

  /* ---------------------------------------------------------- reservations */

  /**
   * Claims up to `amount` tokens before the upstream is called.
   *
   * Free credits are consumed before paid ones. That ordering is a product
   * decision and it is stated rather than implied: the free trial is a
   * promotion, so a customer holding both is served from the free pool until
   * it is empty and their paid credits are untouched. The alternative — burning
   * paid credits first — would mean someone who paid for 5M tokens watched the
   * promotion drain first, which is not what "free trial" means to them.
   *
   * The row is locked for the duration because the split across the two
   * buckets has to be decided in one step. Two per-bucket conditional UPDATEs
   * would each be atomic on their own but could both succeed against the same
   * free tokens, because the second would see the first's write only if it ran
   * after it — and with two pools, the free-first decision is only correct
   * under a lock.
   */
  async reserve(input: {
    requestId: string;
    userId: string;
    amount: number;
  }): Promise<ReserveResult> {
    if (input.amount <= 0) {
      return { ok: false, reason: 'conflict' };
    }

    return this.db.transaction(async (tx) => {
      // A retried reserve for the same request is a no-op that returns the
      // original claim, rather than taking the balance twice.
      const existing = await tx
        .select()
        .from(creditReservations)
        .where(eq(creditReservations.requestId, input.requestId))
        .limit(1);
      if (existing[0]) {
        const balance = await this.readBalance(tx, input.userId);
        return {
          ok: true as const,
          reservation: toReservation(existing[0]),
          balance: balance ?? this.emptyBalance(input.userId),
        };
      }

      const before = await this.lockBalance(tx, input.userId);
      if (!before) return { ok: false as const, reason: 'not_found' as const };

      const freeSpendable = before.freeRemaining - before.freeReserved;
      const paidSpendable = before.paidRemaining - before.paidReserved;
      const freeAmount = Math.min(freeSpendable, input.amount);
      const paidAmount = input.amount - freeAmount;

      if (paidAmount > paidSpendable) {
        // Not enough to cover the worst case. Nothing is claimed: the upstream
        // is never called, so the customer is not billed for a request that
        // was not served. The shortfall is reported so the caller can decide
        // between blocking outright and reserving a smaller amount.
        return {
          ok: false as const,
          reason: 'insufficient' as const,
          freeRemaining: freeSpendable,
          paidRemaining: paidSpendable,
        };
      }

      const [updated] = await tx
        .update(creditBalances)
        .set({
          freeReserved: sql`${creditBalances.freeReserved} + ${freeAmount}`,
          paidReserved: sql`${creditBalances.paidReserved} + ${paidAmount}`,
          updatedAt: new Date(),
        })
        .where(eq(creditBalances.userId, input.userId))
        .returning();

      const [reservation] = await tx
        .insert(creditReservations)
        .values({
          requestId: input.requestId,
          userId: input.userId,
          freeAmount,
          paidAmount,
          reservedTotal: input.amount,
        })
        .returning();

      return {
        ok: true as const,
        reservation: toReservation(reservation!),
        balance: updated ?? before,
      };
    });
  }

  /**
   * Converts a reservation into actual usage, handing back the difference.
   *
   * Called once the provider reports real token counts. The reservation may
   * have been far larger than what was used — that is the point of reserving a
   * worst case — so the unused portion goes back to the pools it came from.
   *
   * The pools are charged free-first again, which is consistent with both the
   * reserve and the deduction policy, and a usage that exceeds the reservation
   * (an upstream miscount, or one that arrived after the connection dropped) is
   * charged only up to what was held. Under-charging a provider miscount is
   * preferable to driving a balance negative through a path that exists to
   * prevent exactly that.
   *
   * Exactly-once: the reservation row is locked and checked for `settledAt`
   * first, so the second call from a double-fired completion path returns the
   * same numbers without deducting again.
   */
  async settle(input: {
    requestId: string;
    userId: string;
    actualTokens: number;
    referenceType?: string;
    referenceId?: string;
  }): Promise<SettleResult> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(creditReservations)
        .where(eq(creditReservations.requestId, input.requestId))
        .for('update')
        .limit(1);

      const row = rows[0];
      if (!row) return { ok: false as const, reason: 'not_found' as const };

      const balance = await this.lockBalance(tx, input.userId);
      if (!balance) return { ok: false as const, reason: 'not_found' as const };

      // Already settled. Report the original outcome so a second caller does
      // not see an error, and does not deduct again.
      if (row.settledAt) {
        return {
          ok: true as const,
          settled: false,
          charged: 0,
          released: 0,
          bucket: null,
          freeRemaining: balance.freeRemaining,
          paidRemaining: balance.paidRemaining,
        };
      }

      const charged = Math.max(0, Math.min(input.actualTokens, row.freeAmount + row.paidAmount));
      let owed = charged;
      const freeCharge = Math.min(owed, row.freeAmount);
      owed -= freeCharge;
      const paidCharge = Math.min(owed, row.paidAmount);

      // Whatever is left of the reservation is returned to the pools it came
      // from, which is what stops a worst-case reservation from silently
      // freezing a customer's credits for the rest of the day. "Returned" here
      // means only "drop the reserved amount back down": a reservation raised
      // `freeReserved`/`paidReserved` without ever lowering
      // `freeRemaining`/`paidRemaining`, so those columns are the only place
      // the release is expressed. Adding the released figure into remaining as
      // well would mint tokens that were never deducted.
      const freeRelease = row.freeAmount - freeCharge;
      const paidRelease = row.paidAmount - paidCharge;

      const [updated] = await tx
        .update(creditBalances)
        .set({
          freeReserved: sql`${creditBalances.freeReserved} - ${row.freeAmount}`,
          paidReserved: sql`${creditBalances.paidReserved} - ${row.paidAmount}`,
          freeRemaining: sql`${creditBalances.freeRemaining} - ${freeCharge}`,
          freeUsed: sql`${creditBalances.freeUsed} + ${freeCharge}`,
          paidRemaining: sql`${creditBalances.paidRemaining} - ${paidCharge}`,
          paidUsed: sql`${creditBalances.paidUsed} + ${paidCharge}`,
          updatedAt: new Date(),
        })
        .where(eq(creditBalances.userId, input.userId))
        .returning();

      await tx
        .update(creditReservations)
        .set({ settledAt: new Date(), outcome: 'settled' })
        .where(eq(creditReservations.id, row.id));

      const after = updated ?? balance;
      if (freeCharge > 0) {
        await this.appendLedger(tx, {
          userId: input.userId,
          bucket: 'free',
          kind: 'usage_deduct',
          amount: -freeCharge,
          balanceAfter: after.freeRemaining,
          referenceType: input.referenceType ?? 'request',
          referenceId: input.referenceId ?? input.requestId,
          actorUserId: null,
        });
      }
      if (paidCharge > 0) {
        await this.appendLedger(tx, {
          userId: input.userId,
          bucket: 'paid',
          kind: 'usage_deduct',
          amount: -paidCharge,
          balanceAfter: after.paidRemaining,
          referenceType: input.referenceType ?? 'request',
          referenceId: input.referenceId ?? input.requestId,
          actorUserId: null,
        });
      }

      return {
        ok: true as const,
        settled: true,
        charged,
        released: freeRelease + paidRelease,
        bucket: freeCharge > 0 ? ('free' as const) : paidCharge > 0 ? ('paid' as const) : null,
        freeRemaining: after.freeRemaining,
        paidRemaining: after.paidRemaining,
      };
    });
  }

  /**
   * Returns a whole reservation without charging anything.
   *
   * Used when a request fails before the provider produced usable output, or
   * when the client disconnects mid-call. Idempotent for the same reason
   * `settle` is: an already-settled reservation is left alone, so a failure
   * path that runs after a success path cannot hand back tokens that were
   * genuinely spent.
   */
  async release(requestId: string, userId: string): Promise<{ released: number }> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(creditReservations)
        .where(eq(creditReservations.requestId, requestId))
        .for('update')
        .limit(1);
      const row = rows[0];
      if (!row || row.settledAt) return { released: 0 };

      const [updated] = await tx
        .update(creditBalances)
        .set({
          freeReserved: sql`${creditBalances.freeReserved} - ${row.freeAmount}`,
          paidReserved: sql`${creditBalances.paidReserved} - ${row.paidAmount}`,
          updatedAt: new Date(),
        })
        .where(eq(creditBalances.userId, userId))
        .returning();

      await tx
        .update(creditReservations)
        .set({ settledAt: new Date(), outcome: 'released' })
        .where(eq(creditReservations.id, row.id));

      return { released: updated ? row.reservedTotal : 0 };
    });
  }

  /**
   * Hands back every reservation a user still holds.
   *
   * The crash-recovery path. A process that dies mid-stream cannot settle its
   * own reservation, and without this the customer's tokens stay frozen until
   * the rows are aged out. Reservations older than `olderThanMs` are the only
   * ones touched: anything in flight could still belong to a live request in
   * another process, and releasing those would let the same tokens be spent
   * twice.
   */
  async releaseStaleReservations(olderThanMs: number): Promise<number> {
    /**
     * The cutoff is computed IN THE DATABASE, not in JavaScript.
     *
     * Interpolating `new Date()` into a Drizzle `sql` fragment binds the Date
     * as a driver parameter, and the `postgres` client only serialises strings,
     * Buffers and typed-array values -- it throws
     * `The "string" argument must be of type string or an instance of Buffer`
     * on a Date. The throw happens on the caller's await, so every sweep died
     * and every crash-orphaned reservation stayed frozen, which is the exact
     * failure this method exists to prevent.
     *
     * `now() - ($1 * interval '1 millisecond')` also removes a second,
     * subtler bug that a JS-side cutoff would keep: clock skew between the API
     * process and Postgres would sweep live reservations whose claim is only
     * milliseconds old, handing back tokens a real request is still spending.
     * One clock, the database's, for both sides of the comparison.
     */
    const cutoffMs = Math.max(0, Math.floor(olderThanMs));
    const stale = await this.db
      .select()
      .from(creditReservations)
      .where(
        and(
          sql`${creditReservations.settledAt} IS NULL`,
          sql`${creditReservations.createdAt} < now() - (${cutoffMs} * interval '1 millisecond')`,
        ),
      )
      .limit(500);
    if (stale.length === 0) return 0;

    let released = 0;
    for (const row of stale) {
      const result = await this.release(row.requestId, row.userId);
      released += result.released;
    }
    return released;
  }

  /* ------------------------------------------------------- manual adjust */

  /**
   * An admin's manual add or deduct, with a required reason.
   *
   * A deduct can never overdraw: it is a conditional UPDATE naming the balance
   * it is spending, so an operator cannot remove credits the customer does not
   * have. The reservation columns are part of the spendable figure, so tokens
   * held by a request in flight are not quietly deducted out from under it.
   */
  async adjust(input: {
    userId: string;
    bucket: 'free' | 'paid';
    direction: 'add' | 'deduct';
    amount: number;
    reason: string;
    adminId: string;
  }): Promise<GrantResult> {
    if (input.amount <= 0) return { ok: false, reason: 'conflict' };

    if (input.direction === 'add') {
      return this.grant({
        userId: input.userId,
        bucket: input.bucket,
        kind: 'admin_grant',
        amount: input.amount,
        reason: input.reason,
        actorUserId: input.adminId,
        referenceType: 'admin_adjustment',
      });
    }

    const free = input.bucket === 'free';
    return this.db.transaction(async (tx) => {
      const before = await this.ensureBalance(tx, input.userId);
      if (!before) return { ok: false as const, reason: 'not_found' as const };

      const [updated] = await tx
        .update(creditBalances)
        .set({
          ...(free
            ? {
                freeRemaining: sql`${creditBalances.freeRemaining} - ${input.amount}`,
                freeUsed: sql`${creditBalances.freeUsed} + ${input.amount}`,
              }
            : {
                paidRemaining: sql`${creditBalances.paidRemaining} - ${input.amount}`,
                paidUsed: sql`${creditBalances.paidUsed} + ${input.amount}`,
              }),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(creditBalances.userId, input.userId),
            free
              ? sql`${creditBalances.freeRemaining} - ${creditBalances.freeReserved} >= ${input.amount}`
              : sql`${creditBalances.paidRemaining} - ${creditBalances.paidReserved} >= ${input.amount}`,
          ),
        )
        .returning();

      if (!updated) {
        return {
          ok: false as const,
          reason: 'insufficient' as const,
          freeRemaining: before.freeRemaining - before.freeReserved,
          paidRemaining: before.paidRemaining - before.paidReserved,
        };
      }

      const [entry] = await tx
        .insert(creditLedger)
        .values({
          userId: input.userId,
          bucket: input.bucket,
          kind: 'admin_deduct',
          amount: -input.amount,
          balanceAfter: free ? updated.freeRemaining : updated.paidRemaining,
          reason: input.reason,
          referenceType: 'admin_adjustment',
          referenceId: input.adminId,
          actorUserId: input.adminId,
        })
        .returning();

      return { ok: true as const, entry: entry!, balance: updated, replayed: false };
    });
  }

  /* ---------------------------------------------------------------- ledger */

  async listLedger(userId: string, limit = 100): Promise<CreditLedgerEntry[]> {
    return this.db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.userId, userId))
      .orderBy(desc(creditLedger.createdAt), desc(creditLedger.id))
      .limit(limit);
  }

  async listLedgerForUsers(userIds: string[], limit = 200): Promise<CreditLedgerEntry[]> {
    if (userIds.length === 0) return [];
    return this.db
      .select()
      .from(creditLedger)
      .where(inArray(creditLedger.userId, userIds))
      .orderBy(desc(creditLedger.createdAt))
      .limit(limit);
  }

  /* -------------------------------------------------------------- packages */

  async listPackages(includeInactive = false): Promise<CreditPackage[]> {
    const base = this.db.select().from(creditPackages);
    const filtered = includeInactive ? base : base.where(eq(creditPackages.active, true));
    return filtered.orderBy(asc(creditPackages.sortOrder), asc(creditPackages.createdAt));
  }

  async findPackage(id: string): Promise<CreditPackage | null> {
    const rows = await this.db.select().from(creditPackages).where(eq(creditPackages.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async createPackage(input: {
    name: string;
    description: string | null;
    credits: number;
    priceMinor: number;
    currency: string;
    sortOrder: number;
    active: boolean;
  }): Promise<CreditPackage> {
    const [created] = await this.db.insert(creditPackages).values(input).returning();
    return created!;
  }

  async updatePackage(
    id: string,
    fields: Partial<{
      name: string;
      description: string | null;
      credits: number;
      priceMinor: number;
      currency: string;
      sortOrder: number;
      active: boolean;
    }>,
  ): Promise<CreditPackage | null> {
    const [updated] = await this.db
      .update(creditPackages)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(creditPackages.id, id))
      .returning();
    return updated ?? null;
  }

  /* -------------------------------------------------------------- payments */

  async createPayment(input: {
    userId: string;
    packageId: string | null;
    packageName: string;
    credits: number;
    amountMinor: number;
    currency: string;
    reference: string;
    email: string;
    receiptDataUrl?: string | null;
    receiptMime?: string | null;
    receiptBytes?: number | null;
  }): Promise<{ ok: true; payment: PaymentRequest } | CreditFailure> {
    try {
      const [payment] = await this.db
        .insert(paymentRequests)
        .values({
          userId: input.userId,
          packageId: input.packageId,
          packageName: input.packageName,
          credits: input.credits,
          amountMinor: input.amountMinor,
          currency: input.currency,
          reference: input.reference,
          email: input.email,
          // The receipt is stored as a data URL rather than a path on disk.
          // A file path would need its own lifecycle — a directory to keep
          // outside the web root, cleanup on deletion, and a traversal-safe
          // reader — and this endpoint is authenticated per-request anyway, so
          // keeping the bytes with the row is strictly simpler and cannot be
          // served by a static handler.
          receiptPath: input.receiptDataUrl ?? null,
          receiptMime: input.receiptMime ?? null,
          receiptBytes: input.receiptBytes ?? null,
        })
        .returning();
      return { ok: true, payment: payment! };
    } catch (err) {
      // The unique index on (user_id, lower(reference)) is the duplicate
      // guard. Its violation is an expected outcome of a resubmitted form.
      if (isUniqueViolation(err)) return { ok: false, reason: 'conflict' };
      throw err;
    }
  }

  async findPayment(id: string): Promise<PaymentRequest | null> {
    const rows = await this.db.select().from(paymentRequests).where(eq(paymentRequests.id, id)).limit(1);
    return rows[0] ?? null;
  }

  /** Joins the customer identity an operator needs to reconcile a payment. */
  async listPayments(filter: { status?: 'pending' | 'approved' | 'rejected'; limit?: number } = {}) {
    const base = this.db
      .select({
        payment: paymentRequests,
        userName: users.name,
        userEmail: users.email,
      })
      .from(paymentRequests)
      .innerJoin(users, eq(users.id, paymentRequests.userId));
    const filtered = filter.status ? base.where(eq(paymentRequests.status, filter.status)) : base;
    return filtered.orderBy(desc(paymentRequests.createdAt)).limit(filter.limit ?? 100);
  }

  async listPaymentsForUser(userId: string, limit = 50): Promise<PaymentRequest[]> {
    return this.db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.userId, userId))
      .orderBy(desc(paymentRequests.createdAt))
      .limit(limit);
  }

  /**
   * Approves a payment and allocates the purchased credits — in ONE
   * transaction.
   *
   * These two writes were the reason this is not two repository calls. Marking
   * the payment approved and then granting the credits leaves a window where a
   * crash, a timeout, or a process restart between them leaves a payment marked
   * approved with no credits allocated. The customer has paid, the admin sees
   * "approved", and the balance never moves. Doing both in one transaction
   * means the only observable outcomes are "pending, no credits" and
   * "approved, credits allocated".
   *
   * Exactly-once, twice over: the status UPDATE is guarded on
   * `status = 'pending'` so only one of N concurrent approvals matches a row,
   * and the ledger insert carries an idempotency key derived from the payment
   * id, so even a caller that somehow got past the status guard cannot
   * allocate a second time.
   *
   * Returns null when the payment was already reviewed — which the admin UI
   * reports as "already processed" rather than as a failure.
   */
  async approvePayment(
    id: string,
    adminId: string,
    note: string | null,
  ): Promise<{ ok: true; payment: PaymentRequest; balance: CreditBalance; replayed: boolean } | CreditFailure> {
    try {
      return await this.db.transaction(async (tx) => {
        const [payment] = await tx
          .update(paymentRequests)
          .set({
            status: 'approved',
            reviewedBy: adminId,
            reviewedAt: new Date(),
            reviewNote: note,
            updatedAt: new Date(),
          })
          .where(and(eq(paymentRequests.id, id), eq(paymentRequests.status, 'pending')))
          .returning();

        if (!payment) {
          const current = await this.readPayment(tx, id);
          if (!current) return { ok: false as const, reason: 'not_found' as const };
          return {
            ok: true as const,
            payment: current,
            balance: (await this.readBalance(tx, current.userId)) ?? this.emptyBalance(current.userId),
            replayed: true,
          };
        }

        const balance = await this.ensureBalance(tx, payment.userId);
        if (!balance) return { ok: false as const, reason: 'not_found' as const };

        /**
         * The purchased package's model access, in the same transaction as the
         * credits it paid for. `packageId` is nullable and the FK is ON DELETE
         * SET NULL, so a package deleted after the customer paid leaves this a
         * no-op rather than revoking what they bought.
         */
        if (payment.packageId) {
          const [pkg] = await tx
            .select()
            .from(creditPackages)
            .where(eq(creditPackages.id, payment.packageId))
            .limit(1);
          /**
           * The term runs from the moment the payment is approved, not from
           * when it was submitted. A claim an operator sat on for three days has
           * already paid for three days of the time the customer was waiting.
           */
          const expiresAt = pkg?.durationDays ? addDays(new Date(), pkg.durationDays) : null;
          await this.applyPlanAccess(
            tx,
            payment.userId,
            pkg ? { allowedModels: pkg.allowedModels, maxImages: pkg.imageLimit } : null,
            { expiresAt },
          );
        }

        const [updated] = await tx
          .update(creditBalances)
          .set({
            paidGranted: sql`${creditBalances.paidGranted} + ${payment.credits}`,
            paidRemaining: sql`${creditBalances.paidRemaining} + ${payment.credits}`,
            updatedAt: new Date(),
          })
          .where(eq(creditBalances.userId, payment.userId))
          .returning();

        await tx.insert(creditLedger).values({
          userId: payment.userId,
          bucket: 'paid',
          kind: 'payment_credit',
          amount: payment.credits,
          balanceAfter: updated?.paidRemaining ?? balance.paidRemaining,
          reason: `Payment approved: ${payment.packageName}`,
          referenceType: 'payment_request',
          referenceId: payment.id,
          actorUserId: adminId,
          idempotencyKey: `payment:${payment.id}`,
        });

        return { ok: true as const, payment, balance: updated ?? balance, replayed: false };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // The idempotency key already exists, so the credits are already
        // allocated. Report the replay rather than allocating again.
        const payment = await this.findPayment(id);
        if (!payment) return { ok: false, reason: 'not_found' };
        return {
          ok: true,
          payment,
          balance: await this.getBalances(payment.userId),
          replayed: true,
        };
      }
      throw err;
    }
  }

  /**
   * Rejects a payment. No credits are added — that is the whole point, and it
   * is why this cannot share a code path with approval.
   */
  async rejectPayment(id: string, adminId: string, note: string | null): Promise<PaymentRequest | null> {
    const [updated] = await this.db
      .update(paymentRequests)
      .set({
        status: 'rejected',
        reviewedBy: adminId,
        reviewedAt: new Date(),
        reviewNote: note,
        updatedAt: new Date(),
      })
      .where(and(eq(paymentRequests.id, id), eq(paymentRequests.status, 'pending')))
      .returning();
    return updated ?? null;
  }

  async recordTelegramOutcome(id: string, status: 'sent' | 'failed' | 'skipped', error: string | null) {
    await this.db
      .update(paymentRequests)
      .set({ telegramStatus: status, telegramError: error, updatedAt: new Date() })
      .where(eq(paymentRequests.id, id));
  }

  /* ------------------------------------------------------- billing settings */

  async getBillingSettings() {
    const rows = await this.db.select().from(billingSettings).limit(1);
    return rows[0] ?? null;
  }

  async updateBillingSettings(fields: {
    paymentInstructions?: string | null;
    qrCodeUrl?: string | null;
    qrCodeMime?: string | null;
    qrCodeBytes?: number | null;
    paymentMethodLabel?: string | null;
    currency?: string;
  }) {
    const current = await this.getBillingSettings();
    if (!current) {
      const [created] = await this.db
        .insert(billingSettings)
        .values({ id: true, currency: 'INR', ...fields })
        .returning();
      return created!;
    }
    const [updated] = await this.db
      .update(billingSettings)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(billingSettings.id, current.id))
      .returning();
    return updated!;
  }

  /* -------------------------------------------------------------- helpers */

  private async readBalance(tx: Tx, userId: string): Promise<CreditBalance | null> {
    const rows = await tx.select().from(creditBalances).where(eq(creditBalances.userId, userId)).limit(1);
    return rows[0] ?? null;
  }

  private async readPayment(tx: Tx, id: string): Promise<PaymentRequest | null> {
    const rows = await tx.select().from(paymentRequests).where(eq(paymentRequests.id, id)).limit(1);
    return rows[0] ?? null;
  }

  private async appendLedger(
    tx: Tx,
    entry: {
      userId: string;
      bucket: 'free' | 'paid';
      kind: typeof creditLedger.$inferInsert.kind;
      amount: number;
      balanceAfter: number;
      referenceType: string;
      referenceId: string;
      actorUserId: string | null;
      reason?: string;
      idempotencyKey?: string;
    },
  ): Promise<void> {
    await tx.insert(creditLedger).values({
      userId: entry.userId,
      bucket: entry.bucket,
      kind: entry.kind,
      amount: entry.amount,
      balanceAfter: entry.balanceAfter,
      reason: entry.reason ?? null,
      referenceType: entry.referenceType,
      referenceId: entry.referenceId,
      actorUserId: entry.actorUserId,
      idempotencyKey: entry.idempotencyKey ?? null,
    });
  }
}

function toReservation(row: typeof creditReservations.$inferSelect): Reservation {
  return {
    requestId: row.requestId,
    userId: row.userId,
    freeAmount: row.freeAmount,
    paidAmount: row.paidAmount,
    reservedTotal: row.reservedTotal,
  };
}

/**
 * Recognises a Postgres unique-constraint violation across the drivers the
 * project uses. Drizzle surfaces the raw driver error, whose `code` is the
 * SQLSTATE; 23505 is "unique_violation".
 *
 * Load-bearing for three guarantees: the once-only free trial, the duplicate
 * payment guard, and the payment allocation's idempotency key. All three are
 * implemented as unique indexes, so all three rely on this recognising the
 * violation and turning it into a typed outcome instead of a 500.
 */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string }; constraint_name?: string };
  return e?.code === '23505' || e?.cause?.code === '23505' || e?.constraint_name === 'credit_ledger_free_trial_once_idx';
}
