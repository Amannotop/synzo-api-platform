import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiRequestError } from '../lib/api';
import { Alert, Button, Field, Input } from '../components/ui';

/**
 * Landing page for a password-reset email link (§8).
 *
 * The token arrives in the query string and is posted to the server on submit.
 * It is deliberately not logged, stored, or sent anywhere else: the one-time
 * token is the credential, and this page is the only place it is used.
 */
export default function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = useMemo(() => params.get('token') ?? '', [params]);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const mismatch = confirm.length > 0 && password !== confirm;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (mismatch) {
      setError('The two passwords do not match');
      return;
    }
    setError('');
    setBusy(true);
    try {
      await api.resetPassword(token, password);
      setDone(true);
      // The server drops every session on reset, so any cookie in this browser
      // is dead. Send the customer to sign in with the new password.
      setTimeout(() => navigate('/signin', { replace: true }), 1800);
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.message
          : 'Could not reset your password. The link may have expired.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-head">
          <h1>Choose a new password</h1>
          <p className="muted small">Your reset link can be used once.</p>
        </div>

        {!token ? (
          <Alert kind="error">
            This page needs a reset link. Open the link from your email, or{' '}
            <Link to="/signin">request a new one</Link>.
          </Alert>
        ) : done ? (
          <Alert kind="success">
            Your password has been changed and all other sessions were signed out. Redirecting you to sign
            in…
          </Alert>
        ) : (
          <form onSubmit={onSubmit} noValidate>
            {error && (
              <div className="mb-2">
                <Alert kind="error">{error}</Alert>
              </div>
            )}
            <Field label="New password" id="new-password" hint="At least 10 characters.">
              <Input
                id="new-password"
                type="password"
                value={password}
                autoComplete="new-password"
                required
                minLength={10}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Field label="Confirm new password" id="confirm-password" error={mismatch ? 'Passwords do not match' : undefined}>
              <Input
                id="confirm-password"
                type="password"
                value={confirm}
                autoComplete="new-password"
                required
                minLength={10}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </Field>
            <div className="row mt-2">
              <Button variant="primary" type="submit" loading={busy} disabled={password.length < 10 || mismatch}>
                Update password
              </Button>
              <Link className="btn" to="/signin">
                Back to sign in
              </Link>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
