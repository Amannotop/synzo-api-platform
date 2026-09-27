import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { formatDate, relativeTime } from '../lib/format';
import { useToast } from '../components/Toast';
import {
  Alert, Button, Card, Dialog, EmptyState, Field, Icons, Input, Loading, Textarea,
} from '../components/ui';

export default function Projects() {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<{ id: string; name: string; description: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);

  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['projects'] });

  const create = useMutation({
    mutationFn: api.createProject,
    onSuccess: () => { invalidate(); setCreating(false); toast.push('success', 'Project created'); },
    onError: (e) => toast.push('error', 'Could not create project', message(e)),
  });
  const update = useMutation({
    mutationFn: ({ id, ...input }: { id: string; name: string; description: string }) =>
      api.updateProject(id, { name: input.name, description: input.description || undefined }),
    onSuccess: () => { invalidate(); setEditing(null); toast.push('success', 'Project updated'); },
    onError: (e) => toast.push('error', 'Could not update project', message(e)),
  });
  const remove = useMutation({
    mutationFn: api.deleteProject,
    onSuccess: () => { invalidate(); setDeleting(null); toast.push('success', 'Project deleted'); },
    onError: (e) => toast.push('error', 'Could not delete project', message(e)),
  });

  if (projects.isLoading) return <Loading rows={3} label="Loading projects" />;
  if (projects.isError) return <Alert kind="error">Could not load projects. {message(projects.error)}</Alert>;

  const list = projects.data?.projects ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <p>Group your API keys and usage by application, website or environment.</p>
        </div>
        <div className="page-actions">
          <Button variant="primary" icon={<Icons.plus size={15} />} onClick={() => setCreating(true)}>
            New project
          </Button>
        </div>
      </div>

      {list.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Icons.folder size={20} />}
            title="No projects yet"
            message="Projects keep keys and usage separate per application. Create your first one to get started."
            action={<Button variant="primary" onClick={() => setCreating(true)}>Create a project</Button>}
          />
        </Card>
      ) : (
        <div className="table-wrap">
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Description</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id}>
                    <td className="strong">{p.name}</td>
                    <td className="muted">{p.description || <span className="subtle">—</span>}</td>
                    <td className="muted" title={p.createdAt}>{relativeTime(p.createdAt)}</td>
                    <td>
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <Button size="sm" onClick={() => setEditing({ id: p.id, name: p.name, description: p.description ?? '' })}>
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" aria-label={`Delete ${p.name}`}
                          onClick={() => setDeleting({ id: p.id, name: p.name })}>
                          <Icons.trash size={14} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <ProjectDialog
        open={creating || editing !== null}
        initial={editing}
        onClose={() => { setCreating(false); setEditing(null); }}
        onSubmit={(input) => (editing ? update.mutate({ id: editing.id, ...input }) : create.mutate(input))}
        busy={create.isPending || update.isPending}
        error={create.error || update.error ? message(create.error ?? update.error) : undefined}
      />

      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete this project?"
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="danger" loading={remove.isPending}
              onClick={() => deleting && remove.mutate(deleting.id)}>
              Delete project
            </Button>
          </>
        }>
        <p className="mb-0">
          <strong>{deleting?.name}</strong> and its API keys will be removed. Requests already recorded
          in your history are kept.
        </p>
      </Dialog>
    </>
  );
}

function ProjectDialog({ open, initial, onClose, onSubmit, busy, error }: {
  open: boolean;
  initial: { id: string; name: string; description: string } | null;
  onClose: () => void;
  onSubmit: (input: { name: string; description: string }) => void;
  busy: boolean; error?: string;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  // Re-seed the fields whenever a different project is opened for editing.
  const [seedFor, setSeedFor] = useState<string | null>(initial?.id ?? null);
  if (initial && seedFor !== initial.id) {
    setSeedFor(initial.id);
    setName(initial.name);
    setDescription(initial.description);
  }

  const canSubmit = name.trim().length > 0;

  return (
    <Dialog open={open} onClose={onClose} title={initial ? 'Edit project' : 'New project'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canSubmit} loading={busy}
            onClick={() => onSubmit({ name: name.trim(), description: description.trim() })}>
            {initial ? 'Save changes' : 'Create project'}
          </Button>
        </>
      }>
      {error && <Alert kind="error">{error}</Alert>}

      <Field label="Name" id="project-name">
        <Input id="project-name" value={name} onChange={(e) => setName(e.target.value)}
          placeholder="Mobile App" autoFocus />
      </Field>

      <Field label="Description" id="project-desc" hint="Optional. Helps you remember what this project is for.">
        <Textarea id="project-desc" rows={3} value={description}
          onChange={(e) => setDescription(e.target.value)} placeholder="The iOS app in production" />
      </Field>
    </Dialog>
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error';
}

export { formatDate };
