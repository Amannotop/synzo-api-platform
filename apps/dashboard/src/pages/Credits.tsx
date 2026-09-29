import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { formatDateTime, formatNumber } from '../lib/format';
import {
  Alert, Button, Card, Dialog, EmptyState, Field, Icons, Input, Loading, Stat,
} from '../components/ui';
import { useToast } from '../components/Toast';
import type { CreditPackage, PaymentRequest, PaymentStatus } from '../lib/types';

/**
 * Minor units back to a currency string. The API keeps money integral, so
 * nothing is ever rounded on the way in and this is the only place the
 * conversion happens.
 */
function money(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(amountMinor / 100);
  } catch {
    // An unknown currency code must not blank the price.
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}

const STATUS_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = {
  approved: 'success',
  rejected: 'danger',
  pending: 'warning',
  active: 'success',
  suspended: 'danger',
};

function PaymentBadge({ status }: { status: PaymentStatus | string }) {
  const tone = STATUS_TONE[status] ?? 'neutral';
  return <span className={`badge badge-${tone}`}><span className="dot" />{status}</span>;
}

/**
 * The account-status banner.
 *
 * Each state gets its own message because the customer's next action is
 * different in each: a pending account is waiting, a rejected one needs to
 * contact support, and neither of them should be shown a paywall. An account
 * out of credits IS shown the paywall. Showing the wrong one of the two is
 * actively misleading, so the banner is chosen from the server's reason rather
 * than from the balance alone.
 */
function AccessBanner({
  status,
  reason,
}: {
  status: string;
  reason: string | null;
}) {
  if (status === 'pending') {
    return (
      <Alert kind="warning">
        <strong>Your account is awaiting approval.</strong> An administrator reviews new
        accounts before API access is enabled. Your free trial is granted at that point,
        not now. You do not need to do anything.
      </Alert>
    );
  }
  if (status === 'rejected') {
    return (
      <Alert kind="error">
        <strong>This account was not approved.</strong> API access is disabled. If you
        believe this is a mistake, contact the platform operator.
      </Alert>
    );
  }
  if (status === 'suspended') {
    return (
      <Alert kind="error">
        <strong>This account is suspended.</strong> API access is disabled until an
        administrator reactivates it.
      </Alert>
    );
  }
  if (reason === 'credits_exhausted') {
    return (
      <Alert kind="warning">
        <strong>You have no credits left.</strong> API calls are refused until you buy
        more. Pick a package below to top up.
      </Alert>
    );
  }
  return null;
}

/** The customer's payment history, newest first. */
function PaymentHistory({ payments }: { payments: PaymentRequest[] }) {
  if (payments.length === 0) {
    return <EmptyState title="No payments yet" message="Payment claims you submit will appear here with their review status." />;
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Package</th>
            <th>Amount</th>
            <th>Credits</th>
            <th>Reference</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {payments.map((p) => (
            <tr key={p.id}>
              <td className="nowrap">{formatDateTime(p.createdAt)}</td>
              <td>{p.packageName}</td>
              <td className="nowrap">{money(p.amountMinor, p.currency)}</td>
              <td className="nowrap">{formatNumber(p.credits)}</td>
              <td><code className="mono">{p.reference}</code></td>
              <td>
                <PaymentBadge status={p.status} />
                {p.status === 'rejected' && p.reviewNote && (
                  <div className="hint" style={{ marginTop: 4 }}>{p.reviewNote}</div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The subscription term as a customer reads it.
 *
 * Weeks and months are the units people buy in, so a 7-day term is "1 week"
 * and 30 days is "1 month" rather than the number in the database. Only those
 * two are named; anything else falls back to days, which stays correct even
 * though it is less idiomatic.
 */
function termLabel(days: number): string {
  if (days === 7) return '1 week';
  if (days % 30 === 0 && days / 30 === 1) return '1 month';
  return `${days} days`;
}

export default function Credits() {
  const toast = useToast();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['credits'], queryFn: () => api.credits() });
  /**
   * The catalogue, so a tier can name the models it grants rather than showing
   * the raw public names. Shares the `['models']` key the Models page already
   * populates, so opening both does not cost a second request.
   */
  const models = useQuery({ queryKey: ['models'], queryFn: api.models });

  const modelLabel = (publicName: string): string => {
    const found = models.data?.models.find((m) => m.publicName === publicName);
    return found?.label ?? publicName;
  };

  const [selected, setSelected] = useState<CreditPackage | null>(null);
  const [email, setEmail] = useState('');
  /**
   * Whether the email has been confirmed for THIS package selection.
   *
   * The spec is explicit that the customer confirms the email BEFORE being
   * taken to the payment QR. Showing the QR and the email box together in one
   * form does not honour that ordering: someone who is not the account holder
   * can read the destination and walk away with it, and the confirmation reads
   * as a checkbox rather than a gate. So the QR is withheld until the address
   * is entered and accepted, and the whole panel resets when the dialog
   * closes so a new selection has to confirm again.
   */
  const [emailConfirmed, setEmailConfirmed] = useState(false);
  const [reference, setReference] = useState('');
  const [receipt, setReceipt] = useState<string | null>(null);
  const [receiptName, setReceiptName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error('Pick a package first');
      return api.submitPayment({
        packageId: selected.id,
        reference: reference.trim(),
        confirmedEmail: email.trim(),
        ...(receipt ? { receiptDataUrl: receipt } : {}),
      });
    },
    onSuccess: (res) => {
      // The balance has not moved — this only records a claim — so the view is
      // refetched to show the new PENDING row rather than to imply credits.
      void qc.invalidateQueries({ queryKey: ['credits'] });
      toast.push('success', 'Payment request submitted', 'An administrator will verify it before credits are added.');
      setSelected(null);
      setEmailConfirmed(false);
      setReference('');
      setReceipt(null);
      setReceiptName(null);
      if (fileRef.current) fileRef.current.value = '';
      void res;
    },
    onError: (err) => {
      toast.push('error', 'Could not submit payment', err instanceof Error ? err.message : '');
    },
  });

  if (query.isLoading) return <Loading rows={4} label="Loading credits" />;
  if (query.isError) {
    return <Alert kind="error">Could not load your credits. {query.error instanceof Error ? query.error.message : ''}</Alert>;
  }

  const { account, balance, packages, billing, payments } = query.data!;
  const exhausted = account.apiAccess.reason === 'credits_exhausted';
  const emailMismatch = email.trim().length > 0 && email.trim().toLowerCase() !== account.email.toLowerCase();
  const canSubmit = Boolean(selected) && emailConfirmed
    && email.trim().toLowerCase() === account.email.toLowerCase()
    && reference.trim().length > 0 && !submit.isPending;

  function onPick(pkg: CreditPackage) {
    setSelected(pkg);
    // Pre-filled so the common case is a glance and a continue, but still
    // requiring the deliberate confirm step before the QR is revealed.
    setEmail(account.email);
    setEmailConfirmed(false);
    setReference('');
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Credits</h1>
          <p>Your token balance, and how to add more when you run out.</p>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 16 }}>
        <AccessBanner status={account.status} reason={account.apiAccess.reason} />

        <div className="grid grid-4">
          <Stat
            label="Free credits left"
            value={formatNumber(balance.freeRemaining)}
            sub={balance.hasFreeTrial
              ? `${formatNumber(balance.freeUsed)} used of ${formatNumber(balance.freeGranted)}`
              : 'Not granted yet'}
          />
          <Stat label="Paid credits left" value={formatNumber(balance.paidRemaining)}
            sub={balance.paidGranted > 0 ? `${formatNumber(balance.paidUsed)} used of ${formatNumber(balance.paidGranted)}` : 'No purchases yet'} />
          <Stat label="Total available" value={formatNumber(balance.totalRemaining)}
            sub={balance.freeReserved + balance.paidReserved > 0
              ? `${formatNumber(balance.freeReserved + balance.paidReserved)} held by active requests`
              : 'Ready to spend'} />
          <Stat label="API access" value={account.apiAccess.allowed ? 'Enabled' : 'Blocked'}
            sub={account.status === 'active' ? undefined : `Account ${account.status}`} />
        </div>

        {exhausted && (
          <Card title="Top up your credits">
            {packages.length === 0 ? (
              <EmptyState
                title="No packages available"
                message="The operator has not published any credit packages yet. Please check back later."
              />
            ) : (
              <div className="grid grid-3">
                {packages.map((pkg) => (
                  <div key={pkg.id} className="card package-card">
                    <h3>{pkg.name}</h3>
                    {pkg.description && <p className="muted small">{pkg.description}</p>}
                    {/*
                     * Volume is the same on every tier, so it is stated once as a
                     * shared property rather than being a differentiator. What
                     * actually differs between the cards is model access and
                     * image support, and those are what the card is arranged to
                     * make comparable at a glance.
                     */}
                    <div className="package-volume">
                      <span className="package-volume-tick" aria-hidden="true">✓</span>
                      Unlimited requests
                    </div>
                    {/*
                     * What the package grants, not a token count. `allowedModels`
                     * is null for the top tier, which means every model rather
                     * than none, so it is described in words instead of counted.
                     */}
                    <div className="package-credits">
                      {pkg.allowedModels === null
                        ? 'All models'
                        : `${pkg.allowedModels.length} model${pkg.allowedModels.length === 1 ? '' : 's'}`}
                    </div>
                    <div className="muted small">
                      {pkg.allowedModels === null
                        ? 'Every model, including the top tier'
                        : pkg.allowedModels
                            .map((m) => modelLabel(m))
                            .join(' · ')}
                    </div>
                    {/*
                     * Image allowance, which is a total for the period and the
                     * second thing that differs between tiers. `null` is
                     * unlimited, which is a different claim from any number, so
                     * it is spelled out rather than rendered as a count.
                     */}
                    <div className="package-feature">
                      {pkg.imageLimit === null
                        ? 'Unlimited image uploads'
                        : `${pkg.imageLimit} image upload${pkg.imageLimit === 1 ? '' : 's'}`}
                      {pkg.durationDays !== null && (
                        <span className="package-term">
                          Valid for {termLabel(pkg.durationDays)}
                        </span>
                      )}
                    </div>
                    <div className="package-price">{money(pkg.priceMinor, pkg.currency)}</div>
                    <Button variant="primary" onClick={() => onPick(pkg)}>Pay {money(pkg.priceMinor, pkg.currency)}</Button>
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}

        <Card title="Payment history">
          <PaymentHistory payments={payments} />
        </Card>
      </div>

      <Dialog
        open={selected !== null}
        onClose={() => { if (!submit.isPending) { setSelected(null); setEmailConfirmed(false); } }}
        title={`Pay for ${selected?.name ?? ''}`}
        footer={
          <>
            <Button onClick={() => { setSelected(null); setEmailConfirmed(false); }} disabled={submit.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={submit.isPending}
              disabled={!canSubmit}
              onClick={() => submit.mutate()}
            >
              Submit payment claim
            </Button>
          </>
        }
      >
        {selected && (
          <div style={{ display: 'grid', gap: 14 }}>
            <div className="row-between wrap">
              <div>
                <div className="muted small">You are paying</div>
                <div style={{ fontSize: 22, fontWeight: 600 }}>{money(selected.priceMinor, selected.currency)}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="muted small">You will receive</div>
                {/*
                 * What the package actually grants, not the token guard behind
                 * it. The card already says "Unlimited requests", so quoting a
                 * token count here as the thing being bought contradicts it —
                 * and the term was missing entirely, which for a 7-day plan is
                 * the part a customer most needs to see before paying.
                 */}
                <div style={{ fontSize: 22, fontWeight: 600 }}>
                  {selected.allowedModels === null
                    ? 'Every model'
                    : `${selected.allowedModels.length} model${selected.allowedModels.length === 1 ? '' : 's'}`}
                </div>
                <div className="muted small" style={{ marginTop: 2 }}>
                  {selected.imageLimit === null
                    ? 'Unlimited image uploads'
                    : `${selected.imageLimit} image upload${selected.imageLimit === 1 ? '' : 's'}`}
                  {selected.durationDays !== null && ` · ${termLabel(selected.durationDays)}`}
                </div>
              </div>
            </div>

            {/*
             * Step 1: prove the account holder is the one paying. Until this is
             * satisfied the payment destination is not rendered at all.
             */}
            {!emailConfirmed ? (
              <div style={{ display: 'grid', gap: 12 }}>
                <Field
                  label="Confirm your email"
                  id="confirm-email"
                  hint={`Retype the address on your account (${account.email}) to confirm the payment is yours.`}
                  error={emailMismatch ? 'This does not match the email on your account.' : undefined}
                >
                  <Input
                    id="confirm-email"
                    type="email"
                    value={email}
                    autoComplete="email"
                    onChange={(e) => { setEmail(e.target.value); setEmailConfirmed(false); }}
                    aria-invalid={emailMismatch}
                  />
                </Field>
                <div>
                  <Button
                    variant="primary"
                    disabled={emailMismatch || email.trim().length === 0}
                    onClick={() => setEmailConfirmed(true)}
                  >
                    Continue to payment
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <Field
                  label="Confirm your email"
                  id="confirm-email"
                  hint="Confirmed. Change it to go back."
                >
                  <Input
                    id="confirm-email"
                    type="email"
                    value={email}
                    autoComplete="email"
                    onChange={(e) => { setEmail(e.target.value); setEmailConfirmed(false); }}
                  />
                </Field>

                {billing.configured && billing.qrCodeUrl ? (
                  <div className="qr-block">
                    <img src={billing.qrCodeUrl} alt={`Payment QR code for ${billing.paymentMethodLabel ?? selected.currency}`} width={200} height={200} />
                    {billing.paymentMethodLabel && <div className="muted small">{billing.paymentMethodLabel}</div>}
                  </div>
                ) : (
                  <Alert kind="warning">
                    The operator has not configured a payment QR code yet, so payments cannot
                    be completed right now. Please contact them.
                  </Alert>
                )}

                {billing.paymentInstructions && (
                  <div className="instructions">{billing.paymentInstructions}</div>
                )}

                <Field
                  label="Transaction reference"
                  id="reference"
                  hint="The reference from your payment, so the administrator can find it."
                >
                  <Input
                    id="reference"
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    placeholder="e.g. UPI-4821-9930"
                  />
                </Field>

                <Field label="Payment receipt" id="receipt"
                  hint="Optional. A screenshot helps the administrator verify faster.">
                  <input
                    ref={fileRef}
                    id="receipt"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      setReceiptName(file.name);
                      const reader = new FileReader();
                      reader.onload = () => setReceipt(typeof reader.result === 'string' ? reader.result : null);
                      reader.readAsDataURL(file);
                    }}
                  />
                  <div className="row wrap">
                    <Button onClick={() => fileRef.current?.click()} icon={<Icons.plus size={14} />}>
                      {receiptName ? 'Choose a different file' : 'Attach screenshot'}
                    </Button>
                    {receiptName && <span className="muted small">{receiptName}</span>}
                  </div>
                </Field>

                <Alert kind="info">
                  Submitting this form does <strong>not</strong> add credits yet. They are added
                  only after an administrator verifies the payment.
                </Alert>
              </>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}
