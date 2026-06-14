/**
 * Display formatting. `money` renders cents as a currency string — the ONLY
 * place an amount becomes user-visible text, so changing currency or locale
 * is a one-file edit.
 */
const CURRENCY = 'USD';

export function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const units = Math.floor(abs / 100);
  const rem = String(abs % 100).padStart(2, '0');
  return `${sign}${units}.${rem} ${CURRENCY}`;
}

export function shortDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
