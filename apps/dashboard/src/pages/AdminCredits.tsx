import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { useToast } from '../components/Toast';
import { formatDate, formatDateTime, formatNumber } from '../lib/format';
import type {
  AdminCreditCustomer, CreditBalance, CreditPackage, PaymentRequest,
} from '../lib/types';
import {
  Alert, Button, Card, Dialog, EmptyState, Field, Icons, Input, Loading, Select, Stat, Textarea,
} from '../components/ui';

/* ------------------------------------------------------------- formatting */

function money(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency, maximumFractionDigits: 2,
    }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

const TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral' | 'accent'> = {
  active: 'success', approved: 'success', approved_payment: 'success',
  pending: 'warning', suspended: 'danger', rejected: 'danger',
};

function Badge({ value }: { value: string }) {
  return (
    <span className={`badge badge-${TONE[value] ?? 'neutral'}`}>
      <span className="dot" />{value.replace(/_/g, ' ')}
    </span>
  );
}

/** The words an operator needs on a ledger row, not a raw enum. */
const LEDGER_KIND: Record<string, string> = {
  free_trial_grant: 'Free trial granted',
  usage: 'API usage',
  reservation: 'Reserved in flight',
  reservation_release: 'Reservation released',
  manual_grant: 'Manual grant',
  manual_deduction: 'Manual deduction',
  purchase: 'Purchase',
  payment_reversal: 'Reversal',
};

/**
 * A ledger amount is always positive. The SIGN comes from the bucket plus the
 * kind, so this is where it is derived rather than shown as a bare number that
 * an operator has to interpret.
 */
function signed(entry: { kind: string; amount: number }): string {
  const out = entry.kind === 'usage' || entry.kind === 'manual_deduction' || entry.kind === 'payment_reversal';
  return `${out ? '−' : '+'}${formatNumber(entry.amount)}`;
}

/* ------------------------------------------------------------- balances */

function BalanceCells({ balance }: { balance: CreditBalance }) {
  const held = balance.freeReserved + balance.paidReserved;
  return (
    <>
      <td className="nowrap">
        {formatNumber(balance.freeRemaining)}
        {held > 0 && <div className="tiny muted">{formatNumber(held)} held</div>}
      </td>
      <td className="nowrap">{formatNumber(balance.paidRemaining)}</td>
      <td className="nowrap strong">{formatNumber(balance.totalRemaining)}</td>
    </>
  );
}

/* --------------------------------------------------------------- helpers */

/**
 * A short-lived dialog confirmation for an action whose result the operator
 * must be able to explain afterwards. Approving grants a real grant of tokens
 * and rejecting tells a customer their money did not arrive, so neither is a
 * single unguarded click.
 */
function useConfirm() {
  const [state, setState] = useState<{
    title: string; body: string; confirmLabel: string; danger: boolean;
    note?: { label: string; required?: boolean; placeholder?: string };
    run: (note: string) => Promise<void>;
  } | null>(null);
  const [note, setNote] = useState('');
  return {
    state,
    note,
    setNote,
    open: setState,
    close: () => { setState(null); setNote(''); },
    missingNote: Boolean(state?.note?.required) && note.trim().length === 0,
  };
}

/* ==================================================== customer list table */

function CustomerRow({ c, me, onOpen, onAction }: {
  c: AdminCreditCustomer;
  me: string | undefined;
  onOpen: (id: string) => void;
  onAction: (action: 'approve' | 'reject' | 'suspend' | 'reactivate', c: AdminCreditCustomer) => void;
}) {
  const self = c.id === me;
  return (
    <tr>
      <td>
        <div className="strong">{c.name}</div>
        <div className="tiny muted">{c.email}</div>
      </td>
      <td><Badge value={c.status} /></td>
      <td className="nowrap muted small">{formatDate(c.createdAt)}</td>
      <BalanceCells balance={c.balance} />
      <td className="nowrap">
        <div className="row" style={{ gap: 6 }}>
          <Button size="sm" onClick={() => onOpen(c.id)}>Details</Button>
          {/*
            An admin approving themselves is a no-op at best and a lockout at
            worst, and the server refuses it. Hiding the buttons keeps the
            action list honest about what is possible.
          */}
          {c.status === 'pending' && !self && (
            <>
              <Button size="sm" variant="primary" onClick={() => onAction('approve', c)}>Approve</Button>
              <Button size="sm" variant="danger" onClick={() => onAction('reject', c)}>Reject</Button>
            </>
          )}
          {c.status === 'active' && !self && (
            <Button size="sm" onClick={() => onAction('suspend', c)}>Suspend</Button>
          )}
          {c.status === 'suspended' && !self && (
            <Button size="sm" variant="primary" onClick={() => onAction('reactivate', c)}>Reactivate</Button>
          )}
        </div>
      </td>
    </tr>
  );
}

/* ==================================================== payments table */

function PaymentRow({ row, onReview }: {
  row: { payment: PaymentRequest; customer: { id: string; name: string; email: string } };
  onReview: (row: { payment: PaymentRequest; customer: { id: string; name: string; email: string } }) => void;
}) {
  const p = row.payment;
  return (
    <tr>
      <td>
        <div className="strong">{row.customer.name}</div>
        <div className="tiny muted">{row.customer.email}</div>
      </td>
      <td>
        <div>{p.packageName}</div>
        <div className="tiny muted">{formatNumber(p.credits)} credits</div>
      </td>
      <td className="nowrap strong">{money(p.amountMinor, p.currency)}</td>
      <td><code className="mono">{p.reference}</code></td>
      <td className="nowrap muted small">{formatDateTime(p.createdAt)}</td>
      <td>
        <div className="row wrap" style={{ gap: 6 }}>
          <Badge value={p.status} />
          {p.telegramStatus && p.telegramStatus !== 'sent' && (
            <span className="badge badge-warning" title="Telegram notification outcome">
              tg:{p.telegramStatus}
            </span>
          )}
        </div>
      </td>
      <td>
        <Button size="sm" onClick={() => onReview(row)}>Review</Button>
      </td>
    </tr>
  );
}

/** The exact shape `createPackage` accepts, so the dialog cannot drift. */
type NewPackageBody = {
  name: string;
  description?: string | null;
  credits: number;
  priceMinor: number;
  currency?: string;
  sortOrder?: number;
  active?: boolean;
};

/* ==================================================== package manager */

function PackagesPanel() {
  const toast = useToast();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['admin', 'credits', 'packages'], queryFn: () => api.adminCredits.packages() });
  const [editing, setEditing] = useState<CreditPackage | null>(null);
  const [creating, setCreating] = useState(false);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['admin', 'credits', 'packages'] });

  const save = useMutation({
    mutationFn: (input: { id?: string; body: NewPackageBody }) =>
      input.id ? api.adminCredits.updatePackage(input.id, input.body) : api.adminCredits.createPackage(input.body),
    onSuccess: () => { invalidate(); setEditing(null); setCreating(false); toast.push('success', 'Package saved'); },
    onError: (e) => toast.push('error', 'Could not save package', message(e)),
  });

  return (
    <Card
      title="Credit packages"
      actions={<Button variant="primary" size="sm" icon={<Icons.plus size={14} />} onClick={() => setCreating(true)}>New package</Button>}
    >
      {query.isLoading ? <Loading rows={2} /> : query.isError ? (
        <Alert kind="error">{message(query.error)}</Alert>
      ) : query.data!.packages.length === 0 ? (
        <EmptyState
          title="No packages yet"
          message="Customers see a paywall with nothing to buy until at least one package is published."
          action={<Button variant="primary" onClick={() => setCreating(true)}>Create the first package</Button>}
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Name</th><th>Credits</th><th>Price</th><th>Order</th><th>Visible</th><th /></tr>
            </thead>
            <tbody>
              {query.data!.packages.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div className="strong">{p.name}</div>
                    {p.description && <div className="tiny muted">{p.description}</div>}
                  </td>
                  <td className="nowrap">{formatNumber(p.credits)}</td>
                  <td className="nowrap">{money(p.priceMinor, p.currency)}</td>
                  <td className="nowrap muted">{p.sortOrder}</td>
                  <td><Badge value={p.active ? 'active' : 'suspended'} /></td>
                  <td><Button size="sm" onClick={() => setEditing(p)}>Edit</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(creating || editing) && (
        <PackageDialog
          pkg={editing}
          saving={save.isPending}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSave={(body) => save.mutate({ id: editing?.id, body })}
        />
      )}
    </Card>
  );
}

function PackageDialog({ pkg, saving, onClose, onSave }: {
  pkg: CreditPackage | null;
  saving: boolean;
  onClose: () => void;
  onSave: (body: NewPackageBody) => void;
}) {
  const [name, setName] = useState(pkg?.name ?? '');
  const [description, setDescription] = useState(pkg?.description ?? '');
  const [credits, setCredits] = useState(pkg ? String(pkg.credits) : '');
  // The admin types major units because that is how money is written; it is
  // converted to the integral minor units the API stores so rounding can never
  // happen server-side.
  const [price, setPrice] = useState(pkg ? (pkg.priceMinor / 100).toFixed(2) : '');
  const [currency, setCurrency] = useState(pkg?.currency ?? 'INR');
  const [sortOrder, setSortOrder] = useState(pkg ? String(pkg.sortOrder) : '0');
  const [active, setActive] = useState(pkg?.active ?? true);

  const priceMinor = Math.round(Number(price) * 100);
  const priceError = price !== '' && (!Number.isFinite(Number(price)) || priceMinor < 1)
    ? 'Enter a price of at least 0.01' : undefined;
  const creditsError = credits !== '' && (!Number.isInteger(Number(credits)) || Number(credits) < 1)
    ? 'Credits must be a whole number of at least 1' : undefined;
  const valid = name.trim().length > 0 && Number(credits) > 0 && priceMinor >= 1;

  return (
    <Dialog
      open
      onClose={onClose}
      title={pkg ? `Edit ${pkg.name}` : 'New credit package'}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button
            variant="primary" loading={saving} disabled={!valid}
            onClick={() => onSave({
              name: name.trim(),
              description: description.trim() || null,
              credits: Number(credits),
              priceMinor,
              currency: currency.trim().toUpperCase() || 'INR',
              sortOrder: Number(sortOrder) || 0,
              active,
            })}
          >
            {pkg ? 'Save changes' : 'Create package'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 14 }}>
        <Field label="Package name" id="pkg-name" hint="What the customer sees on the paywall.">
          <Input id="pkg-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Starter top-up" />
        </Field>
        <Field label="Description" id="pkg-desc">
          <Textarea id="pkg-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="grid grid-2">
          <Field label="Token credits" id="pkg-credits" error={creditsError}
            hint="How many credits this purchase adds.">
            <Input id="pkg-credits" inputMode="numeric" value={credits}
              onChange={(e) => setCredits(e.target.value.replace(/[^\d]/g, ''))} placeholder="500000" />
          </Field>
          <Field label={`Price (${currency || 'INR'})`} id="pkg-price" error={priceError}
            hint="Major units. Stored as integers, so no rounding happens.">
            <Input id="pkg-price" inputMode="decimal" value={price}
              onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ''))} placeholder="899.00" />
          </Field>
        </div>
        <div className="grid grid-2">
          <Field label="Currency" id="pkg-currency" hint="ISO code, e.g. INR or USD.">
            <Input id="pkg-currency" value={currency} maxLength={8}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
          </Field>
          <Field label="Sort order" id="pkg-order" hint="Lower numbers are shown first.">
            <Input id="pkg-order" inputMode="numeric" value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value.replace(/[^\d-]/g, ''))} />
          </Field>
        </div>
        <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span className="small">Visible to customers. Uncheck to retire it without deleting history.</span>
        </label>
      </div>
    </Dialog>
  );
}

/* ==================================================== billing settings */

function BillingPanel() {
  const toast = useToast();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['admin', 'credits', 'billing'], queryFn: () => api.adminCredits.billing() });

  const [instructions, setInstructions] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [currency, setCurrency] = useState('');
  /*
   * Which fields the operator has actually touched.
   *
   * This is the whole fix. The endpoint is a PATCH that treats an absent key as
   * "leave this alone", but the form used to send all three text fields on
   * every save. Two consequences followed, both of which a real operator hits
   * on their first save:
   *
   *  - Uploading a QR also wrote `paymentInstructions: null`, because the
   *     textarea had never been edited and still held its initial empty value.
   *     The instructions a customer needs in order to pay silently vanished.
   *  - `currency` was always sent too, and the schema requires a non-empty
   *     string, so a save that changed nothing else was rejected outright.
   *
   * A dirty-tracking form sends exactly what the operator edited. Keys left
   * `undefined` are dropped by JSON.stringify, so the server keeps its value.
   */
  const [touched, setTouched] = useState({ instructions: false, label: false, currency: false });
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrName, setQrName] = useState<string | null>(null);
  const [clearQr, setClearQr] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const billing = query.data?.billing ?? null;

  /*
   * Seed the inputs from the loaded settings once, when they first arrive.
   * Deliberately separate from the dirty tracking above: seeding makes the
   * boxes show what is actually stored, while the dirty flags guarantee that
   * seeding itself can never be mistaken for an edit. Without this the labels
   * would read as empty and a save would look like a deliberate deletion.
   */
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || query.isLoading) return;
    seeded.current = true;
    if (billing) {
      setInstructions(billing.paymentInstructions ?? '');
      setLabel(billing.paymentMethodLabel ?? '');
      setCurrency(billing.currency ?? '');
    }
  }, [query.isLoading, billing]);

  const save = useMutation({
    mutationFn: () =>
      api.adminCredits.updateBilling({
        // An emptied textarea is a deliberate removal, so a touched-and-cleared
        // field sends null rather than reading as untouched.
        ...(touched.instructions
          ? { paymentInstructions: instructions?.trim() ? instructions : null }
          : {}),
        ...(touched.label ? { paymentMethodLabel: label.trim() ? label : null } : {}),
        // Currency has no empty state -- the schema requires 1-8 characters --
        // so a touched-and-blank currency is reported below instead of 400ing.
        ...(touched.currency && currency.trim() ? { currency } : {}),
        // `null` REMOVES the QR, `undefined` leaves it alone. Those are different
        // operations and collapsing them would silently delete a customer's
        // payment destination the first time an instruction was edited.
        ...(clearQr ? { qrCodeUrl: null } : qrDataUrl ? { qrCodeUrl: qrDataUrl } : {}),
      }),
    onSuccess: () => {
      setQrDataUrl(null); setQrName(null); setClearQr(false);
      setTouched({ instructions: false, label: false, currency: false });
      if (fileRef.current) fileRef.current.value = '';
      void qc.invalidateQueries({ queryKey: ['admin', 'credits', 'billing'] });
      void qc.invalidateQueries({ queryKey: ['credits'] });
      toast.push('success', 'Payment settings saved', 'Customers see these the next time they open the paywall.');
    },
    onError: (e) => toast.push('error', 'Could not save payment settings', message(e)),
  });

  const mark = (field: keyof typeof touched) =>
    setTouched((t) => (t[field] ? t : { ...t, [field]: true }));

  // A touched-but-emptied currency is the one input state that cannot be sent.
  const currencyInvalid = touched.currency && !currency.trim();
  const nothingToSave =
    !touched.instructions && !touched.label && !touched.currency && !qrDataUrl && !clearQr;

  return (
    <Card title="Payment method">
      {query.isLoading ? <Loading rows={2} /> : (
        <div style={{ display: 'grid', gap: 14 }}>
          <div className="row wrap" style={{ gap: 20, alignItems: 'flex-start' }}>
            <div className="qr-block" style={{ minWidth: 190 }}>
              {billing?.qrCodeUrl ? (
                <img src={billing.qrCodeUrl} alt="Payment QR code customers scan" width={170} height={170} />
              ) : (
                <div className="qr-placeholder">No QR code</div>
              )}
              <div className="muted tiny" style={{ textAlign: 'center' }}>
                {billing?.paymentMethodLabel || 'No method label set'}
              </div>
            </div>
            <div style={{ flex: '1 1 280px', display: 'grid', gap: 12 }}>
              <Field label="Payment method label" id="bill-label"
                hint="Shown under the QR, e.g. 'UPI · 9xxxxx@ybl'.">
                <Input id="bill-label" value={label}
                  onChange={(e) => { setLabel(e.target.value); mark('label'); }} />
              </Field>
              <Field label="Default currency" id="bill-currency"
                hint="ISO code used for packages you create from here."
                error={currencyInvalid ? 'Enter a currency code, e.g. INR' : undefined}>
                <Input id="bill-currency" value={currency} maxLength={8}
                  placeholder="INR"
                  onChange={(e) => { setCurrency(e.target.value.toUpperCase()); mark('currency'); }} />
              </Field>
            </div>
          </div>

          <Field label="Payment instructions" id="bill-instructions"
            hint="Exactly what the customer must do after scanning. Leave blank to remove.">
            <Textarea id="bill-instructions" rows={5}
              placeholder="Scan the QR, pay the amount shown, then enter the UPI reference number below."
              value={instructions ?? ''}
              onChange={(e) => { setInstructions(e.target.value); mark('instructions'); }} />
          </Field>

          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setClearQr(false);
              setQrName(file.name);
              const reader = new FileReader();
              reader.onload = () => {
                if (typeof reader.result === 'string') { setQrDataUrl(reader.result); setQrName(file.name); }
              };
              reader.readAsDataURL(file);
            }} />

          <div className="row wrap">
            <Button icon={<Icons.plus size={14} />} onClick={() => fileRef.current?.click()}>
              {qrName ? `Replace with ${qrName}` : 'Upload QR code'}
            </Button>
            {clearQr ? (
              <span className="small" style={{ color: 'var(--danger)' }}>
                The QR will be removed when you save.
              </span>
            ) : billing?.qrCodeUrl ? (
              <Button variant="danger" onClick={() => { setClearQr(true); setQrDataUrl(null); }}>
                Remove QR code
              </Button>
            ) : null}
          </div>

          <Alert kind="info">
            The QR is stored on the server and rendered from there. The bot token and any
            payment credentials are never part of this page or any API response.
          </Alert>

          <div className="row">
            <Button
              variant="primary" loading={save.isPending} onClick={() => save.mutate()}
              disabled={nothingToSave || currencyInvalid}
            >
              Save payment settings
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/* ==================================================== customer detail */

function CustomerDetail({ id, onClose, onChanged }: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['admin', 'credits', 'customer', id], queryFn: () => api.adminCredits.customer(id) });
  const [adjusting, setAdjusting] = useState(false);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['admin', 'credits', 'customer', id] });
    onChanged();
  };

  const decision = useMutation({
    mutationFn: (v: { action: 'approve' | 'reject' | 'suspend' | 'reactivate'; note?: string }) => {
      if (v.action === 'approve') return api.adminCredits.approve(id, v.note);
      if (v.action === 'reject') return api.adminCredits.reject(id, v.note);
      return api.adminCredits.setStatus(id, v.action === 'suspend' ? 'suspended' : 'active');
    },
    onSuccess: (res, v) => {
      refresh();
      /*
       * Approval can be a REPLAY — a second click on an already-approved
       * account. The server grants nothing and says so, and the message has to
       * say the same thing, or the operator will believe they topped the
       * customer up twice.
       */
      if (v.action === 'approve' && 'alreadyTrialed' in res && res.alreadyTrialed) {
        toast.push('info', 'Already approved', 'No additional credits were granted. The free trial is one-time.');
      } else {
        toast.push('success', `Account ${v.action === 'reactivate' ? 'reactivated' : v.action === 'suspend' ? 'suspended' : v.action + 'd'}`);
      }
    },
    onError: (e) => toast.push('error', 'Action failed', message(e)),
  });

  const adjust = useMutation({
    mutationFn: (v: { bucket: 'free' | 'paid'; direction: 'add' | 'deduct'; amount: number; reason: string }) =>
      api.adminCredits.adjust(id, v),
    onSuccess: () => {
      refresh();
      setAdjusting(false);
      toast.push('success', 'Adjustment recorded', 'It is now a permanent line in the ledger.');
    },
    onError: (e) => toast.push('error', 'Adjustment failed', message(e)),
  });

  if (query.isLoading) return <Loading rows={4} label="Loading account" />;
  if (query.isError || !query.data) {
    return <Alert kind="error">Could not load that account. {message(query.error)}</Alert>;
  }

  const { customer, balance, ledger, payments } = query.data;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Card
        title={<>Customer · {customer.name}</>}
        actions={
          <>
            <Button size="sm" icon={<Icons.close size={14} />} onClick={onClose}>Close</Button>
            <Button size="sm" variant="primary" onClick={() => setAdjusting(true)}>Adjust credits</Button>
          </>
        }
      >
        <div className="grid grid-2 mb-3">
          <dl className="kv">
            <dt>Email</dt><dd>{customer.email}</dd>
            <dt>Role</dt><dd>{customer.role}</dd>
            <dt>Status</dt><dd><Badge value={customer.status} /></dd>
            <dt>Registered</dt><dd>{formatDate(customer.createdAt)}</dd>
          </dl>
          <div className="row wrap" style={{ gap: 8, alignItems: 'flex-start' }}>
            {customer.status === 'pending' && (
              <>
                <Button variant="primary" loading={decision.isPending}
                  onClick={() => decision.mutate({ action: 'approve' })}>Approve &amp; grant trial</Button>
                <Button variant="danger" loading={decision.isPending}
                  onClick={() => decision.mutate({ action: 'reject' })}>Reject</Button>
              </>
            )}
            {customer.status === 'active' && (
              <Button loading={decision.isPending}
                onClick={() => decision.mutate({ action: 'suspend' })}>Suspend account</Button>
            )}
            {customer.status === 'suspended' && (
              <Button variant="primary" loading={decision.isPending}
                onClick={() => decision.mutate({ action: 'reactivate' })}>Reactivate</Button>
            )}
          </div>
        </div>

        <div className="grid grid-4">
          <Stat label="Free left" value={formatNumber(balance.freeRemaining)}
            sub={balance.hasFreeTrial ? `${formatNumber(balance.freeUsed)} of ${formatNumber(balance.freeGranted)} used` : 'No trial granted'} />
          <Stat label="Paid left" value={formatNumber(balance.paidRemaining)}
            sub={balance.paidGranted > 0 ? `${formatNumber(balance.paidGranted)} purchased` : 'Never purchased'} />
          <Stat label="Total left" value={formatNumber(balance.totalRemaining)}
            sub={balance.freeReserved + balance.paidReserved > 0
              ? `${formatNumber(balance.freeReserved + balance.paidReserved)} in flight` : 'Available'} />
          <Stat label="Payments" value={String(payments.length)}
            sub={payments.length > 0 ? `${payments.filter((p) => p.status === 'pending').length} pending` : 'None yet'} />
        </div>
      </Card>

      <Card title="Credit ledger">
        {ledger.length === 0 ? <EmptyState title="No movements" message="Nothing has been granted to or spent by this account." /> : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>When</th><th>Type</th><th>Pool</th><th>Amount</th><th>Balance</th><th>Reason</th></tr>
              </thead>
              <tbody>
                {ledger.map((e) => (
                  <tr key={e.id}>
                    <td className="nowrap muted small">{formatDateTime(e.createdAt)}</td>
                    <td>{LEDGER_KIND[e.kind] ?? e.kind.replace(/_/g, ' ')}</td>
                    <td><span className={`badge badge-${e.bucket === 'free' ? 'accent' : 'neutral'}`}>{e.bucket}</span></td>
                    <td className={`nowrap strong ${signed(e).startsWith('−') ? 'neg' : 'pos'}`}>{signed(e)}</td>
                    <td className="nowrap muted">{formatNumber(e.balanceAfter)}</td>
                    <td className="small muted">
                      {e.reason || '—'}
                      {e.actorUserId && <div className="tiny subtle">by administrator</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {adjusting && (
        <AdjustDialog
          balance={balance}
          saving={adjust.isPending}
          onClose={() => setAdjusting(false)}
          onSave={(v) => adjust.mutate(v)}
        />
      )}
    </div>
  );
}

function AdjustDialog({ balance, saving, onClose, onSave }: {
  balance: CreditBalance;
  saving: boolean;
  onClose: () => void;
  onSave: (v: { bucket: 'free' | 'paid'; direction: 'add' | 'deduct'; amount: number; reason: string }) => void;
}) {
  const [bucket, setBucket] = useState<'free' | 'paid'>('paid');
  const [direction, setDirection] = useState<'add' | 'deduct'>('add');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');

  const n = Number(amount);
  const amountError = amount !== '' && (!Number.isInteger(n) || n < 1)
    ? 'Enter a whole number of at least 1' : undefined;
  const available = bucket === 'free' ? balance.freeRemaining : balance.paidRemaining;
  const overdraw = direction === 'deduct' && Number.isInteger(n) && n > available;
  const valid = n >= 1 && Number.isInteger(n) && reason.trim().length >= 3 && !overdraw;

  return (
    <Dialog
      open onClose={onClose} title="Adjust credits"
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" loading={saving} disabled={!valid} onClick={() => onSave({
            bucket, direction, amount: n, reason: reason.trim(),
          })}>Record adjustment</Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 14 }}>
        <Alert kind="info">
          Every adjustment is written to the ledger with your name against it and cannot be
          edited afterwards. The reason is required.
        </Alert>
        <div className="grid grid-2">
          <Field label="Pool" id="adj-bucket">
            <Select id="adj-bucket" value={bucket} onChange={(e) => setBucket(e.target.value as 'free' | 'paid')}>
              <option value="paid">Paid (purchased)</option>
              <option value="free">Free (trial)</option>
            </Select>
          </Field>
          <Field label="Direction" id="adj-dir">
            <Select id="adj-dir" value={direction} onChange={(e) => setDirection(e.target.value as 'add' | 'deduct')}>
              <option value="add">Add</option>
              <option value="deduct">Deduct</option>
            </Select>
          </Field>
        </div>
        <Field label="Token credits" id="adj-amount" error={amountError}
          hint={`${formatNumber(available)} available in the ${bucket} pool.`}>
          <Input id="adj-amount" inputMode="numeric" value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))} placeholder="10000" />
        </Field>
        {overdraw && (
          <Alert kind="error">
            The {bucket} pool only holds {formatNumber(available)} credits, so this deduction would
            go negative. Deduct less, or add credits first.
          </Alert>
        )}
        <Field label="Reason" id="adj-reason" hint="Recorded permanently. At least 3 characters.">
          <Textarea id="adj-reason" rows={3} value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Goodwill credit for reported 502s on 27 Sep" />
        </Field>
      </div>
    </Dialog>
  );
}

/* ==================================================== payment review */

function PaymentReview({ row, onClose, onChanged }: {
  row: { payment: PaymentRequest; customer: { id: string; name: string; email: string } };
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const p = row.payment;
  const [note, setNote] = useState('');
  const [receiptOpen, setReceiptOpen] = useState(false);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['admin', 'credits', 'payments'] });
    onChanged();
  };

  const decide = useMutation({
    mutationFn: (v: { action: 'approve' | 'reject'; note?: string }) =>
      v.action === 'approve' ? api.adminCredits.approvePayment(p.id, v.note) : api.adminCredits.rejectPayment(p.id, v.note ?? ''),
    onSuccess: (res, v) => {
      refresh();
      if (v.action === 'approve') {
        /*
         * `replayed` means this payment was ALREADY approved. The server
         * allocated nothing this time and so must this message, or a double
         * click will look like a second top-up.
         */
        if ('replayed' in res && res.replayed) {
          toast.push('info', 'Already approved', 'This payment was reviewed earlier. No credits were added again.');
        } else {
          toast.push('success', 'Payment approved',
            `${formatNumber(p.credits)} credits added to ${row.customer.email}.`);
        }
      } else {
        toast.push('success', 'Payment rejected', 'The customer can see the reason on their credits page.');
      }
      onClose();
    },
    onError: (e) => toast.push('error', 'Could not review payment', message(e)),
  });

  const retryTelegram = useMutation({
    mutationFn: () => api.adminCredits.retryTelegram(p.id),
    onSuccess: (res) => {
      refresh();
      toast.push(res.sent ? 'success' : 'error',
        res.sent ? 'Telegram notification sent' : 'Telegram send failed',
        res.sent ? undefined : (res.error ?? 'Check the bot token and chat id in the server environment.'));
    },
    onError: (e) => toast.push('error', 'Retry failed', message(e)),
  });

  const decided = p.status !== 'pending';

  return (
    <Dialog
      open onClose={onClose} title="Review payment"
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button loading={retryTelegram.isPending} onClick={() => retryTelegram.mutate()}>
            Resend Telegram
          </Button>
          {!decided && (
            <>
              <Button variant="danger" loading={decide.isPending} disabled={note.trim().length < 3}
                onClick={() => decide.mutate({ action: 'reject', note: note.trim() })}>Reject</Button>
              <Button variant="primary" loading={decide.isPending}
                onClick={() => decide.mutate({ action: 'approve', note: note.trim() || undefined })}>
                Approve &amp; add {formatNumber(p.credits)} credits
              </Button>
            </>
          )}
        </>
      }
    >
      <div style={{ display: 'grid', gap: 14 }}>
        <div className="row-between wrap">
          <div>
            <div className="strong">{row.customer.name}</div>
            <div className="muted small">{row.customer.email}</div>
          </div>
          <Badge value={p.status} />
        </div>

        <dl className="kv">
          <dt>Package</dt><dd>{p.packageName} — {formatNumber(p.credits)} credits</dd>
          <dt>Amount</dt><dd className="strong">{money(p.amountMinor, p.currency)}</dd>
          <dt>Reference</dt><dd><code className="mono">{p.reference}</code></dd>
          <dt>Submitted</dt><dd>{formatDateTime(p.createdAt)}</dd>
          {p.reviewedAt && (<><dt>Reviewed</dt><dd>{formatDateTime(p.reviewedAt)}</dd></>)}
          <dt>Telegram</dt>
          <dd>
            {p.telegramStatus ?? 'not attempted'}
            {p.telegramStatus && p.telegramStatus !== 'sent' && (
              <div className="tiny muted">
                Use “Resend Telegram” above — the claim is safe either way, the notification is not required for it.
              </div>
            )}
          </dd>
        </dl>

        {p.hasReceipt && (
          <div>
            <div className="label">Payment screenshot</div>
            {receiptOpen ? (
              <div className="qr-block">
                <img src={api.adminCredits.receiptUrl(p.id)} alt="Submitted payment receipt"
                  style={{ maxWidth: '100%', borderRadius: 8 }} />
                <Button size="sm" onClick={() => setReceiptOpen(false)}>Hide</Button>
              </div>
            ) : (
              <Button size="sm" onClick={() => setReceiptOpen(true)}>View receipt</Button>
            )}
          </div>
        )}

        {decided ? (
          p.reviewNote
            ? <Alert kind="info"><strong>Review note:</strong> {p.reviewNote}</Alert>
            : <Alert kind="info">This payment was already {p.status}. Credits are only ever added once.</Alert>
        ) : (
          <>
            <Field label="Review note" id="rev-note"
              hint="Required to reject, optional to approve. The customer sees this.">
              <Textarea id="rev-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="Verified against the bank statement." />
            </Field>
            <Alert kind="warning">
              Approving adds {formatNumber(p.credits)} paid credits to this account. This is
              irreversible from the dashboard, and a repeated approval will not add them twice.
            </Alert>
          </>
        )}
      </div>
    </Dialog>
  );
}

/* ============================================================== the page */

const TABS = [
  { id: 'customers', label: 'Customers' },
  { id: 'payments', label: 'Payments' },
  { id: 'packages', label: 'Packages' },
  { id: 'billing', label: 'Payment method' },
] as const;
type Tab = (typeof TABS)[number]['id'];

export default function AdminCredits() {
  const { user: me } = useAuth();
  const [tab, setTab] = useState<Tab>('customers');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [review, setReview] = useState<{ payment: PaymentRequest; customer: { id: string; name: string; email: string } } | null>(null);
  const [paymentStatus, setPaymentStatus] = useState('');
  const confirm = useConfirm();
  const toast = useToast();

  // Debounced so typing a name does not fire a query per keystroke, while
  // still feeling immediate.
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const customers = useQuery({
    queryKey: ['admin', 'credits', 'customers', q],
    queryFn: () => api.adminCredits.customers({ limit: 100, q: q || undefined }),
  });
  const payments = useQuery({
    queryKey: ['admin', 'credits', 'payments', paymentStatus],
    queryFn: () => api.adminCredits.payments(paymentStatus || undefined),
    enabled: tab === 'payments',
  });

  const refreshAll = () => {
    void customers.refetch();
    void payments.refetch();
  };

  const onAction = (action: 'approve' | 'reject' | 'suspend' | 'reactivate', c: AdminCreditCustomer) => {
    const copy = {
      approve: {
        title: `Approve ${c.name}?`,
        body: 'This activates their account and grants the one-time free trial. It is granted once per customer, so approving again will not add more.',
        label: 'Approve & grant trial', danger: false,
      },
      reject: {
        title: `Reject ${c.name}?`,
        body: 'Their API access stays blocked. No credits are added. You can change this later.',
        label: 'Reject account', danger: true,
        note: { label: 'Reason (optional)', placeholder: 'Incomplete application' },
      },
      suspend: {
        title: `Suspend ${c.name}?`,
        body: 'API access stops immediately. Their credits are untouched and reactivating never re-grants the trial.',
        label: 'Suspend', danger: true,
      },
      reactivate: {
        title: `Reactivate ${c.name}?`,
        body: 'API access resumes with the balances they already have.',
        label: 'Reactivate', danger: false,
      },
    }[action];

    confirm.open({
      title: copy.title, body: copy.body, confirmLabel: copy.label, danger: copy.danger,
      ...(copy.note ? { note: copy.note } : {}),
      run: async (note) => {
        if (action === 'approve') {
          const res = await api.adminCredits.approve(c.id, note.trim() || undefined);
          refreshAll();
          /*
           * A REPLAY: the account was already approved, so the server granted
           * nothing this time. Saying "approved" here would leave an operator
           * believing they had topped the customer up a second time.
           */
          if (res.alreadyTrialed) {
            toast.push('info', 'Already approved', 'No additional credits were granted. The free trial is one-time.');
          } else {
            toast.push('success', `${c.name} approved`, `${formatNumber(res.trialTokens)} free credits granted.`);
          }
          return;
        }
        if (action === 'reject') {
          await api.adminCredits.reject(c.id, note.trim() || undefined);
        } else {
          await api.adminCredits.setStatus(c.id, action === 'suspend' ? 'suspended' : 'active');
        }
        refreshAll();
        toast.push('success',
          `${c.name} ${action === 'reactivate' ? 'reactivated' : action === 'suspend' ? 'suspended' : 'rejected'}`);
      },
    });
  };

  const list = customers.data?.customers ?? [];
  const pendingCount = list.filter((c) => c.status === 'pending').length;
  const totals = useMemo(() => ({
    free: list.reduce((s, c) => s + c.balance.freeRemaining, 0),
    paid: list.reduce((s, c) => s + c.balance.paidRemaining, 0),
  }), [list]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Credits &amp; billing</h1>
          <p>
            Approve accounts, grant the one-time free trial, verify payments, and configure what
            customers can buy.
          </p>
        </div>
      </div>

      <div className="tabs mb-3" role="tablist" style={{ maxWidth: 560 }}>
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id}
            className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === 'customers' && pendingCount > 0 && (
              <span className="badge badge-warning" style={{ marginLeft: 6 }}>{pendingCount}</span>
            )}
          </button>
        ))}
      </div>

      {tab === 'customers' && (
        <div style={{ display: 'grid', gap: 16 }}>
          <div className="grid grid-3">
            <Stat label="Awaiting approval" value={String(pendingCount)}
              sub={pendingCount > 0 ? 'These accounts cannot use the API' : 'Nothing waiting'} />
            <Stat label="Free credits outstanding" value={formatNumber(totals.free)} sub="Across listed accounts" />
            <Stat label="Paid credits outstanding" value={formatNumber(totals.paid)} sub="Purchased, unspent" />
          </div>

          <Card
            title="Customers"
            actions={
              <div className="search-box">
                <Icons.search size={14} />
                <input value={search} onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name or email" aria-label="Search customers by name or email" />
                {search && <button className="icon-btn" aria-label="Clear search" onClick={() => setSearch('')}>
                  <Icons.close size={13} />
                </button>}
              </div>
            }
          >
            {customers.isLoading ? <Loading rows={4} /> : customers.isError ? (
              <Alert kind="error">{message(customers.error)}</Alert>
            ) : list.length === 0 ? (
              <EmptyState
                title={q ? 'No matching customers' : 'No customers yet'}
                message={q
                  ? `Nothing matches “${q}”. Check the spelling, or search the full email address.`
                  : 'Accounts will appear here as they register.'}
              />
            ) : (
              <>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr><th>Customer</th><th>Status</th><th>Joined</th>
                        <th>Free</th><th>Paid</th><th>Total</th><th /></tr>
                    </thead>
                    <tbody>
                      {list.map((c) => (
                        <CustomerRow key={c.id} c={c} me={me?.id} onOpen={setOpenId} onAction={onAction} />
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="tiny muted" style={{ marginTop: 10 }}>
                  {q
                    ? `${customers.data!.matched} matching of ${customers.data!.total} accounts`
                    : `${customers.data!.total} accounts`}
                  {q && customers.data!.matched > list.length && ' — narrow the search to see the rest'}
                </div>
              </>
            )}
          </Card>
        </div>
      )}

      {tab === 'payments' && (
        <Card
          title="Payment requests"
          actions={
            <div className="segmented">
              {['', 'pending', 'approved', 'rejected'].map((s) => (
                <button key={s || 'all'} className={paymentStatus === s ? 'active' : ''}
                  onClick={() => setPaymentStatus(s)}>
                  {s || 'All'}
                </button>
              ))}
            </div>
          }
        >
          {payments.isLoading ? <Loading rows={4} /> : payments.isError ? (
            <Alert kind="error">{message(payments.error)}</Alert>
          ) : payments.data!.payments.length === 0 ? (
            <EmptyState
              title="Nothing here"
              message={paymentStatus
                ? `No ${paymentStatus} payment requests.`
                : 'Customers appear here the moment they submit a claim. Nothing is granted until you approve it.'}
            />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Customer</th><th>Package</th><th>Amount</th><th>Reference</th>
                    <th>Submitted</th><th>Status</th><th /></tr>
                </thead>
                <tbody>
                  {payments.data!.payments.map((row) => (
                    <PaymentRow key={row.payment.id} row={row} onReview={setReview} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'packages' && <PackagesPanel />}
      {tab === 'billing' && <BillingPanel />}

      {/* The detail view replaces the list in place, so the operator keeps their
          scroll position and the search they typed when they come back. */}
      {openId && (
        <Dialog open onClose={() => setOpenId(null)} title="Account details"
          footer={<Button onClick={() => setOpenId(null)}>Close</Button>}>
          <CustomerDetail id={openId} onClose={() => setOpenId(null)} onChanged={refreshAll} />
        </Dialog>
      )}

      {review && (
        <PaymentReview row={review} onClose={() => setReview(null)} onChanged={refreshAll} />
      )}

      {confirm.state && (
        <Dialog
          open onClose={confirm.close} title={confirm.state.title}
          footer={
            <>
              <Button onClick={confirm.close}>Cancel</Button>
              <Button variant={confirm.state.danger ? 'danger' : 'primary'}
                disabled={confirm.missingNote} onClick={() => void confirm.state!.run(confirm.note)}>
                {confirm.state.confirmLabel}
              </Button>
            </>
          }
        >
          <div style={{ display: 'grid', gap: 12 }}>
            <p className="muted" style={{ margin: 0 }}>{confirm.state.body}</p>
            {confirm.state.note && (
              <Field label={confirm.state.note.label} id="confirm-note"
                {...(confirm.state.note.required ? { error: confirm.missingNote ? 'A reason is required' : undefined } : {})}>
                <Textarea id="confirm-note" rows={3} value={confirm.note}
                  placeholder={confirm.state.note.placeholder}
                  onChange={(e) => confirm.setNote(e.target.value)} />
              </Field>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
