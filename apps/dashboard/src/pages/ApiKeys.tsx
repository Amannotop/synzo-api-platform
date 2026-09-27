import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { formatDateTime, relativeTime } from '../lib/format';
import { useToast } from '../components/Toast';
import {
  Alert, Button, Card, Dialog, EmptyState, EnvBadge, Field, Icons, Input,
  Loading, Select, StatusBadge,
} from '../components/ui';

export default function ApiKeys() {
  const qc = useQueryClient();
  const toast = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [revealed, setRevealed] = useState<{ secret: string; name: string } | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<{ id: string; name: string } | null>(null);

  const keys = useQuery({ queryKey: ['keys'], queryFn: api.keys });
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['keys'] });

  const createKey = useMutation({
    mutationFn: api.createKey,
    onSuccess: (res) => {
      invalidate();
      setCreateOpen(false);
      // The secret exists exactly once in this response and is never stored.
      setRevealed({ secret: res.secret, name: res.key.name });
      toast.push('success', 'API key created', res.warning);
    },
    onError: (err) => toast.push('error', 'Could not create key', message(err)),
  });

  const revokeKey = useMutation({
    mutationFn: api.revokeKey,
    onSuccess: () => {
      invalidate();
      setPendingRevoke(null);
      toast.push('success', 'Key revoked', 'It can no longer authenticate requests.');
    },
    onError: (err) => toast.push('error', 'Could not revoke key', message(err)),
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'disabled' }) =>
      api.setKeyStatus(id, status),
    onSuccess: (_res, vars) => {
      invalidate();
      toast.push('success', vars.status === 'active' ? 'Key enabled' : 'Key disabled');
    },
    onError: (err) => toast.push('error', 'Could not update key', message(err)),
  });

  const deleteKey = useMutation({
    mutationFn: api.deleteKey,
    onSuccess: () => {
      invalidate();
      toast.push('success', 'Key deleted');
    },
    onError: (err) => toast.push('error', 'Could not delete key', message(err)),
  });

  if (keys.isLoading) return <Loading rows={4} label="Loading API keys" />;
  if (keys.isError) return <Alert kind="error">Could not load API keys. {message(keys.error)}</Alert>;

  const list = keys.data?.keys ?? [];
  const canCreateLive = keys.data?.canCreateLiveKeys ?? false;
  const hasProjects = (projects.data?.projects ?? []).length > 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>API Keys</h1>
          <p>Keys authenticate your requests. The secret is shown once at creation and cannot be retrieved again.</p>
        </div>
        <div className="page-actions">
          <Button variant="primary" icon={<Icons.plus size={15} />}
            onClick={() => setCreateOpen(true)} disabled={!hasProjects}
            title={hasProjects ? undefined : 'Create a project first'}>
            Create key
          </Button>
        </div>
      </div>

      {!hasProjects && (
        <Alert kind="info">
          You need a project before you can create an API key. Every key belongs to exactly one project.
        </Alert>
      )}

      {list.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Icons.key size={20} />}
            title="No API keys yet"
            message="Create your first key to start sending requests to the platform."
            action={hasProjects
              ? <Button variant="primary" onClick={() => setCreateOpen(true)}>Create your first key</Button>
              : undefined}
          />
        </Card>
      ) : (
        <div className="grid grid-2">
          {list.map((k) => (
            <div key={k.id} className="card key-card">
              <div className="row-between wrap mb-1">
                <div className="row wrap">
                  <span className="strong">{k.name}</span>
                  <EnvBadge env={k.environment} />
                  <StatusBadge status={k.status} />
                </div>
              </div>

              <div className="row wrap small muted mb-1">
                <span className="mono">{k.keyPrefix}••••••••</span>
              </div>

              <dl className="small muted" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 12px', margin: '10px 0 14px' }}>
                <dt>Created</dt><dd style={{ margin: 0 }}>{formatDateTime(k.createdAt)}</dd>
                <dt>Last used</dt><dd style={{ margin: 0 }}>{relativeTime(k.lastUsedAt)}</dd>
                <dt>Requests</dt><dd style={{ margin: 0 }}>{(k.requestCount ?? 0).toLocaleString('en-US')}</dd>
                {k.expiresAt && (<><dt>Expires</dt><dd style={{ margin: 0 }}>{formatDateTime(k.expiresAt)}</dd></>)}
              </dl>

              <div className="row wrap">
                {k.status === 'revoked' ? (
                  <span className="small subtle">This key is permanently revoked.</span>
                ) : (
                  <>
                    <Button size="sm" onClick={() => setStatus.mutate({ id: k.id, status: k.status === 'active' ? 'disabled' : 'active' })}
                      disabled={setStatus.isPending}>
                      {k.status === 'active' ? 'Disable' : 'Enable'}
                    </Button>
                    <Button size="sm" variant="danger" icon={<Icons.close size={13} />}
                      onClick={() => setPendingRevoke({ id: k.id, name: k.name })}>
                      Revoke
                    </Button>
                    <Button size="sm" variant="ghost" icon={<Icons.trash size={13} />}
                      onClick={() => deleteKey.mutate(k.id)} disabled={deleteKey.isPending}
                      aria-label={`Delete ${k.name}`}>
                      Delete
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <CreateKeyDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        projects={projects.data?.projects ?? []}
        canCreateLive={canCreateLive}
        onSubmit={(input) => createKey.mutate(input)}
        busy={createKey.isPending}
        error={createKey.error ? message(createKey.error) : undefined}
      />

      <RevealSecretDialog secret={revealed} onClose={() => setRevealed(null)} />

      <Dialog
        open={pendingRevoke !== null}
        onClose={() => setPendingRevoke(null)}
        title="Revoke this key?"
        footer={
          <>
            <Button onClick={() => setPendingRevoke(null)}>Cancel</Button>
            <Button variant="danger" loading={revokeKey.isPending}
              onClick={() => pendingRevoke && revokeKey.mutate(pendingRevoke.id)}>
              Revoke key
            </Button>
          </>
        }
      >
        <p className="mb-0">
          <strong>{pendingRevoke?.name}</strong> will stop working immediately. Any application still
          using it will receive <span className="inline-code">401 invalid_api_key</span>.
        </p>
        <p className="small muted mt-2 mb-0">This cannot be undone. Delete the key and create a new one instead.</p>
      </Dialog>
    </>
  );
}

function CreateKeyDialog({ open, onClose, projects, canCreateLive, onSubmit, busy, error }: {
  open: boolean; onClose: () => void;
  projects: { id: string; name: string }[];
  canCreateLive: boolean;
  onSubmit: (input: { name: string; projectId: string; environment: 'live' | 'test' }) => void;
  busy: boolean; error?: string;
}) {
  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState('');
  const [environment, setEnvironment] = useState<'test' | 'live'>('test');

  // Default to the first project once the list arrives.
  const effectiveProject = projectId || projects[0]?.id || '';
  const canSubmit = name.trim().length > 0 && effectiveProject !== '';

  function submit() {
    if (!canSubmit) return;
    onSubmit({ name: name.trim(), projectId: effectiveProject, environment });
    setName('');
  }

  return (
    <Dialog open={open} onClose={onClose} title="Create API key"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit} loading={busy}>
            Create key
          </Button>
        </>
      }>
      {error && <Alert kind="error">{error}</Alert>}

      <Field label="Key name" id="key-name" hint="Something you will recognise later, like “Production”.">
        <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)}
          placeholder="Production" autoFocus />
      </Field>

      <Field label="Project" id="key-project">
        <Select id="key-project" value={effectiveProject}
          onChange={(e) => setProjectId(e.target.value)}>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      </Field>

      <Field label="Environment" id="key-env"
        hint={canCreateLive
          ? 'Test keys are prefixed sk_test_. Live keys use sk_live_.'
          : 'Live keys require admin approval. You can create test keys now.'}>
        <Select id="key-env" value={environment}
          onChange={(e) => setEnvironment(e.target.value as 'test' | 'live')}>
          <option value="test">Test (sk_test_…)</option>
          <option value="live" disabled={!canCreateLive}>
            Live (sk_live_…){canCreateLive ? '' : ' — requires admin approval'}
          </option>
        </Select>
      </Field>
    </Dialog>
  );
}

/**
 * The only place a secret is ever visible. It is deliberately not stored in
 * state beyond this dialog, so closing it loses the value for good.
 */
function RevealSecretDialog({ secret, onClose }: { secret: { secret: string; name: string } | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();

  if (!secret) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret!.secret);
      setCopied(true);
      toast.push('success', 'Copied to clipboard');
    } catch {
      toast.push('error', 'Copy failed', 'Select the text and copy it manually.');
    }
  }

  return (
    <Dialog open onClose={onClose} title="Copy your secret key"
      footer={<Button variant="primary" onClick={onClose}>I have saved it</Button>}>
      <Alert kind="warning">
        This secret is shown <strong>once</strong>. If you lose it, delete this key and create a new one.
      </Alert>

      <Field label={secret.name} id="secret-value">
        <div className="secret-box">
          <span className="secret-value" id="secret-value">{secret.secret}</span>
          <Button size="sm" onClick={() => void copy()} icon={copied ? <Icons.check size={13} /> : <Icons.copy size={13} />}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </Field>

      <p className="small muted mb-0">
        Use it as a bearer token: <span className="inline-code">Authorization: Bearer {secret.secret.slice(0, 12)}…</span>
      </p>
    </Dialog>
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error';
}
