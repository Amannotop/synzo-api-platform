import { useQuery } from '@tanstack/react-query';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import { api } from '../lib/api';
import { compactNumber, formatMs, formatNumber } from '../lib/format';
import { Alert, Card, EmptyState, Icons, Loading, Stat } from '../components/ui';

const STATUS_COLORS: Record<string, string> = {
  success: 'var(--success)',
  error: 'var(--danger)',
  cancelled: 'var(--warning)',
};

export default function Dashboard() {
  const overview = useQuery({ queryKey: ['overview'], queryFn: api.overview });
  const usage = useQuery({ queryKey: ['usage', '7d'], queryFn: () => api.usage('7d') });

  if (overview.isLoading || usage.isLoading) return <Loading rows={5} label="Loading dashboard" />;

  if (overview.isError) {
    return <Alert kind="error">Could not load dashboard data. {errorText(overview.error)}</Alert>;
  }

  const o = overview.data!;
  const u = usage.data!;
  const hasTraffic = o.stats.totalRequests > 0;
  const successRate = o.stats.totalRequests > 0
    ? (o.stats.successfulRequests / o.stats.totalRequests) * 100
    : 0;

  const series = u.series.map((p) => ({
    ...p,
    label: new Date(p.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  }));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p>Your platform activity. Every number comes from recorded requests — nothing is estimated.</p>
        </div>
      </div>

      <div className="grid grid-stats mb-3">
        <Stat label="Total requests" value={compactNumber(o.stats.totalRequests)}
          sub={`${formatNumber(o.stats.successfulRequests)} successful`} />
        <Stat label="Failed requests" value={compactNumber(o.stats.failedRequests)}
          sub={hasTraffic ? `${successRate.toFixed(1)}% success rate` : 'No traffic yet'} />
        <Stat label="Total tokens" value={compactNumber(o.stats.totalTokens)}
          sub={`${compactNumber(o.stats.promptTokens)} in · ${compactNumber(o.stats.completionTokens)} out`} />
        <Stat label="Average latency" value={hasTraffic ? formatMs(o.stats.avgLatencyMs) : '—'}
          sub={hasTraffic ? `peak ${formatMs(o.stats.maxLatencyMs)}` : 'No traffic yet'} />
        <Stat label="Active API keys" value={formatNumber(o.activeKeys)}
          sub={`${formatNumber(o.totalKeys)} total`} />
        <Stat label="Projects" value={formatNumber(o.projects)}
          sub={o.models.length ? `model: ${o.models[0]}` : 'No models enabled'} />
      </div>

      {!hasTraffic ? (
        <Card title="Get started">
          <EmptyState
            icon={<Icons.key size={20} />}
            title="No requests yet"
            message="Create an API key and make your first call. Statistics appear here as soon as real traffic arrives."
            action={<a className="btn btn-primary" href="/keys">Create an API key</a>}
          />
        </Card>
      ) : (
        <div className="grid grid-2">
          <Card title="Requests over time">
            <div className="chart-box">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                  <defs>
                    <linearGradient id="gReq" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-subtle)' }}
                    tickLine={false} axisLine={false} minTickGap={18} />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--text-subtle)' }}
                    tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)',
                      borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: 'var(--text)', fontWeight: 600 }} />
                  <Area type="monotone" dataKey="requests" name="Requests" stroke="var(--accent)"
                    strokeWidth={2} fill="url(#gReq)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card title="Token usage">
            <div className="chart-box">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
                  <defs>
                    <linearGradient id="gTok" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--success)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--success)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-subtle)' }}
                    tickLine={false} axisLine={false} minTickGap={18} />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--text-subtle)' }}
                    tickLine={false} axisLine={false} />
                  <Tooltip
                    contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)',
                      borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: 'var(--text)', fontWeight: 600 }} />
                  <Area type="monotone" dataKey="totalTokens" name="Total tokens" stroke="var(--success)"
                    strokeWidth={2} fill="url(#gTok)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card title="Usage by model">
            {u.byModel.length === 0 ? (
              <EmptyState title="No model usage yet" message="Model breakdown appears after your first request." />
            ) : (
              <div className="chart-box">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={u.byModel} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="model" tick={{ fontSize: 11, fill: 'var(--text-subtle)' }}
                      tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: 'var(--text-subtle)' }}
                      tickLine={false} axisLine={false} allowDecimals={false} />
                    <Tooltip
                      contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)',
                        borderRadius: 8, fontSize: 12 }}
                      labelStyle={{ color: 'var(--text)', fontWeight: 600 }} />
                    <Bar dataKey="requests" name="Requests" radius={[4, 4, 0, 0]}>
                      {u.byModel.map((m) => (
                        <Cell key={m.model} fill="var(--accent)" />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          <Card title="Errors by model">
            {series.every((p) => p.errors === 0) ? (
              <EmptyState
                icon={<Icons.check size={20} />}
                title="No errors in this period"
                message="Every recorded request in the last 7 days completed successfully."
              />
            ) : (
              <div className="chart-box">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-subtle)' }}
                      tickLine={false} axisLine={false} minTickGap={18} />
                    <YAxis tick={{ fontSize: 11, fill: 'var(--text-subtle)' }}
                      tickLine={false} axisLine={false} allowDecimals={false} />
                    <Tooltip
                      contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)',
                        borderRadius: 8, fontSize: 12 }}
                      labelStyle={{ color: 'var(--text)', fontWeight: 600 }} />
                    <Bar dataKey="errors" name="Errors" radius={[4, 4, 0, 0]} fill="var(--danger)" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error';
}

export { STATUS_COLORS };
