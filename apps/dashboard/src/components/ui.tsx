import {
  useEffect, useRef, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes,
  type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import { initials } from '../lib/format';

/* ------------------------------------------------------------------ icons */
/* Inline SVGs keep the bundle free of an icon dependency. */

const svg = (d: ReactNode) => (props: { size?: number }) => (
  <svg width={props.size ?? 16} height={props.size ?? 16} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">
    {d}
  </svg>
);

export const Icons = {
  dashboard: svg(<><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></>),
  key: svg(<><circle cx="7.5" cy="15.5" r="4.5" /><path d="m10.7 12.3 8.3-8.3M17 6l2.5 2.5M14.5 8.5 17 11" /></>),
  folder: svg(<path d="M3 7a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.6.8l1 1.2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />),
  cube: svg(<><path d="m12 2 9 5v10l-9 5-9-5V7Z" /><path d="m3 7 9 5 9-5M12 22V12" /></>),
  chart: svg(<><path d="M3 3v18h18" /><path d="m7 15 4-4 3 3 5-6" /></>),
  list: svg(<><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></>),
  book: svg(<><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" /></>),
  settings: svg(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H1a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 2.6 7a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 7 2.6h.1A1.7 1.7 0 0 0 8.3 1V1a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 15 2.6a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>),
  shield: svg(<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />),
  menu: svg(<path d="M3 6h18M3 12h18M3 18h18" />),
  close: svg(<path d="M18 6 6 18M6 6l12 12" />),
  copy: svg(<><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>),
  check: svg(<path d="M20 6 9 17l-5-5" />),
  plus: svg(<path d="M12 5v14M5 12h14" />),
  trash: svg(<><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></>),
  logout: svg(<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5M21 12H9" /></>),
  alert: svg(<><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></>),
  info: svg(<><circle cx="12" cy="12" r="9" /><path d="M12 16v-5M12 8h.01" /></>),
  inbox: svg(<><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.5 5.5 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.5A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.5Z" /></>),
  sun: svg(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>),
  moon: svg(<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />),
  users: svg(<><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.9" /></>),
  refresh: svg(<><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></>),
};

/* ---------------------------------------------------------------- buttons */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'default' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: ReactNode;
};

export function Button({
  variant = 'default', size = 'md', loading, icon, children, className = '', disabled, ...rest
}: ButtonProps) {
  const classes = ['btn'];
  if (variant !== 'default') classes.push(`btn-${variant}`);
  if (size === 'sm') classes.push('btn-sm');
  if (className) classes.push(className);
  return (
    <button {...rest} className={classes.join(' ')} disabled={disabled || loading}>
      {loading ? <span className="spinner" /> : icon}
      {children}
    </button>
  );
}

/* ----------------------------------------------------------------- fields */

export function Field({ label, hint, error, children, id }: {
  label: string; hint?: string; error?: string; children: ReactNode; id?: string;
}) {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      {children}
      {hint && !error && <div className="hint">{hint}</div>}
      {error && <div className="error-text" role="alert">{error}</div>}
    </div>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = '', ...rest } = props;
  return <input {...rest} className={`input ${className}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = '', children, ...rest } = props;
  return <select {...rest} className={`select ${className}`}>{children}</select>;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = '', ...rest } = props;
  return <textarea {...rest} className={`input ${className}`} />;
}

/* ------------------------------------------------------------------ cards */

export function Card({ title, actions, children, bodyClass = 'card-body' }: {
  title?: ReactNode; actions?: ReactNode; children: ReactNode; bodyClass?: string;
}) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card-head">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {actions && <div className="row wrap">{actions}</div>}
        </header>
      )}
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub !== undefined && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

/* ----------------------------------------------------------------- states */

export function EmptyState({ title, message, action, icon }: {
  title: string; message: string; action?: ReactNode; icon?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon ?? <Icons.inbox size={20} />}</div>
      <h3>{title}</h3>
      <p>{message}</p>
      {action}
    </div>
  );
}

export function Alert({ kind = 'info', children }: {
  kind?: 'info' | 'error' | 'success' | 'warning'; children: ReactNode;
}) {
  const Icon = kind === 'error' || kind === 'warning' ? Icons.alert : kind === 'success' ? Icons.check : Icons.info;
  return (
    <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon size={16} />
      <div>{children}</div>
    </div>
  );
}

export function Loading({ rows = 3, label = 'Loading…' }: { rows?: number; label?: string }) {
  return (
    <div aria-busy="true" aria-live="polite" className="card-body">
      <span className="sr-only" style={{ position: 'absolute', left: -9999 }}>{label}</span>
      <div className="grid" style={{ gap: 10 }}>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="skeleton" style={{ height: 40 }} />
        ))}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- dialog */

/**
 * Focus moves into the dialog on open and Escape closes it, so the confirm
 * flow is usable from the keyboard alone.
 */
export function Dialog({ open, onClose, title, children, footer, labelledBy = 'dialog-title' }: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode;
  footer?: ReactNode; labelledBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusable = node?.querySelector<HTMLElement>(
      'input, select, textarea, button, [href], [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab' || !node) return;
      // Trap Tab inside the dialog.
      const items = Array.from(node.querySelectorAll<HTMLElement>(
        'input, select, textarea, button, [href], [tabindex]:not([tabindex="-1"])',
      )).filter((el) => !el.hasAttribute('disabled'));
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={labelledBy} ref={ref}>
        <header className="dialog-head">
          <h2 id={labelledBy}>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close dialog" style={{ display: 'inline-flex' }}>
            <Icons.close size={16} />
          </button>
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-foot">{footer}</footer>}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- avatar */

export function Avatar({ name, size = 30 }: { name: string; size?: number }) {
  return (
    <div className="avatar" style={{ width: size, height: size, fontSize: size * 0.36 }}>
      {initials(name)}
    </div>
  );
}

/* ----------------------------------------------------------------- badges */

export function StatusBadge({ status }: { status: 'active' | 'disabled' | 'revoked' | string }) {
  const kind = status === 'active' ? 'success' : status === 'revoked' ? 'danger' : 'neutral';
  return <span className={`badge badge-${kind}`}><span className="dot" />{status}</span>;
}

export function EnvBadge({ env }: { env: 'live' | 'test' }) {
  return <span className={`badge badge-${env === 'live' ? 'accent' : 'neutral'}`}>{env}</span>;
}
