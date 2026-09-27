import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { compactNumber, formatMs, formatNumber, relativeTime } from '../lib/format';
import { Alert, Card, EmptyState, Icons, Loading, Stat, StatusBadge } from '../components/ui';
import type { MetricsSummary, ProviderHealthEntry } from '../lib/types';

/**
 * The operational surface: "tell me when something breaks".
 *
 * Every number here comes from the in-process Prometheus registry, which is
 * reset when the API restarts. That is a deliberate trade — these are live
 * signals for the current process, while the `requests` table remains the
 * durable record used for billing and per-customer reporting. The counters
 * being process-scoped is stated on the page rather than left for an operator
 * to discover when a deploy makes every number drop to zero.
 */

/** Seconds to a display string. A null quantile means nothing observed yet. */
function seconds(v: number | null): string {
  if (v === null) return '—';
  return v < 1 ? `${Math.round(v * 1000)}ms` : `${v.toFixed(2)}s`;
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(fraction > 0 && fraction < 0.001 ? 2 : 1)}%`;
}

/**
 * The rate is derived from the process's own uptime rather than reported
 * directly, because a counter with no elapsed-time denominator cannot answer
 * "how much traffic is this". Uptime restarts with the process, so the rate
 * describes the current run and nothing older.
 */
function requestsPerMinute(summary: MetricsSummary): number {
  if (summary.processUptimeSeconds <= 0) return 0;
  return (summary.httpRequestsTotal / summary.processUptimeSeconds) * 60;
}

function ProviderRow({ provider }: { provider: ProviderHealthEntry }) {
  return (
    <tr>
      <td>
        <strong>{provider.provider}</strong>
      </td>
      <td>
        <StatusBadge status={provider.healthy ? 'healthy' : 'unhealthy'} />
      </td>
      <td>{formatMs(provider.latencyMs)}</td>
      <td className="muted small">{relativeTime(provider.checkedAt)}</td>
    </tr>
  );
}

/** A labelled counter with a breakdown, or an explicit "none recorded". */
function CounterTable({
  title,
  rows,
  total,
  labelHeader,
  emptyHint,
}: {
  title: string;
  rows: { kind?: string; scope?: string; count: number }[];
  total: number;
  labelHeader: string;
  emptyHint: string;
}) {
  return (
    <Card title={title} actions={<span className="badge badge-neutral">{formatNumber(total)}</span>}>
      {rows.length === 0 ? (
        <p className="muted small">{emptyHint}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{labelHeader}</th>
                <th className="right">Count</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const label = row.kind ?? row.scope ?? 'unknown';
                return (
                  <tr key={label}>
                    <td><code>{label}</code></td>
                    <td className="right">{formatNumber(row.count)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export default function Operations() {
  const { data, isLoading, error, dataUpdatedAt } = useQuery({
    queryKey: ['admin', 'metrics'],
    queryFn: api.admin.metrics,
    // Fast enough that a spike is caught while it is happening, slow enough
    // that an operator leaving this page open does not hammer the API.
    refetchInterval: 10_000,
  });

  if (isLoading) return <Loading rows={4} label="Loading operational metrics…" />;

  if (error) {
    return (
      <Alert kind="error">
        Could not load metrics: {error instanceof Error ? error.message : 'unknown error'}. The
        endpoint is admin-only, and it is disabled when <code>METRICS_ENABLED=false</code>.
      </Alert>
    );
  }

  const summary = data!.summary;
  const providers = data!.providers;
  const unhealthy = providers.filter((p) => !p.healthy);
  const rps = requestsPerMinute(summary);

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="grid grid-4">
        <Stat
          label="Request rate"
          value={`${rps.toFixed(1)}/min`}
          sub={`${formatNumber(summary.httpRequestsTotal)} since this process started`}
        />
        <Stat
          label="Error rate"
          value={percent(summary.errorRate)}
          sub="4xx and 5xx, of all requests"
        />
        <Stat
          label="Chat latency p95"
          value={seconds(summary.latency.p95)}
          sub={`p50 ${seconds(summary.latency.p50)} · p99 ${seconds(summary.latency.p99)}`}
        />
        <Stat
          label="Upstream failures"
          value={formatNumber(summary.upstreamErrorsTotal)}
          sub={`${formatNumber(summary.rateLimitRejectionsTotal)} rate-limit rejections`}
        />
      </div>

      {unhealthy.length > 0 && (
        <Alert kind="warning">
          <strong>{unhealthy.length === 1 ? 'A provider is unhealthy' : 'Providers are unhealthy'}:</strong>{' '}
          {unhealthy.map((p) => p.provider).join(', ')}. A missing or rejected{' '}
          <code>UPSTREAM_API_KEY</code> shows up here as an authentication failure rather than as
          a generic upstream error.
        </Alert>
      )}

      <div className="muted small">
        Counters cover the current API process only and reset on restart — they are for spotting a
        problem now, not for billing. Durable per-customer totals live in Usage and Requests.
        {dataUpdatedAt > 0 && ` Last read ${relativeTime(new Date(dataUpdatedAt).toISOString())}.`}
      </div>

      <Card
        title="Provider health"
        actions={<span className="badge badge-neutral">{providers.length} configured</span>}
      >
        {providers.length === 0 ? (
          <EmptyState
            title="No provider has been probed yet"
            message="The health monitor runs on an interval. Its first result appears here shortly after the API starts."
            icon={<Icons.shield size={20} />}
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Status</th>
                  <th>Latency</th>
                  <th>Checked</th>
                </tr>
              </thead>
              <tbody>
                {providers.map((p) => (
                  <ProviderRow key={p.provider} provider={p} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Traffic by model"
        actions={<span className="badge badge-neutral">{summary.byModel.length} seen</span>}
      >
        {summary.byModel.length === 0 ? (
          <p className="muted small">
            No chat completions yet. This table fills in as customers call the API.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="right">Requests</th>
                  <th className="right">Errors</th>
                  <th className="right">Error rate</th>
                </tr>
              </thead>
              <tbody>
                {summary.byModel.map((m) => (
                  <tr key={m.model}>
                    <td><code>{m.model}</code></td>
                    <td className="right">{compactNumber(m.total)}</td>
                    <td className="right">{formatNumber(m.errors)}</td>
                    <td className="right">
                      {m.total === 0 ? '—' : percent(m.errors / m.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid grid-2">
        <CounterTable
          title="Upstream errors by kind"
          rows={summary.upstreamErrors}
          total={summary.upstreamErrorsTotal}
          labelHeader="Kind"
          emptyHint="No upstream failures recorded since this process started."
        />
        <CounterTable
          title="Rate-limit rejections by scope"
          rows={summary.rateLimitRejections}
          total={summary.rateLimitRejectionsTotal}
          labelHeader="Scope"
          emptyHint="No request has been turned away by a limit since this process started."
        />
      </div>
    </div>
  );
}
