import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { useTheme } from '../lib/ThemeContext';
import { useToast } from '../components/Toast';
import { formatDateTime, formatNumber } from '../lib/format';
import {
  Alert, Button, Card, Dialog, Field, Icons, Input, Loading, StatusBadge,
} from '../components/ui';

/** Limits are admin-configured, so a customer only ever reads them. */
function limitText(value: number | null | undefined, unlimited: boolean): string {
  if (unlimited) return 'Unlimited';
  if (value === null || value === undefined) return '—';
  return formatNumber(value);
}

/** Clamped to 100 so an overage bar still renders at full width. */
function quotaPercent(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

export default function Settings() {
  const { user, limits, tokensToday, refresh } = useAuth();
  const { theme, toggle } = useTheme();
  const qc = useQueryClient();
  const toast = useToast();
  const [passwordOpen, setPasswordOpen] = useState(false);

  if (!user || !limits) return <Loading rows={3} label="Loading settings" />;

  const quotaPct = quotaPercent(tokensToday, limits.tokensPerDay);
  const quotaNearLimit = quotaPct >= 80;

  const changePassword = useMutation({
    mutationFn: (input: { currentPassword: string; newPassword: string }) =>
      api.changePassword(input),
    onSuccess: () => {
      // The server clears the session on a password change, so the local
      // session is gone too. Re-read the state and send the user to sign in.
      void qc.clear();
      void refresh();
      toast.push('success', 'Password changed', 'Sign in again with your new password.');
    },
    onError: (err) => toast.push('error', 'Could not change password', message(err)),
  });

  const resendVerification = useMutation({
    mutationFn: () => api.resendVerification(),
    onSuccess: (res) => {
      toast.push(
        'success',
        res.resent ? 'Verification email sent' : 'Already verified',
        res.resent
          ? `Check ${user?.email} for a new confirmation link.`
          : 'This address is already confirmed.',
      );
      if (res.emailVerified) void refresh();
    },
    onError: (err) => toast.push('error', 'Could not send the email', message(err)),
  });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Your account, your current limits and how the dashboard looks.</p>
        </div>
      </div>

      {!user.emailVerified && (
        <Alert kind="warning">
          <div className="row-between wrap">
            <span>
              Your email address is <strong>not verified</strong>. Some features stay locked until
              you confirm <span className="inline-code">{user.email}</span>.
            </span>
            <Button
              onClick={() => resendVerification.mutate()}
              loading={resendVerification.isPending}
            >
              Resend email
            </Button>
          </div>
        </Alert>
      )}

      <div className="grid grid-2">
        <Card title="Account">
          <dl className="kv">
            <dt>Name</dt><dd>{user.name}</dd>
            <dt>Email</dt><dd className="mono">{user.email}</dd>
            <dt>Role</dt>
            <dd>
              {user.role === 'admin'
                ? <span className="badge badge-accent">admin</span>
                : <span className="badge badge-neutral">customer</span>}
            </dd>
            <dt>Status</dt><dd><StatusBadge status={user.status} /></dd>
            <dt>Email verified</dt>
            <dd>{user.emailVerified ? 'Yes' : 'Not yet'}</dd>
            <dt>Registered</dt><dd>{formatDateTime(user.createdAt)}</dd>
            <dt>Last sign-in</dt><dd>{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : '—'}</dd>
          </dl>

          {user.role !== 'admin' && (
            <div className="row wrap mt-3">
              <Button icon={<Icons.key size={14} />} onClick={() => setPasswordOpen(true)}>
                Change password
              </Button>
            </div>
          )}
        </Card>

        <Card title="Appearance">
          <div className="row-between">
            <div>
              <div className="strong">Theme</div>
              <p className="small muted mb-0 mt-1">
                Currently using the <strong>{theme}</strong> theme. Without a saved choice the
                dashboard follows your system setting.
              </p>
            </div>
            <Button onClick={toggle} icon={theme === 'dark' ? <Icons.sun size={14} /> : <Icons.moon size={14} />}>
              Switch to {theme === 'dark' ? 'light' : 'dark'}
            </Button>
          </div>
        </Card>

        <Card title="Your limits" bodyClass="card-body">
          <p className="small muted">
            These limits are set by your platform administrator. They apply to all of your API keys
            combined, so adding a key never multiplies your allowance.
          </p>

          {!user.unlimitedMode && (
            <div className="quota-meter">
              <div className="row-between">
                <span className="small muted">Tokens used today</span>
                <span className="small mono">
                  {formatNumber(tokensToday)} / {formatNumber(limits.tokensPerDay)}
                </span>
              </div>
              <div className="meter-track" role="progressbar"
                aria-valuenow={Math.min(100, Math.round((tokensToday / limits.tokensPerDay) * 100))}
                aria-valuemin={0} aria-valuemax={100}
                aria-label="Daily token quota used">
                <div
                  className={`meter-fill ${quotaNearLimit ? 'meter-warn' : ''}`}
                  style={{ width: `${quotaPct}%` }}
                />
              </div>
              <span className="small subtle">Resets at midnight UTC.</span>
            </div>
          )}

          <dl className="kv">
            <dt>Requests per minute</dt>
            <dd>{limitText(limits.requestsPerMinute, user.unlimitedMode)}</dd>
            <dt>Requests per day</dt>
            <dd>{limitText(limits.requestsPerDay, user.unlimitedMode)}</dd>
            <dt>Tokens per day</dt>
            <dd>{limitText(limits.tokensPerDay, user.unlimitedMode)}</dd>
            <dt>Max concurrent</dt>
            <dd>{limitText(limits.maxConcurrentRequests, user.unlimitedMode)}</dd>
            <dt>Allowed models</dt>
            <dd>{describeModels(limits.allowedModels)}</dd>
          </dl>

          {user.unlimitedMode && (
            <Alert kind="info">
              Your account has unlimited mode enabled, so rate and quota limits do not apply.
              Usage is still recorded.
            </Alert>
          )}

          {!user.allowLiveKeys && user.role !== 'admin' && (
            <Alert kind="info">
              Live keys (<span className="inline-code">sk_live_</span>) are not enabled for your
              account yet. You can create test keys from the API Keys page.
            </Alert>
          )}
        </Card>

        <Card title="Security">
          <ul className="small muted" style={{ paddingLeft: 20, margin: 0 }}>
            <li>Your API key secrets are shown once at creation and cannot be retrieved again.</li>
            <li>Passwords are stored as salted scrypt hashes, never in plaintext.</li>
            <li>Sessions are stored server-side in an httpOnly cookie.</li>
            <li>Request and response content is not stored.</li>
            <li>Password reset links are single-use and expire after 60 minutes.</li>
          </ul>
        </Card>
      </div>

      <PasswordDialog
        open={passwordOpen}
        onClose={() => setPasswordOpen(false)}
        busy={changePassword.isPending}
        onSubmit={(input) => changePassword.mutate(input)}
      />
    </>
  );
}

function PasswordDialog({ open, onClose, onSubmit, busy }: {
  open: boolean; onClose: () => void; busy: boolean;
  onSubmit: (input: { currentPassword: string; newPassword: string }) => void;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');

  const mismatch = confirm.length > 0 && next !== confirm;
  const canSubmit = current.length > 0 && next.length >= 10 && next === confirm;

  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!canSubmit) return;
    onSubmit({ currentPassword: current, newPassword: next });
    setCurrent(''); setNext(''); setConfirm('');
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Change password"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => submit()} disabled={!canSubmit} loading={busy}>
            Change password
          </Button>
        </>
      }
    >
      {error && <Alert kind="error">{error}</Alert>}
      <form onSubmit={submit} noValidate>
        <Field label="Current password" id="pw-current">
          <Input id="pw-current" type="password" value={current} autoComplete="current-password"
            onChange={(e) => { setCurrent(e.target.value); setError(''); }} />
        </Field>
        <Field label="New password" id="pw-new" hint="At least 10 characters.">
          <Input id="pw-new" type="password" value={next} autoComplete="new-password"
            onChange={(e) => { setNext(e.target.value); setError(''); }} minLength={10} />
        </Field>
        <Field label="Confirm new password" id="pw-confirm"
          error={mismatch ? 'Passwords do not match' : undefined}>
          <Input id="pw-confirm" type="password" value={confirm} autoComplete="new-password"
            onChange={(e) => { setConfirm(e.target.value); setError(''); }} />
        </Field>
      </form>
      <p className="small muted mb-0">
        Changing your password signs out every other session on all devices.
      </p>
    </Dialog>
  );
}

function describeModels(allowed: string[] | null): string {
  if (!allowed || allowed.length === 0) return 'All enabled models';
  return allowed.join(', ');
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error';
}
