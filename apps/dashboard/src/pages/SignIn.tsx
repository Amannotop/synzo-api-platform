import { useState, type FormEvent } from 'react';
import { useAuth } from '../lib/AuthContext';
import { useToast } from '../components/Toast';
import { Alert, Button, Field, Input } from '../components/ui';

export default function SignIn() {
  const { login, register } = useAuth();
  const toast = useToast();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'signin') {
        await login(email.trim(), password);
        toast.push('success', 'Signed in');
      } else {
        await register(name.trim(), email.trim(), password);
        toast.push('success', 'Account created', 'The first account on a new platform becomes the admin.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Something went wrong';
      setError(message);
      toast.push('error', 'Could not continue', message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-head">
          <div className="brand-mark" aria-hidden="true">S</div>
          <h1>Synzo API</h1>
          <p className="muted small">Sign in to manage your keys, projects and usage.</p>
        </div>

        <div className="card">
          <div className="card-body">
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={mode === 'signin'}
                className={`tab ${mode === 'signin' ? 'active' : ''}`}
                onClick={() => { setMode('signin'); setError(''); }}>
                Sign in
              </button>
              <button role="tab" aria-selected={mode === 'signup'}
                className={`tab ${mode === 'signup' ? 'active' : ''}`}
                onClick={() => { setMode('signup'); setError(''); }}>
                Create account
              </button>
            </div>

            {error && <Alert kind="error">{error}</Alert>}

            <form onSubmit={onSubmit} noValidate>
              {mode === 'signup' && (
                <Field label="Full name" id="name">
                  <Input id="name" value={name} onChange={(e) => setName(e.target.value)}
                    autoComplete="name" required placeholder="Aman Sharma" />
                </Field>
              )}
              <Field label="Email" id="email">
                <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email" required placeholder="you@company.com" />
              </Field>
              <Field label="Password" id="password"
                hint={mode === 'signup' ? 'At least 8 characters.' : undefined}>
                <Input id="password" type="password" value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                  required minLength={8} placeholder="••••••••" />
              </Field>

              <Button type="submit" variant="primary" className="btn-block" loading={busy}>
                {mode === 'signin' ? 'Sign in' : 'Create account'}
              </Button>
            </form>
          </div>
        </div>

        <p className="auth-switch">
          {mode === 'signin' ? "Don't have an account? " : 'Already registered? '}
          <button className="btn btn-ghost btn-sm" style={{ padding: '2px 4px' }}
            onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(''); }}>
            {mode === 'signin' ? 'Create one' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  );
}
