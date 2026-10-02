/**
 * Small formatting and option-parsing helpers shared by the commands in
 * ./commands/ (moved out of cli.ts unchanged, tech-debt#6).
 */
import path from 'node:path';

export function formatCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return (n / 1_048_576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return `${n} B`;
}

export function relativize(p: string, root: string): string {
  return path.relative(root, p).replaceAll('\\', '/');
}

/**
 * Parse a CLI numeric option strictly. Returns the parsed integer if it
 * lies in [min, max]; otherwise returns `def`. Guards against `Number()`'s
 * NaN-on-bad-input which cascades into silent zero behavior in slice/loop
 * code downstream.
 */
export function parseIntInRange(
  raw: string | number,
  def: number,
  min: number,
  max: number,
): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/** Age of an ISO timestamp in whole days (floored, never negative). */
export function ageDays(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000));
}
