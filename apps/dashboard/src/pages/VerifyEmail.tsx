import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiRequestError } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Alert } from '../components/ui';

/**
 * Landing page for the verification email link (§8).
 *
 * The token is spent the moment this page loads rather than behind a "Confirm"
 * button: the link is itself the confirmation, and requiring a second click
 * would only mean a one-time token can be burned by a mail scanner that
 * prefetches link targets before the customer ever sees the page.
 *
 * The API establishes a session as part of verifying, so on success we refresh
 * the auth context and the customer lands signed in rather than being bounced
 * to a sign-in form for an account they just confirmed.
 */
export default function VerifyEmail() {
  const [params] = useSearchParams();
  const token = useMemo(() => params.get('token') ?? '', [params]);
  const { refresh } = useAuth();
  const [state, setState] = useState<'working' | 'done' | 'error'>('working');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api
      .verifyEmail(token)
      .then(async () => {
        if (cancelled) return;
        setState('done');
        await refresh().catch(() => {});
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState('error');
        setMessage(
          err instanceof ApiRequestError
            ? err.message
            : 'Could not verify this link. It may have expired or already been used.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [token, refresh]);

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-head">
          <h1>Email verification</h1>
        </div>

        {!token ? (
          <Alert kind="error">
            This page needs a verification link. Open the link from your email, or sign in and use
            <strong> Resend email </strong>
            on the Settings page.
          </Alert>
        ) : state === 'working' ? (
          <p className="muted small">Confirming your email address…</p>
        ) : state === 'done' ? (
          <>
            <Alert kind="success">Your email address is confirmed. Welcome aboard.</Alert>
            <div className="row mt-2">
              <Link className="btn btn-primary" to="/">
                Go to dashboard
              </Link>
            </div>
          </>
        ) : (
          <>
            <Alert kind="error">{message}</Alert>
            <div className="row mt-2">
              <Link className="btn" to="/signin">
                Back to sign in
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
