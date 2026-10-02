/**
 * The CLI's Node floor (owner decision 2026-09-24: 24.3 everywhere). One
 * constant for `doctor`, the published package's `engines` field
 * (scripts/bundle.mjs) and the docs — CI tests Node 24 only, so claiming
 * anything lower is untested support.
 */

export const NODE_FLOOR = [24, 3, 0] as const;

/** `engines.node` value for package.json. */
export const NODE_ENGINES = `>=${NODE_FLOOR.join('.')}`;

/** True when a `process.versions.node`-style version is at least `floor`. */
export function nodeAtLeast(version: string, floor: readonly number[] = NODE_FLOOR): boolean {
  const parts = version
    .replace(/^v/, '')
    .split(/[.+-]/)
    .slice(0, 3)
    .map((p) => Number.parseInt(p, 10));
  for (let i = 0; i < 3; i++) {
    const have = Number.isFinite(parts[i]) ? parts[i]! : 0;
    const need = floor[i] ?? 0;
    if (have !== need) return have > need;
  }
  return true;
}
