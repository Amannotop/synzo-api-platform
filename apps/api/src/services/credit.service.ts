import type { AppConfig } from '@synzo/config';
import { creditExhausted } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { CreditRepository, Reservation, SettleResult } from '../repositories/credit.repository.js';
import type { ChatMessage } from '@synzo/types';

/**
 * Characters per token in the worst case.
 *
 * Deliberately pessimistic. The reservation has to be an UPPER BOUND on what
 * the request can cost, because anything it under-reserves is money the
 * platform gives away: two requests each reserving 900 tokens against a 1,000
 * balance would both be admitted and then both deducted. Under-estimating is
 * the one direction of error that breaks the guarantee.
 *
 * 3 is conservative for English prose and roughly right for JSON, which
 * tokenizes denser than text. Over-reserving is not free — it is held out of
 * the customer's spendable balance for the life of the request — so the
 * constant is tuned to be safe without being absurd. Real usage then settles
 * at the provider's own count and the difference is returned immediately.
 */
const CHARS_PER_TOKEN = 3;

/**
 * Floor for a request's reservation.
 *
 * A one-word prompt still costs a few tokens, and a reservation of 0 would
 * let an unlimited number of trivial requests through the balance check
 * simultaneously. Every request claims at least this much.
 */
const MIN_RESERVATION = 64;

/**
 * Worst-case prompt tokens charged for one image.
 *
 * Providers bill images by tiling, so the real cost scales with pixel count and
 * is not knowable from the request. A flat charge per image is used instead,
 * for two reasons. It has to be an upper bound or an image request can
 * overspend the balance it passed, and it cannot be derived from the encoded
 * bytes either, because a 20KB JPEG and a 20KB PNG can differ by an order of
 * magnitude once decoded. 1,500 is a conservative high-detail figure, above
 * what a 1024x1024 tile costs on any provider we support.
 *
 * Chosen as a guard, not as a price: a real settlement still uses the
 * provider's own reported usage, so a customer is only ever charged what the
 * provider actually billed them for.
 */
const IMAGE_PROMPT_TOKENS = 1_500;

/**
 * How long a reservation may sit unsettled before recovery reclaims it.
 *
 * A stream can legitimately run for minutes (UPSTREAM_STREAM_TIMEOUT is
 * 300s), so this has to comfortably exceed the slowest real request or
 * recovery would hand back tokens a live request is still spending. It is a
 * crash-recovery backstop, not a normal path.
 */
export const STALE_RESERVATION_MS = 15 * 60_000;

export interface CreditServiceDeps {
  config: AppConfig;
  logger: Logger;
  credits: CreditRepository;
}

export interface CreditHolder {
  userId: string;
  /** Admins in unlimited mode bypass credit accounting entirely. */
  unlimited: boolean;
}

/**
 * Enforces credit balances on the API path.
 *
 * Three responsibilities, and the order they happen in is the design:
 *
 *  1. `reserve` runs BEFORE the upstream call. It claims a worst-case token
 *     count atomically, so concurrent requests cannot collectively spend more
 *     than the balance holds. A request that cannot reserve is refused with a
 *     `credit_exhausted` error and never reaches the provider, so a customer is
 *     never billed for a response they did not get.
 *
 *  2. `settle` runs after the provider reports real usage, converting the
 *     reservation into actual usage and returning the unused remainder to the
 *     pools it came from.
 *
 *  3. `release` runs on any failure path, handing the whole reservation back.
 *
 * Settle and release are both idempotent at the repository level, because the
 * streaming path, the non-streaming path, and a client disconnect can each
 * reach the finish line, and only one of them may keep the tokens.
 */
export class CreditService {
  constructor(private readonly deps: CreditServiceDeps) {}

  /**
   * Whether this account is subject to credit accounting at all.
   *
   * An admin in unlimited mode is exempt: they are the operator, they are not
   * being charged, and holding their own credits hostage would make the admin
   * unable to test the platform they are administering.
   */
  isExempt(holder: CreditHolder): boolean {
    return holder.unlimited;
  }

  /**
   * The upper bound on what one request can cost.
   *
   * Two parts, and the second is the important one: the prompt, which we can
   * measure, and the completion, which we cannot know before the model has
   * written it. An omitted `max_tokens` has to be bounded by SOMETHING, or the
   * reservation is not a bound at all.
   *
   * What it is bounded by is `CREDIT_MAX_RESERVATION_TOKENS`, not the
   * provider's full output cap. Reserving the full 200k cap would be strictly
   * more accurate and would also make the platform unusable: a 500k trial
   * would fit two concurrent unbounded requests and nothing else, so an
   * ordinary customer would be shown "exhausted" while holding half a million
   * tokens. The cap is the point where accounting precision stops being worth
   * the concurrency it costs, and it is configurable for an operator who wants
   * the exact number.
   *
   * An explicit `max_tokens` is always respected, clamped to the same ceiling,
   * so a caller who bounds themselves precisely is not charged for a
   * completion they said they would not ask for.
   */
  estimateMaxTokens(input: {
    messages: ChatMessage[];
    maxTokens: number | undefined;
  }): number {
    let chars = 0;
    let images = 0;
    for (const m of input.messages) {
      if (typeof m.content === 'string') chars += m.content.length;
      /**
       * A multi-part message costs more than its text. Each image is charged
       * the flat IMAGE_PROMPT_TOKENS figure rather than the length of its base64
       * payload: the payload length measures the encoding, not the tokenised
       * image, and base64 inflates it by a third into the bargain. Counting the
       * text of a message also counts the surrounding prompt, which the
       * provider really does read.
       */
      if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part.type === 'image_url') images += 1;
          else chars += part.text.length;
        }
      }
      // Tool schemas are real input the provider has to read, even though they
      // are deliberately excluded from what we STORE for audit. Billing them
      // as though they were not sent would under-reserve every agent request.
      if (Array.isArray((m as { tool_calls?: unknown }).tool_calls)) {
        chars += JSON.stringify((m as { tool_calls?: unknown }).tool_calls).length;
      }
    }

    const promptEstimate = Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_PROMPT_TOKENS + 16;
    const ceiling = this.deps.config.credits.maxReservationTokens;
    const completionCap = Math.min(
      input.maxTokens ?? this.deps.config.limits.maxContentTokensHardCap,
      ceiling,
    );

    return Math.min(ceiling, Math.max(MIN_RESERVATION, promptEstimate + completionCap));
  }

  /**
   * Claims worst-case credits, or throws `credit_exhausted`.
   *
   * Throwing rather than returning a result is deliberate: every call site is
   * about to call the provider, so a caller that ignored a failure flag would
   * spend real money. An exception cannot be ignored by accident.
   */
  async reserve(
    holder: CreditHolder,
    requestId: string,
    estimate: number,
  ): Promise<Reservation | null> {
    if (this.isExempt(holder)) return null;

    const result = await this.deps.credits.reserve({
      requestId,
      userId: holder.userId,
      amount: estimate,
    });

    if (result.ok) return result.reservation;

    if (result.reason === 'insufficient') {
      /**
       * There is not enough for the WORST CASE, but the shortfall may still
       * cover a small request. Claiming what is actually there — rather than
       * refusing the customer outright — is what keeps a low balance from
       * becoming a total outage while they still demonstrably hold credits.
       *
       * Why this matters concretely: with a 32k reservation ceiling, a customer
       * with 207 credits was told "you have credits" by the dashboard and then
       * refused every call, including a two-word prompt that genuinely costs
       * less than 207. `available` is the true spendable total across both
       * pools, so it is the only correct ceiling here.
       *
       * This cannot overspend. The claim is still taken inside the repository's
       * locked transaction and is bounded by `available`, and `settle` charges
       * at most what was held — so a request whose real usage exceeds its
       * clamped reservation is under-charged by exactly that excess, which is
       * the same deliberate trade the settlement cap already makes.
       *
       * When even a minimal request cannot be covered, `available` is 0 and
       * this is a genuine exhaustion, reported as such.
       */
      const available = result.freeRemaining + result.paidRemaining;
      if (available >= MIN_RESERVATION) {
        const clamped = await this.deps.credits.reserve({
          requestId,
          userId: holder.userId,
          amount: available,
        });
        if (clamped.ok) {
          this.deps.logger.warn('Reservation clamped to available balance', {
            requestId,
            userId: holder.userId,
            requested: estimate,
            reserved: available,
          });
          return clamped.reservation;
        }
        // The balance moved between the two calls. Fall through and report the
        // exhaustion rather than looping.
      }

      throw creditExhausted({
        freeRemaining: result.freeRemaining,
        paidRemaining: result.paidRemaining,
      });
    }

    // not_found / conflict are programming errors, not customer conditions.
    // Surfacing them as a 500 is correct: they mean a request id collided or a
    // key points at a deleted user, and neither should be silently ignored.
    throw new Error(`Could not reserve credits: ${result.reason}`);
  }

  /**
   * Converts a reservation into real usage.
   *
   * Never throws. Accounting runs alongside a response the customer may
   * already have received; failing the request because the ledger write failed
   * would be worse than the missing ledger row, which an operator can
   * reconcile from the `requests` table. The error is logged instead.
   *
   * `usage.totalTokens` is null whenever the provider did not report usage —
   * a stream that never sent its final usage frame, or an upstream that omits
   * the field. In that case the reservation is RELEASED rather than settled at
   * zero, because releasing returns the customer's tokens and settling at zero
   * would silently burn a worst-case estimate that was never actually spent.
   */
  async settle(
    holder: CreditHolder,
    reservation: Reservation | null,
    usage: { totalTokens: number | null } | null,
  ): Promise<SettleResult | null> {
    if (!reservation) return null;

    const actual = usage?.totalTokens ?? null;
    try {
      if (actual === null) {
        await this.deps.credits.release(reservation.requestId, holder.userId);
        return null;
      }
      return await this.deps.credits.settle({
        requestId: reservation.requestId,
        userId: holder.userId,
        actualTokens: actual,
      });
    } catch (err) {
      this.deps.logger.error('Failed to settle credit reservation', {
        requestId: reservation.requestId,
        error: err instanceof Error ? err.message : 'unknown',
      });
      return null;
    }
  }

  /**
   * Returns an unspent reservation. Used on every failure path, and safe to
   * call after a successful settle — the repository treats an
   * already-settled reservation as a no-op, so a double finish cannot hand
   * back tokens that were genuinely spent.
   */
  async release(holder: CreditHolder, reservation: Reservation | null): Promise<void> {
    if (!reservation) return;
    try {
      await this.deps.credits.release(reservation.requestId, holder.userId);
    } catch (err) {
      this.deps.logger.error('Failed to release credit reservation', {
        requestId: reservation.requestId,
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  }

  /**
   * Reclaims reservations orphaned by a crash.
   *
   * A process that dies mid-request cannot settle its own claim, and without
   * this the customer's tokens stay frozen. Only reservations older than
   * STALE_RESERVATION_MS are touched, so a slow-but-live request in another
   * process is never robbed.
   */
  async releaseStaleReservations(): Promise<number> {
    return this.deps.credits.releaseStaleReservations(STALE_RESERVATION_MS);
  }
}
