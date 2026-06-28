/** Small, allocation-light formatters shared across panel views. */

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** Middle-truncate a path so the filename + extension stay visible. */
export function truncateMiddle(s: string, max = 42): string {
  if (s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep * 0.45);
  const tail = Math.floor(keep * 0.55);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

export function basename(path: string): string {
  const p = path.split('/').filter(Boolean);
  return p[p.length - 1] ?? path;
}

export function fmtPct(frac: number): string {
  return `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
}

/** Relative "time ago" from an epoch-ms instant. `now` is injected for testability. */
export function fmtAge(at: number, now: number): string {
  const ms = Math.max(0, now - at);
  const s = Math.round(ms / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
