import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';
import { useAuth } from '../lib/AuthContext';
import { useToast } from '../components/Toast';
import { Alert, Button, Card, EmptyState, Icons, Loading } from '../components/ui';

export default function Models() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const models = useQuery({ queryKey: ['models'], queryFn: api.models });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.admin.setModelEnabled(id, enabled),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['models'] });
      toast.push('success', 'Model updated');
    },
    onError: (e) => toast.push('error', 'Could not update model', e instanceof Error ? e.message : ''),
  });

  if (models.isLoading) return <Loading rows={3} label="Loading models" />;
  if (models.isError) return <Alert kind="error">Could not load models. {models.error instanceof Error ? models.error.message : ''}</Alert>;

  const list = models.data?.models ?? [];
  const providers = models.data?.providers ?? [];
  const isAdmin = user?.role === 'admin';

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Models</h1>
          <p>
            Models available to your keys. Requests resolve a public model name to a provider
            upstream, so customers never need to know which provider serves it.
          </p>
        </div>
      </div>

      {list.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Icons.cube size={20} />}
            title="No models available"
            message="No enabled models are currently exposed to your account. Contact support if you expected to see one here."
          />
        </Card>
      ) : (
        <>
          <div className="grid grid-2 mb-3">
            {list.map((m) => (
              <div key={m.id} className="card key-card">
                <div className="row-between wrap">
                  <div>
                    <div className="row wrap mb-1">
                      <span className="strong mono">{m.publicName}</span>
                      <span className={`badge ${m.enabled ? 'badge-success' : 'badge-neutral'}`}>
                        <span className="dot" />{m.enabled ? 'enabled' : 'disabled'}
                      </span>
                    </div>
                    <div className="small muted">
                      Provider <span className="mono">{m.provider}</span> · added {formatDate(m.createdAt)}
                    </div>
                  </div>
                  {isAdmin && (
                    <Button size="sm" loading={toggle.isPending}
                      onClick={() => toggle.mutate({ id: m.id, enabled: !m.enabled })}>
                      {m.enabled ? 'Disable' : 'Enable'}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {isAdmin && providers.length > 0 && (
            <Card title="Providers">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Name</th><th>Status</th><th>Created</th></tr>
                  </thead>
                  <tbody>
                    {providers.map((p) => (
                      <tr key={p.id}>
                        <td className="mono">{p.name}</td>
                        <td>
                          <span className={`badge ${p.enabled ? 'badge-success' : 'badge-neutral'}`}>
                            <span className="dot" />{p.enabled ? 'enabled' : 'disabled'}
                          </span>
                        </td>
                        <td className="muted">{formatDate(p.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}
    </>
  );
}
