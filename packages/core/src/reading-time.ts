/**
 * Reading-time helper — v0.3.8.
 *
 * Pure deterministic function. Estimates how long it would take a
 * developer to skim a file or a whole folder, in minutes.
 *
 *   minutes = max(1, round((loc / 25) + complexity_bonus, 0.5))
 *   complexity_bonus = floor((cyclomatic - 10) / 5) when cyclomatic > 10
 *
 * 25 LOC/minute is the rough speed of "reading code attentively but not
 * line-by-line debugging" — fast enough that a 2KLOC file is a 90-min
 * read, slow enough that nothing is "1 minute". The cyclomatic bonus
 * adds floor((c - 10) / 5) extra minutes — every 5 branches over the
 * easy threshold of 10 costs another minute of mental load.
 *
 * Floored at 1 minute so empty/lockfile outputs don't render as "0 min".
 * Half-minute precision because finer is false-precision noise.
 *
 * Pure / isomorphic — no Date, no Math.random, no Node imports.
 */

export interface ReadingTimeInput {
  loc: number;
  /** Cyclomatic complexity. v0.1 stubs this at 0 for every file; the
   *  calculation degrades gracefully (no bonus when 0). v0.4 backfills
   *  real values once the AST complexity pass lands. */
  cyclomatic: number;
}

export function computeReadingTime(input: ReadingTimeInput): number {
  const loc = Math.max(0, Math.floor(input.loc));
  const cyclo = Math.max(0, Math.floor(input.cyclomatic));
  const base = loc / 25;
  const bonus = cyclo > 10 ? Math.floor((cyclo - 10) / 5) : 0;
  const raw = base + bonus;
  // Round to nearest 0.5, floor at 1.
  const halfStep = Math.round(raw * 2) / 2;
  return Math.max(1, halfStep);
}

/**
 * Rollup helper for folders: pass an array of per-file minutes, get
 * the sum. Folders aren't capped at 1 minute (a 0-LOC folder is
 * legitimately 0 minutes of reading), only files are.
 */
export function sumReadingMinutes(perFile: number[]): number {
  let total = 0;
  for (const m of perFile) total += m;
  return total;
}
