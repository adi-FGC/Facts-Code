/**
 * LEGACY one-shot migration: imported user rows from the 2019 CSV export of
 * the old shop. Kept for audit; nothing imports this module anymore. A naive
 * path-grep for "user" or "import" still reads all of it.
 */
export interface LegacyUserRow {
  legacy_id: number;
  email_address: string;
  full_name: string;
  signup_date: string;
  newsletter_opt_in: 'Y' | 'N';
}

export function parseLegacyCsvLine(line: string): LegacyUserRow | null {
  const cols = line.split(',').map((c) => c.trim());
  if (cols.length < 5) return null;
  const legacyId = Number(cols[0]);
  if (!Number.isFinite(legacyId)) return null;
  return {
    legacy_id: legacyId,
    email_address: cols[1] ?? '',
    full_name: cols[2] ?? '',
    signup_date: cols[3] ?? '',
    newsletter_opt_in: cols[4] === 'Y' ? 'Y' : 'N',
  };
}

export function legacyToModernId(row: LegacyUserRow): string {
  return `u_legacy_${row.legacy_id}`;
}

export function migrationSummary(rows: LegacyUserRow[]): string {
  const optedIn = rows.filter((r) => r.newsletter_opt_in === 'Y').length;
  return `${rows.length} legacy users parsed, ${optedIn} newsletter opt-ins carried over`;
}
