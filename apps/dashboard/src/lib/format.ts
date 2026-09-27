/** Display helpers. Zero values render as real zeros, never as placeholders. */

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US');
}

/** Compact form for large counters on the dashboard tiles: 1.2M, 340.5K. */
export function compactNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (Math.abs(n) < 1000) return String(n);
  const units: [number, string][] = [
    [1_000_000_000, 'B'],
    [1_000_000, 'M'],
    [1_000, 'K'],
  ];
  for (const [divisor, suffix] of units) {
    if (Math.abs(n) >= divisor) {
      const v = n / divisor;
      return `${v.toFixed(v >= 100 || Number.isInteger(v) ? 0 : 1)}${suffix}`;
    }
  }
  return String(n);
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/** "2 minutes ago" style, used for last-used and expiry columns. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diffSec = Math.round((Date.now() - then) / 1000);
  const abs = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (abs < 60) return rtf.format(-diffSec, 'second');
  if (abs < 3600) return rtf.format(-Math.round(diffSec / 60), 'minute');
  if (abs < 86400) return rtf.format(-Math.round(diffSec / 3600), 'hour');
  if (abs < 2592000) return rtf.format(-Math.round(diffSec / 86400), 'day');
  if (abs < 31536000) return rtf.format(-Math.round(diffSec / 2592000), 'month');
  return rtf.format(-Math.round(diffSec / 31536000), 'year');
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
