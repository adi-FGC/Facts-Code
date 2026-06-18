/**
 * Canonicalization helpers (v0.3) — producer-side normalization so the SAME logical
 * input yields the SAME wire bytes across platforms. This is the cache-key determinism
 * the master/diff chain depends on: "same repo, same bytes" only holds if every producer
 * renders paths and numbers identically.
 *
 * The codec does NOT auto-apply these — `encode()` cannot know which columns hold paths
 * or numbers — so producers (the analyzer, the browser converter) call them on the
 * relevant cells BEFORE handing them to `encode()`. Spec §canonicalization.
 */

/**
 * Normalize a file path to POSIX form: backslashes → forward slashes. A Windows
 * `src\auth\session.ts` and a POSIX `src/auth/session.ts` then intern to the same
 * dictionary value and emit identical bytes.
 */
export function canonicalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * Pinned, locale-independent number → string. JS `String()` is already
 * locale-independent and round-trips; this is the spec's canonical formatter so two
 * producers never diverge on number rendering. Rejects non-finite values rather than
 * emitting `Infinity`/`NaN` onto the wire.
 */
export function canonicalizeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new RangeError(`Non-finite number cannot be canonicalized: ${n}`);
  }
  return String(n);
}
