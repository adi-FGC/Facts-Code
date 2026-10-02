/**
 * Well-known paths inside the `.facts/` directory, relative to it.
 */

/**
 * Keep-1 copy of the previous `agent.json`. analyze moves the old artifact
 * here just before writing the new one, so `review`, MCP `review_change` and
 * `since` compare two full artifacts instead of a stats-only snapshot (which
 * made every existing cycle, secret and CVE look new).
 *
 * It is always a FULL analyze: the per-edit `--minimal` hook parks the full
 * head once, then holds the baseline (marker `baseline/minimal-head`) until
 * the next full analyze, so it never becomes "one edit ago". Rewriting the
 * same analysis (scan-vulns, same `generatedAt`) never replaces it.
 */
export const BASELINE_AGENT_FILE = 'baseline/agent.json' as const;

/**
 * Last mined git topology (worktrees/branches), keyed by a fingerprint of the
 * repo's refs. Every analyze refreshes it; the per-edit `--minimal` hook
 * passes `mineGitTopology(root, { cache: { file, reuse: true } })` and reuses
 * it instead of re-mining git while no ref has moved.
 */
export const TOPOLOGY_CACHE_FILE = 'topology-cache.json' as const;

/**
 * Last `git log` walk behind per-file churn/authors/last-commit times, keyed
 * by the same refs fingerprint plus the root and window. Callers opt in via
 * `mineGitStats(root, { cache: { file, reuse } })`: with `reuse: true` (meant
 * for the per-edit `--minimal` hook) the walk is skipped while no ref has
 * moved, and `reuse: false` (a full analyze) re-mines and refreshes the file.
 * The `git status` pass for uncommitted edits runs on every call either way.
 * Nothing is written unless a caller passes `cache`.
 */
export const GIT_STATS_CACHE_FILE = 'gitstats-cache.json' as const;
