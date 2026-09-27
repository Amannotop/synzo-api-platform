import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';
import type { ProviderHealthEntry } from '../providers/provider.interface.js';

/**
 * In-process metrics for the API.
 *
 * The `requests` table is the durable record and stays the source of truth for
 * billing and per-customer reporting. This registry covers what the database
 * cannot see: upstream failures, rate-limit rejections and provider health as
 * observed live. Restarting the process resets these, which is why nothing here
 * is used for accounting.
 */
export interface Metrics {
  registry: Registry;
  httpRequests: Counter<'method' | 'route' | 'status'>;
  httpDuration: Histogram<'method' | 'route' | 'status'>;
  chatRequests: Counter<'model' | 'status' | 'stream'>;
  chatDuration: Histogram<'model' | 'stream'>;
  upstreamErrors: Counter<'kind'>;
  rateLimitRejections: Counter<'scope'>;
  providerHealth: Gauge<'provider'>;
  /**
   * The last observed provider health, kept here so a summary can be built
   * without reaching back into the health monitor. Refreshed on scrape.
   */
  setProviderHealth(results: ProviderHealthEntry[]): void;
  healthSnapshot(): ProviderHealthEntry[];
}

export function createMetrics(): Metrics {
  const registry = new Registry();
  // Node process metrics: heap, event-loop lag, GC. A single-Mac deployment has
  // no sidecar to collect these, and they are the first thing to look at when
  // the API goes slow.
  collectDefaultMetrics({ register: registry });

  const httpRequests = new Counter({
    name: 'synzo_http_requests_total',
    help: 'Total HTTP requests handled, by route and response status.',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [registry],
  });

  const httpDuration = new Histogram({
    name: 'synzo_http_request_duration_seconds',
    help: 'HTTP request latency in seconds, by route.',
    labelNames: ['method', 'route', 'status'] as const,
    // Buckets span sub-millisecond cache hits through to a slow upstream call,
    // so p95 and p99 are meaningful at both ends.
    buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [registry],
  });

  const chatRequests = new Counter({
    name: 'synzo_chat_requests_total',
    help: 'Chat completions attempted, by model, outcome and streaming mode.',
    labelNames: ['model', 'status', 'stream'] as const,
    registers: [registry],
  });

  const chatDuration = new Histogram({
    name: 'synzo_chat_request_duration_seconds',
    help: 'Chat completion latency in seconds, by model.',
    labelNames: ['model', 'stream'] as const,
    // Tuned for an AI gateway: a non-streaming completion is seconds, not
    // milliseconds, and the interesting question is the slow tail.
    buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120],
    registers: [registry],
  });

  const upstreamErrors = new Counter({
    name: 'synzo_upstream_errors_total',
    help: 'Upstream provider failures, by kind.',
    labelNames: ['kind'] as const,
    registers: [registry],
  });

  const rateLimitRejections = new Counter({
    name: 'synzo_rate_limit_rejections_total',
    help: 'Requests rejected by a limit, by scope.',
    labelNames: ['scope'] as const,
    registers: [registry],
  });

  const providerHealth = new Gauge({
    name: 'synzo_provider_healthy',
    help: 'Provider health as last observed: 1 healthy, 0 unhealthy.',
    labelNames: ['provider'] as const,
    registers: [registry],
  });

  let lastHealth: ProviderHealthEntry[] = [];

  return {
    registry,
    httpRequests,
    httpDuration,
    chatRequests,
    chatDuration,
    upstreamErrors,
    rateLimitRejections,
    providerHealth,
    setProviderHealth(results) {
      lastHealth = results;
      for (const entry of results) {
        providerHealth.set({ provider: entry.provider }, entry.healthy ? 1 : 0);
      }
    },
    healthSnapshot: () => lastHealth,
  };
}
