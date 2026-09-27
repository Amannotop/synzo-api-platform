import type { AppConfig } from '@synzo/config';
import type { Logger } from '../lib/logger.js';
import type { ProviderRegistry } from '../providers/provider.registry.js';
import type { ProviderHealth, ProviderHealthEntry } from '../providers/provider.interface.js';

/**
 * Periodically probes each registered provider and remembers the last result.
 *
 * The interval defaults to 5 minutes: frequent enough to notice an outage,
 * sparse enough not to hammer the provider (§36). A failing probe never
 * propagates into customer requests — it is observational only.
 */
export class ProviderHealthMonitor {
  private readonly latest = new Map<string, ProviderHealth>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly providers: ProviderRegistry,
    private readonly logger: Logger,
  ) {}

  async checkAll(): Promise<void> {
    await Promise.all(
      this.providers.list().map(async (provider) => {
        try {
          // A short, bounded timeout: a health probe must never hang.
          const result = await provider.healthCheck(AbortSignal.timeout(10_000));
          this.latest.set(provider.name, result);
          if (!result.healthy) {
            this.logger.warn('Provider unhealthy', { provider: provider.name, detail: result.detail });
          }
        } catch (err) {
          this.latest.set(provider.name, {
            healthy: false,
            latencyMs: null,
            checkedAt: new Date().toISOString(),
            detail: err instanceof Error ? err.message : 'unknown',
          });
        }
      }),
    );
  }

  start(): void {
    if (!this.config.providerHealth.enabled) return;
    if (this.timer) return;
    void this.checkAll();
    this.timer = setInterval(() => void this.checkAll(), this.config.providerHealth.intervalMs);
    // Do not hold the event loop open purely for health checks.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getAll(): ProviderHealthEntry[] {
    return [...this.latest.entries()].map(([provider, health]) => ({ provider, ...health }));
  }
}
