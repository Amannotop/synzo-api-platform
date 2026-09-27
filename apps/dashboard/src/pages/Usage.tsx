import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import { api } from '../lib/api';
import { compactNumber, formatDateTime, formatMs, formatNumber } from '../lib/format';
import { Alert, Card, EmptyState, Loading, Stat } from '../components/ui';
import type { Range } from '../lib/types';

const RANGES: { value: Range; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
];

export default function Usage() {
  const [range, setRange] = useState<Range>('7d');
  const usage = useQuery({
    queryKey: ['usage', range],
    queryFn: () => api.usage(range),
  });

  if (usage.isLoading) return <Loading rows={4} label="Loading usage" />;
  if (usage.isError) {
    return <Alert kind="error">Could not load usage. {usage.error instanceof Error ? usage.error.message : ''}</Alert>;
  }

  const u = usage.data!;
  const hasTraffic = u.stats.totalRequests > 0;
  const series = u.series.map((p) => ({
    ...p,
    label: new Date(p.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  }));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Usage</h1>
          <p>Token consumption and request volume recorded from your own traffic.</p>
        </div>
        <div className="segmented" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r.value} className={range === r.value ? 'active' : ''}
              aria-pressed={range === r.value} onClick={() => setRange(r.value)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-stats mb-3">
        <Stat label="Requests" value={compactNumber(u.stats.totalRequests)}
          sub={`${formatNumber(u.stats.successfulRequests)} successful`} />
        <Stat label="Failed" value={compactNumber(u.stats.failedRequests)}
          sub={hasTraffic ? `${u.stats.failedRequests} did not complete` : 'No failures'} />
        <Stat label="Prompt tokens" value={compactNumber(u.stats.promptTokens)} sub="tokens sent" />
        <Stat label="Completion tokens" value={compactNumber(u.stats.completionTokens)} sub="tokens received" />
        <Stat label="Total tokens" value={compactNumber(u.stats.totalTokens)} sub="prompt + completion" />
        <Stat label="Average latency" value={hasTraffic ? formatMs(u.stats.avgLatencyMs) : '—'}
          sub={hasTraffic ? `peak ${formatMs(u.stats.maxLatencyMs)}` : 'No traffic yet'} />
      </div>

      <p className="small subtle">
        Range: {formatDateTime(u.range.from)} → {formatDateTime(u.range.to)}
      </p>

      {!hasTraffic ? (
        <Card>
          <EmptyState
            title="No usage in this period"
            message="Once your keys start making requests, the charts and breakdown appear here."
          />
        </Card>
      ) : (
        <div className="grid grid-2">
          <Card title="Requests and errors">
            <div className="chart-box">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                  <defs>
                    <linearGradient id="gU1" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-subtle)' }}
                    tickLine={false} axisLine={false} minTickGap={18} />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--text-subtle)' }}
                    tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)',
                    borderRadius: 8, fontSize: 12 }} labelStyle={{ color: 'var(--text)', fontWeight: 600 }} />
                  <Area type="monotone" dataKey="requests" name="Requests" stroke="var(--accent)"
                    strokeWidth={2} fill="url(#gU1)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card title="Tokens per day">
            <div className="chart-box">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-subtle)' }}
                    tickLine={false} axisLine={false} minTickGap={18} />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--text-subtle)' }}
                    tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)',
                    borderRadius: 8, fontSize: 12 }} labelStyle={{ color: 'var(--text)', fontWeight: 600 }} />
                  <Bar dataKey="promptTokens" name="Prompt" stackId="t" fill="var(--accent)" radius={[0, 0, 0, 0]} />
                  <Bar dataKey="completionTokens" name="Completion" stackId="t" fill="var(--success)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card title="By model" bodyClass="">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th className="num">Requests</th>
                    <th className="num">Tokens</th>
                    <th className="num">Upstream cost</th>
                  </tr>
                </thead>
                <tbody>
                  {u.byModel.map((m) => (
                    <tr key={m.model}>
                      <td className="mono">{m.model}</td>
                      <td className="num">{formatNumber(m.requests)}</td>
                      <td className="num">{formatNumber(m.totalTokens)}</td>
                      <td className="num muted">
                        {/* Cost is only ever shown when the provider reported it. */}
                        {m.upstreamCost === null ? '—' : m.upstreamCost.toFixed(6)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small subtle" style={{ padding: '10px 16px 0', margin: 0 }}>
              Upstream cost is what the provider reported. It is not a price charged to you.
            </p>
          </Card>
        </div>
      )}
    </>
  );
}
