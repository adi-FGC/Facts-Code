/**
 * secretClass — how the dashboard counts a `category: 'secret'` risk.
 *
 * analyze() emits three kinds of secret finding, told apart by severity:
 *   - `low`  — a token-shaped value in a test/fixture path: listed with its
 *              exact path, kept out of the grade (v0.3.11);
 *   - `info` — a generic heuristic hit (password=, a DB URL, a secret-named
 *              field): a POSSIBLE secret, shown but never graded (owner
 *              decision 2026-09-24);
 *   - anything else — a provider-specific detector: an EXPOSED secret.
 *
 * Only `exposed` reads as "rotate before shipping" — the same set core's
 * health grade and diff count. Pure: shared by Credentials and the review
 * verdict so the two can never disagree.
 */

export type SecretClass = 'exposed' | 'fixture' | 'possible';

export function secretClass(r: { severity: string }): SecretClass {
  if (r.severity === 'low') return 'fixture';
  if (r.severity === 'info') return 'possible';
  return 'exposed';
}

/** Split the secret risks of `risks` into their three groups (order kept). */
export function splitSecrets<R extends { category: string; severity: string }>(
  risks: readonly R[],
): Record<SecretClass, R[]> {
  const out: Record<SecretClass, R[]> = { exposed: [], fixture: [], possible: [] };
  for (const r of risks) if (r.category === 'secret') out[secretClass(r)].push(r);
  return out;
}
