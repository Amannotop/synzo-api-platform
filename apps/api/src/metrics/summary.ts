import type { Metrics } from './registry.js';

/** One latency quantile, in seconds, or null when nothing has been observed. */
export type Quantile = number | null;

export interface ModelTraffic {
  model: string;
  total: number;
  errors: number;
}

export interface MetricsSummary {
  /** Total HTTP requests since this process started. */
  httpRequestsTotal: number;
  /** Fraction of requests that answered 4xx or 5xx. 0 when there is no traffic. */
  errorRate: number;
  upstreamErrors: LabeledCount<'kind'>[];
  upstreamErrorsTotal: number;
  /** Requests turned away by a limit, by scope. */
  rateLimitRejections: LabeledCount<'scope'>[];
  rateLimitRejectionsTotal: number;
  byModel: ModelTraffic[];
  /** Chat latency: the wait a customer actually experiences, in seconds. */
  latency: { p50: Quantile; p95: Quantile; p99: Quantile; count: number };
  /** Process uptime, so the caller can derive an average request rate. */
  processUptimeSeconds: number;
}

/**
 * Prometheus histograms expose cumulative bucket counts, never a quantile.
 * Prometheus interpolates within a bucket; this returns the bucket's upper
 * bound instead, which is the conservative reading — the reported p95 is never
 * better than reality, and differs from a Prometheus panel by at most one
 * bucket width.
 */
function quantileFromCumulative(
  buckets: { le: number; count: number }[],
  total: number,
  q: number,
): Quantile {
  if (total === 0) return null;
  const target = q * total;
  for (const bucket of buckets) {
    if (bucket.count >= target) return bucket.le;
  }
  return buckets[buckets.length - 1]?.le ?? null;
}

interface MetricValue {
  labels?: Record<string, string>;
  value: string | number;
}

function toNumber(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

/**
 * A counter grouped by one of its labels, e.g. `{ kind: 'timeout', count: 3 }`.
 *
 * The label name is a type parameter so the same helper can produce
 * `LabeledCount<'kind'>` and `LabeledCount<'scope'>` without either one being
 * assignable to the other, which is what stops an upstream-error breakdown
 * from being silently used where a rate-limit breakdown is expected.
 */
export type LabeledCount<K extends string = string> = Record<K, string> & { count: number };

/** Groups values by a label, summing within each group, largest first. */
function groupBy<K extends string>(values: MetricValue[], label: K): LabeledCount<K>[] {
  const totals = new Map<string, number>();
  for (const v of values) {
    const key = v.labels?.[label] ?? 'unknown';
    totals.set(key, (totals.get(key) ?? 0) + toNumber(v.value));
  }
  return [...totals.entries()]
    .map(([key, count]) => ({ [label]: key, count }) as LabeledCount<K>)
    .sort((a, b) => b.count - a.count);
}

/**
 * Turns the registry into the numbers the dashboard renders.
 *
 * Reads the registry's own JSON rather than re-parsing the text format, so the
 * browser gets structured data and p95 here means the same thing it means in a
 * Prometheus panel.
 */
export async function summarizeMetrics(metrics: Metrics): Promise<MetricsSummary> {
  const all = await metrics.registry.getMetricsAsJSON();
  const valuesFor = (name: string): MetricValue[] =>
    (all.find((m) => m.name === name)?.values ?? []) as MetricValue[];

  const httpValues = valuesFor('synzo_http_requests_total');
  const httpRequestsTotal = httpValues.reduce((acc, v) => acc + toNumber(v.value), 0);
  const httpErrors = httpValues
    .filter((v) => Number(v.labels?.status) >= 400)
    .reduce((acc, v) => acc + toNumber(v.value), 0);

  const upstreamErrors = groupBy(valuesFor('synzo_upstream_errors_total'), 'kind');
  const rateLimitRejections = groupBy(valuesFor('synzo_rate_limit_rejections_total'), 'scope');

  // Chat requests carry their outcome on a `status` label, which is what the
  // per-model error rate is computed from.
  const modelTotals = new Map<string, ModelTraffic>();
  for (const v of valuesFor('synzo_chat_requests_total')) {
    const model = v.labels?.model ?? 'unknown';
    const entry = modelTotals.get(model) ?? { model, total: 0, errors: 0 };
    const count = toNumber(v.value);
    entry.total += count;
    if (v.labels?.status !== 'success') entry.errors += count;
    modelTotals.set(model, entry);
  }

  // A Prometheus histogram emits one bucket series per label set, and this
  // histogram is labelled by model and stream. Reading a bucket series in
  // isolation would compare one model's counts against the total across every
  // model, so the buckets are summed per `le` first and the quantile is taken
  // over the combined cumulative curve.
  const bucketTotals = new Map<number, number>();
  for (const v of valuesFor('synzo_chat_request_duration_seconds_bucket')) {
    const le = Number(v.labels?.le);
    if (!Number.isFinite(le)) continue;
    bucketTotals.set(le, (bucketTotals.get(le) ?? 0) + toNumber(v.value));
  }
  const chatBuckets = [...bucketTotals.entries()]
    .map(([le, count]) => ({ le, count }))
    .sort((a, b) => a.le - b.le);
  const chatObservations = valuesFor('synzo_chat_request_duration_seconds_count').reduce(
    (acc, v) => acc + toNumber(v.value),
    0,
  );

  return {
    httpRequestsTotal,
    errorRate: httpRequestsTotal === 0 ? 0 : httpErrors / httpRequestsTotal,
    upstreamErrors,
    upstreamErrorsTotal: upstreamErrors.reduce((acc, e) => acc + e.count, 0),
    rateLimitRejections,
    rateLimitRejectionsTotal: rateLimitRejections.reduce((acc, r) => acc + r.count, 0),
    byModel: [...modelTotals.values()].sort((a, b) => b.total - a.total),
    latency: {
      p50: quantileFromCumulative(chatBuckets, chatObservations, 0.5),
      p95: quantileFromCumulative(chatBuckets, chatObservations, 0.95),
      p99: quantileFromCumulative(chatBuckets, chatObservations, 0.99),
      count: chatObservations,
    },
    processUptimeSeconds: Math.round(process.uptime()),
  };
}
