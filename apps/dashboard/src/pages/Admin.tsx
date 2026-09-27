import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { useToast } from '../components/Toast';
import { compactNumber, formatDateTime, formatMs, formatNumber, relativeTime } from '../lib/format';
import type { Limits, Model, Stats, User } from '../lib/types';
import {
  Alert, Button, Card, Dialog, EmptyState, Field, Icons, Input, Loading, Stat, StatusBadge,
} from '../components/ui';

/* ------------------------------------------------------- response shapes */

interface AdminError {
  requestId: string;
  createdAt: string;
  model: string;
  provider: string;
  httpStatus: number;
  errorType: string | null;
  errorCode: string | null;
  latencyMs: number;
}

interface ProviderHealth {
  provider: string;
  healthy: boolean;
  latencyMs: number | null;
  checkedAt: string;
  detail: string | null;
}

interface AuditEntry {
  id: string;
  actorUserId: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  ip: string | null;
  createdAt: string;
}

interface SystemTotals extends Stats {
  upstreamCost: number;
}

const TABS = [
  { id: 'customers', label: 'Customers' },
  { id: 'platform', label: 'Platform' },
  { id: 'audit', label: 'Audit' },
] as const;
type Tab = (typeof TABS)[number]['id'];

export default function Admin() {
  const { user: me } = useAuth();
  const [tab, setTab] = useState<Tab>('customers');

  const system = useQuery({ queryKey: ['admin', 'usage'], queryFn: api.admin.systemUsage });
  const health = useQuery({ queryKey: ['admin', 'health'], queryFn: api.admin.providerHealth });

  if (system.isLoading) return <Loading rows={4} label="Loading admin" />;
  if (system.isError || !system.data) {
    return <Alert kind="error">Could not load admin data. {message(system.error)}</Alert>;
  }

  const totals = system.data.totals as SystemTotals;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Administration</h1>
          <p>
            Platform-wide view. Admins see key metadata only — a secret is never retrievable after
            it is created.
          </p>
        </div>
      </div>

      <div className="grid grid-stats mb-3">
        <Stat label="Customers" value={formatNumber(system.data.customers)} sub="registered accounts" />
        <Stat label="Models" value={formatNumber(system.data.modelCount)} sub="in the registry" />
        <Stat label="Total requests" value={compactNumber(totals.totalRequests)}
          sub={`${formatNumber(totals.successfulRequests)} successful`} />
        <Stat label="Total tokens" value={compactNumber(totals.totalTokens)}
          sub={`${compactNumber(totals.failedRequests)} failed`} />
        <Stat label="Average latency" value={totals.totalRequests ? formatMs(totals.avgLatencyMs) : '—'}
          sub="across all traffic" />
        <Stat label="Upstream cost" value={totals.upstreamCost.toFixed(6)}
          sub="as reported by the provider" />
      </div>

      <ProviderHealthCard health={health.data?.health as ProviderHealth[] | undefined} isLoading={health.isLoading} />

      <div className="tabs mt-3" role="tablist" style={{ maxWidth: 420 }}>
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id}
            className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'customers' && <CustomersTab currentUserId={me?.id} />}
      {tab === 'platform' && <PlatformTab />}
      {tab === 'audit' && <AuditTab />}
    </>
  );
}

/* ------------------------------------------------------------- providers */

function ProviderHealthCard({ health, isLoading }: { health: ProviderHealth[] | undefined; isLoading: boolean }) {
  if (isLoading) return <Loading rows={1} label="Loading provider health" />;
  if (!health || health.length === 0) {
    return (
      <Card title="Provider health">
        <p className="muted mb-0">No provider health data has been collected yet.</p>
      </Card>
    );
  }
  return (
    <Card title="Provider health">
      <div className="grid grid-2">
        {health.map((h) => (
          <div key={h.provider} className="row-between" style={{
            padding: '12px 0', borderBottom: '1px solid var(--border)',
          }}>
            <div>
              <div className="strong mono">{h.provider}</div>
              <div className="small muted">
                Checked {relativeTime(h.checkedAt)}
                {h.detail ? ` · ${h.detail}` : ''}
              </div>
            </div>
            <div className="row">
              {h.latencyMs !== null && <span className="small muted">{formatMs(h.latencyMs)}</span>}
              <span className={`badge ${h.healthy ? 'badge-success' : 'badge-danger'}`}>
                <span className="dot" />{h.healthy ? 'operational' : 'down'}
              </span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------- customers */

function CustomersTab({ currentUserId }: { currentUserId: string | undefined }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<User | null>(null);

  const customers = useQuery({ queryKey: ['admin', 'customers'], queryFn: api.admin.customers });

  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: Parameters<typeof api.admin.setCustomer>[1] }) =>
      api.admin.setCustomer(id, input),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: ['admin', 'customers'] });
      setEditing(null);
      const what = v.input.status ? `account ${v.input.status}` : 'account updated';
      toast.push('success', `Updated ${what}`);
    },
    onError: (e) => toast.push('error', 'Could not update customer', message(e)),
  });

  if (customers.isLoading) return <Loading rows={4} label="Loading customers" />;
  if (customers.isError || !customers.data) {
    return <Alert kind="error">{message(customers.error)}</Alert>;
  }

  const list = customers.data.customers;

  if (list.length === 0) {
    return (
      <Card>
        <EmptyState icon={<Icons.users size={20} />} title="No customers yet"
          message="Accounts registered through the dashboard will appear here." />
      </Card>
    );
  }

  return (
    <>
      <div className="table-wrap">
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Role</th>
                <th>Status</th>
                <th>Flags</th>
                <th>Last sign-in</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id}>
                  <td>
                    <div className="strong">{c.name}</div>
                    <div className="small muted mono">{c.email}</div>
                  </td>
                  <td>
                    <span className={`badge ${c.role === 'admin' ? 'badge-accent' : 'badge-neutral'}`}>
                      {c.role}
                    </span>
                  </td>
                  <td><StatusBadge status={c.status} /></td>
                  <td>
                    <div className="row wrap" style={{ gap: 5 }}>
                      {c.unlimitedMode && <span className="badge badge-neutral">unlimited</span>}
                      {c.allowLiveKeys && <span className="badge badge-accent">live keys</span>}
                    </div>
                  </td>
                  <td className="muted small">{c.lastLoginAt ? relativeTime(c.lastLoginAt) : 'never'}</td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <Button size="sm" onClick={() => setEditing(c)}>Manage</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <CustomerDialog
        customer={editing}
        isSelf={editing?.id === currentUserId}
        busy={update.isPending}
        onClose={() => setEditing(null)}
        onSave={(input) => editing && update.mutate({ id: editing.id, input })}
        onToggleStatus={(status) =>
          editing && update.mutate({ id: editing.id, input: { status } })}
      />
    </>
  );
}

/**
 * Editing state is stored as a single object tagged with the customer id it
 * belongs to: `{ customerId, limits }`.
 *
 * The dialog stays mounted between customers, and each customer's limits load
 * independently. Deriving what to render from `state.customerId === customer.id`
 * is what prevents a previous customer's draft from flashing under a new
 * customer's name while the new limits are still in flight. A separate
 * `baseline` holds the server values, so "dirty" is always measured against the
 * customer on screen rather than against whatever arrived last.
 */
interface DraftState {
  customerId: string;
  limits: Limits;
}

function CustomerDialog({ customer, isSelf, busy, onClose, onSave, onToggleStatus }: {
  customer: User | null;
  isSelf: boolean;
  busy: boolean;
  onClose: () => void;
  onSave: (input: { unlimitedMode?: boolean; allowLiveKeys?: boolean; role?: 'admin' | 'customer' }) => void;
  onToggleStatus: (status: 'active' | 'suspended') => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [error, setError] = useState('');

  const customerId = customer?.id ?? null;
  const limitsQuery = useQuery({
    queryKey: ['admin', 'limits', customerId],
    queryFn: () => api.admin.customerLimits(customerId as string),
    enabled: customerId !== null,
  });

  // The allowlist editor offers only models that actually exist, so an admin
  // cannot save a name that would 404 for the customer at request time.
  const modelsQuery = useQuery({ queryKey: ['models'], queryFn: api.models });
  const allModels = useMemo(
    () => ((modelsQuery.data?.models ?? []) as Model[]).filter((m) => m.enabled),
    [modelsQuery.data],
  );

  const serverLimits = limitsQuery.data?.limits ?? null;
  // The displayed draft is valid only when it was seeded for the customer
  // currently on screen. Anything else renders as "loading", never as stale.
  const draftForCustomer = draft && draft.customerId === customerId ? draft.limits : null;
  const baselineForCustomer = serverLimits;

  const saveLimits = useMutation({
    mutationFn: (target: { id: string; limits: Limits }) =>
      api.admin.setCustomerLimits(target.id, {
        requestsPerMinute: target.limits.requestsPerMinute,
        requestsPerDay: target.limits.requestsPerDay,
        tokensPerDay: target.limits.tokensPerDay,
        maxConcurrentRequests: target.limits.maxConcurrentRequests,
        // null means "every enabled model" and is sent explicitly rather than
        // omitted, so clearing an allowlist actually clears it server-side.
        allowedModels: target.limits.allowedModels,
      }),
    onSuccess: (res, vars) => {
      // The server echoes the persisted values; they become the new baseline,
      // so Save immediately becomes disabled again.
      setDraft({ customerId: vars.id, limits: res.limits });
      void qc.invalidateQueries({ queryKey: ['admin', 'limits', vars.id] });
      toast.push('success', 'Limits updated');
    },
    onError: (e) => setError(message(e)),
  });

  function setField(key: keyof Limits, value: string) {
    setDraft((d) => (d ? { ...d, limits: { ...d.limits, [key]: Number(value) } } : d));
  }

  /**
   * Toggles one model in the allowlist.
   *
   * The allowlist is tri-state, not a checkbox per model: `null` means "every
   * model" and the picker is inert. Turning on a restriction materializes the
   * current full list, so the customer does not silently lose access to
   * everything the admin did not tick.
   */
  function toggleModel(name: string) {
    setDraft((d) => {
      if (!d) return d;
      const current = d.limits.allowedModels;
      const base = current ?? allModels.map((m) => m.publicName);
      const next = base.includes(name) ? base.filter((m) => m !== name) : [...base, name];
      return { ...d, limits: { ...d.limits, allowedModels: next } };
    });
  }

  function setAllowAll(allowAll: boolean) {
    setDraft((d) => (d ? { ...d, limits: { ...d.limits, allowedModels: allowAll ? null : allModels.map((m) => m.publicName) } } : d));
  }

  /** Re-seeds the draft from freshly loaded server values. */
  function resetToServer(next: Limits, forId: string) {
    setDraft({ customerId: forId, limits: next });
    setError('');
  }

  /**
   * Seed the draft exactly once per (customer, server baseline) pair.
   *
   * Keying on the customer id AND the loaded values means: opening customer A
   * seeds A's limits, moving to customer B seeds B's, and a background refetch
   * that changes the baseline re-seeds so the form tracks the server. It also
   * means an in-flight edit is never clobbered, because the server values have
   * not changed while the admin is typing.
   */
  useEffect(() => {
    if (!customerId || !baselineForCustomer) return;
    setDraft((d) =>
      d && d.customerId === customerId && sameLimits(d.limits, baselineForCustomer)
        ? d
        : { customerId, limits: baselineForCustomer },
    );
  }, [customerId, baselineForCustomer]);

  const dirty = Boolean(
    draftForCustomer
    && baselineForCustomer
    && !sameLimits(draftForCustomer, baselineForCustomer),
  );

  // Hooks above run unconditionally; only the markup depends on the customer.
  if (!customer) return null;

  const limitFields: { key: keyof Limits; label: string; hint?: string }[] = [
    { key: 'requestsPerMinute', label: 'Requests per minute' },
    { key: 'requestsPerDay', label: 'Requests per day' },
    { key: 'tokensPerDay', label: 'Tokens per day' },
    { key: 'maxConcurrentRequests', label: 'Max concurrent requests' },
  ];

  return (
    <Dialog open onClose={onClose} title={`Manage ${customer.email}`}
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      {error && <Alert kind="error">{error}</Alert>}

      <h3 className="mt-2 mb-1">Account</h3>
      <div className="row wrap mb-2">
        <Button size="sm" loading={busy}
          onClick={() => onSave({ unlimitedMode: !customer.unlimitedMode })}>
          {customer.unlimitedMode ? 'Disable unlimited' : 'Enable unlimited'}
        </Button>
        <Button size="sm" loading={busy}
          onClick={() => onSave({ allowLiveKeys: !customer.allowLiveKeys })}>
          {customer.allowLiveKeys ? 'Revoke live keys' : 'Allow live keys'}
        </Button>
        {customer.role === 'customer' ? (
          <Button size="sm" loading={busy} onClick={() => onSave({ role: 'admin' })}>Make admin</Button>
        ) : (
          <Button size="sm" loading={busy} disabled={isSelf}
            title={isSelf ? 'You cannot remove your own admin role' : undefined}
            onClick={() => onSave({ role: 'customer' })}>
            Remove admin
          </Button>
        )}
      </div>

      {customer.status === 'active' ? (
        <Button size="sm" variant="danger" loading={busy} disabled={isSelf}
          title={isSelf ? 'You cannot suspend your own account' : undefined}
          onClick={() => onToggleStatus('suspended')}>
          Suspend account
        </Button>
      ) : (
        <Button size="sm" loading={busy} onClick={() => onToggleStatus('active')}>Reactivate account</Button>
      )}

      <h3 className="mt-3 mb-1">Rate limits</h3>
      {limitsQuery.isLoading || !baselineForCustomer ? (
        <Loading rows={2} label="Loading limits" />
      ) : !draftForCustomer ? (
        <div className="row-between">
          <p className="small muted mb-0">Could not read the current limits for this customer.</p>
          <Button size="sm" loading={limitsQuery.isFetching}
            onClick={() => resetToServer(baselineForCustomer, customer.id)}>
            Retry
          </Button>
        </div>
      ) : (
        <>
          <div className="grid grid-2">
            {limitFields.map((f) => (
              <Field key={f.key} label={f.label} id={`limit-${f.key}`} hint={f.hint}>
                <Input id={`limit-${f.key}`} type="number" min={1} value={draftForCustomer[f.key] ?? 0}
                  disabled={customer.unlimitedMode}
                  onChange={(e) => setField(f.key, e.target.value)} />
              </Field>
            ))}
          </div>
          <h3 className="mt-3 mb-1">Model access</h3>
          {modelsQuery.isLoading ? (
            <Loading rows={1} label="Loading models" />
          ) : allModels.length === 0 ? (
            <p className="small muted">
              No models are enabled, so there is nothing to allow yet.
            </p>
          ) : (
            <>
              <label className="checkbox-row mb-1">
                <input
                  type="radio"
                  name={`allowlist-mode-${customer.id}`}
                  checked={draftForCustomer.allowedModels === null}
                  onChange={() => setAllowAll(true)}
                />
                All models
              </label>
              <label className="checkbox-row mb-2">
                <input
                  type="radio"
                  name={`allowlist-mode-${customer.id}`}
                  checked={draftForCustomer.allowedModels !== null}
                  onChange={() => setAllowAll(false)}
                />
                Only selected models
              </label>

              {draftForCustomer.allowedModels !== null && (
                <div className="grid grid-2">
                  {allModels.map((m) => (
                    <label className="checkbox-row" key={m.id}>
                      <input
                        type="checkbox"
                        checked={draftForCustomer.allowedModels?.includes(m.publicName) ?? false}
                        onChange={() => toggleModel(m.publicName)}
                      />
                      <span className="mono">{m.publicName}</span>
                      <span className="small subtle">{m.provider}</span>
                    </label>
                  ))}
                </div>
              )}

              <p className="small subtle mt-1">
                {draftForCustomer.allowedModels === null
                  ? 'This customer can use every enabled model.'
                  : `This customer can use ${draftForCustomer.allowedModels.length} of ${allModels.length} models.`}
              </p>
            </>
          )}

          <div className="row-between mt-3">
            <span className="small subtle">
              {customer.unlimitedMode
                ? 'Unlimited mode is on, so these values are not enforced.'
                : 'Changes apply to every key belonging to this customer.'}
            </span>
            <span className="row">
              {dirty && (
                <Button size="sm" onClick={() => resetToServer(baselineForCustomer, customer.id)}>
                  Reset
                </Button>
              )}
              <Button variant="primary" size="sm" loading={saveLimits.isPending}
                disabled={customer.unlimitedMode || !dirty}
                onClick={() => saveLimits.mutate({ id: customer.id, limits: draftForCustomer })}>
                Save limits
              </Button>
            </span>
          </div>
        </>
      )}
    </Dialog>
  );
}

function sameLimits(a: Limits, b: Limits): boolean {
  return a.requestsPerMinute === b.requestsPerMinute
    && a.requestsPerDay === b.requestsPerDay
    && a.tokensPerDay === b.tokensPerDay
    && a.maxConcurrentRequests === b.maxConcurrentRequests
    // Compared as sets: reordering the picker is not an edit, and treating it
    // as one would leave Save permanently enabled.
    && sameModelSet(a.allowedModels, b.allowedModels);
}

/** null (all models) is distinct from an empty array (no models). */
function sameModelSet(a: string[] | null | undefined, b: string[] | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/* -------------------------------------------------------------- platform */

function PlatformTab() {
  const errors = useQuery({ queryKey: ['admin', 'errors'], queryFn: api.admin.errors });

  if (errors.isLoading) return <Loading rows={4} label="Loading errors" />;

  const list = (errors.data?.errors ?? []) as AdminError[];

  return (
    <Card title="Recent errors"
      actions={errors.isError ? <span className="small muted">{message(errors.error)}</span> : undefined}>
      {list.length === 0 ? (
        <EmptyState icon={<Icons.check size={20} />} title="No errors recorded"
          message="No failed requests have been recorded on this platform." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Request ID</th>
                <th>When</th>
                <th>Model</th>
                <th>Status</th>
                <th>Code</th>
                <th className="num">Latency</th>
              </tr>
            </thead>
            <tbody>
              {list.map((e) => (
                <tr key={e.requestId}>
                  <td className="mono truncate" style={{ maxWidth: 190 }} title={e.requestId}>
                    {e.requestId}
                  </td>
                  <td className="muted small" title={e.createdAt}>{relativeTime(e.createdAt)}</td>
                  <td className="mono">{e.model}</td>
                  <td>
                    <span className="badge badge-danger"><span className="dot" />{e.httpStatus}</span>
                  </td>
                  <td className="mono tiny">{e.errorCode ?? e.errorType ?? '—'}</td>
                  <td className="num">{formatMs(e.latencyMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/* ----------------------------------------------------------------- audit */

function AuditTab() {
  const audit = useQuery({ queryKey: ['admin', 'audit'], queryFn: api.admin.audit });

  if (audit.isLoading) return <Loading rows={5} label="Loading audit log" />;
  if (audit.isError) return <Alert kind="error">{message(audit.error)}</Alert>;

  const list = (audit.data?.entries ?? []) as AuditEntry[];

  if (list.length === 0) {
    return (
      <Card>
        <EmptyState icon={<Icons.shield size={20} />} title="No audit entries"
          message="Security-relevant actions such as key creation and admin changes are recorded here." />
      </Card>
    );
  }

  return (
    <Card title="Audit log">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>Resource</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>
            {list.map((a) => (
              <tr key={a.id}>
                <td className="muted small" title={a.createdAt}>{formatDateTime(a.createdAt)}</td>
                <td className="mono tiny">{a.action}</td>
                <td className="small">
                  {a.resourceType ?? '—'}
                  {a.resourceId ? <span className="subtle mono"> {a.resourceId.slice(0, 8)}</span> : ''}
                </td>
                <td className="mono tiny muted">{a.ip ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error';
}
