import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { formatDateTime, formatMs, formatNumber } from '../lib/format';
import { Alert, Button, Card, EmptyState, Loading } from '../components/ui';
import type { Range, RequestLogRow } from '../lib/types';

const RANGES: { value: Range; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
];

const STATUS_BADGE: Record<string, { cls: string; label: string }> = {
  success: { cls: 'badge-success', label: 'Success' },
  error: { cls: 'badge-danger', label: 'Error' },
  cancelled: { cls: 'badge-warning', label: 'Cancelled' },
};

const PAGE_SIZE = 25;

export default function Requests() {
  const [range, setRange] = useState<Range>('7d');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(0);

  const requests = useQuery({
    queryKey: ['requests', range, status, page],
    queryFn: () => api.requests({
      range, limit: PAGE_SIZE, offset: page * PAGE_SIZE,
      ...(status ? { status } : {}),
    }),
  });

  const rows = requests.data?.requests ?? [];
  const total = requests.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Requests</h1>
          <p>Metadata for every request made with your keys. Prompts and responses are not stored.</p>
        </div>
        <div className="filters">
          <div className="segmented" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button key={r.value} className={range === r.value ? 'active' : ''}
                aria-pressed={range === r.value}
                onClick={() => { setRange(r.value); setPage(0); }}>
                {r.label}
              </button>
            ))}
          </div>
          <select className="select" style={{ width: 'auto' }} value={status}
            aria-label="Filter by status" onChange={(e) => { setStatus(e.target.value); setPage(0); }}>
            <option value="">All statuses</option>
            <option value="success">Success</option>
            <option value="error">Error</option>
          </select>
        </div>
      </div>

      {requests.isLoading ? (
        <Loading rows={5} label="Loading requests" />
      ) : requests.isError ? (
        <Alert kind="error">Could not load requests. {requests.error instanceof Error ? requests.error.message : ''}</Alert>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            title="No requests recorded"
            message="Requests appear here with their status, latency and token counts as your keys use the API."
          />
        </Card>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Request ID</th>
                  <th>Timestamp</th>
                  <th>Model</th>
                  <th>Status</th>
                  <th className="num">Latency</th>
                  <th className="num">Tokens</th>
                  <th>Stream</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => <Row key={r.requestId} r={r} />)}
              </tbody>
            </table>
          </div>

          {pageCount > 1 && (
            <div className="pagination">
              <span className="small muted">
                Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {formatNumber(total)}
              </span>
              <div className="row">
                <Button size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                <span className="small muted">Page {page + 1} of {pageCount}</span>
                <Button size="sm" disabled={page >= pageCount - 1} onClick={() => setPage((p) => p + 1)}>Next</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function Row({ r }: { r: RequestLogRow }) {
  const badge = STATUS_BADGE[r.status] ?? { cls: 'badge-neutral', label: r.status };
  return (
    <tr>
      <td className="mono truncate" style={{ maxWidth: 190 }} title={r.requestId}>{r.requestId}</td>
      <td className="muted" title={r.createdAt}>{formatDateTime(r.createdAt)}</td>
      <td className="mono">{r.model}</td>
      <td>
        <span className={`badge ${badge.cls}`} title={r.errorCode ?? undefined}>
          <span className="dot" />{badge.label}
        </span>
        {r.errorCode && <div className="tiny subtle mono">{r.errorCode}</div>}
      </td>
      <td className="num">{formatMs(r.latencyMs)}</td>
      <td className="num">{r.totalTokens === null ? '—' : formatNumber(r.totalTokens)}</td>
      <td className="muted">{r.stream ? 'stream' : '—'}</td>
    </tr>
  );
}
