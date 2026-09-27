import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Icons } from './ui';

type Kind = 'success' | 'error' | 'info';
interface Toast { id: number; kind: Kind; title: string; message?: string }

const ToastContext = createContext<{
  push: (kind: Kind, title: string, message?: string) => void;
}>({ push: () => {} });

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const remove = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const push = useCallback((kind: Kind, title: string, message?: string) => {
    const id = nextId++;
    setToasts((t) => [...t, { id, kind, title, ...(message ? { message } : {}) }]);
    // Errors stay long enough to read; confirmations clear quickly.
    window.setTimeout(() => remove(id), kind === 'error' ? 7000 : 4000);
  }, [remove]);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* aria-live so screen readers announce results of actions */}
      <div className="toast-region" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <div style={{ marginTop: 1, color: t.kind === 'error' ? 'var(--danger)'
              : t.kind === 'success' ? 'var(--success)' : 'var(--accent)' }}>
              {t.kind === 'error' ? <Icons.alert size={15} /> : t.kind === 'success'
                ? <Icons.check size={15} /> : <Icons.info size={15} />}
            </div>
            <div className="toast-body">
              <div className="toast-title">{t.title}</div>
              {t.message && <div className="small muted">{t.message}</div>}
            </div>
            <button className="toast-close" onClick={() => remove(t.id)} aria-label="Dismiss notification">
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
