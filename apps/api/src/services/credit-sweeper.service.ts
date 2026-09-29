import type { AppConfig } from '@synzo/config';
import type { Logger } from '../lib/logger.js';
import type { CreditService } from './credit.service.js';

export interface CreditSweeperDeps {
  config: AppConfig;
  logger: Logger;
  credits: CreditService;
}

/**
 * Reclaims reservations orphaned by a crash or a hard client disconnect.
 *
 * A reservation is tokens held OUTSIDE the remaining balance — it reduces
 * spendable capacity without reducing the balance itself. That is what makes
 * concurrent requests safe, and it is also why a lost reservation is a real
 * problem rather than a cosmetic one: a process that dies between claiming
 * tokens and settling them leaves those tokens frozen, invisible to the
 * customer (the dashboard shows the balance, not the claim) and invisible to
 * the provider (the request produced no billable output). Left alone, enough
 * of those and the customer's account silently stops working with credits
 * they demonstrably still have.
 *
 * Only reservations older than the service's own staleness threshold are
 * reclaimed, and that threshold is deliberately longer than the longest
 * possible upstream stream. A sweep that raced a live request would hand back
 * tokens it is still spending, and that is the failure mode this is here to
 * avoid — it prefers frozen tokens to double-spent ones, and a frozen token
 * self-heals on the next sweep while an overspend does not.
 */
export class CreditSweeper {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: CreditSweeperDeps) {}

  /** Runs one reclaim pass. Returns tokens handed back. Safe to call directly. */
  async sweepNow(): Promise<number> {
    return this.deps.credits.releaseStaleReservations();
  }

  start(): void {
    const intervalMs = this.deps.config.credits.reservationSweepIntervalMs;
    if (!intervalMs || this.timer) return;
    this.timer = setInterval(() => void this.runGuarded(), intervalMs);
    // Never hold the event loop open: closing the app in a test must not hang.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * A failed sweep must not kill the process or silence every later one. A
   * database blip here is transient, and a permanently dead timer would freeze
   * credits with no operator-visible signal beyond one log line.
   */
  private async runGuarded(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const released = await this.sweepNow();
      if (released > 0) {
        this.deps.logger.warn('Reclaimed stale credit reservations', { tokensReleased: released });
      }
    } catch (err) {
      this.deps.logger.error('Credit reservation sweep failed', {
        error: err instanceof Error ? err.message : 'unknown',
      });
    } finally {
      this.running = false;
    }
  }
}
