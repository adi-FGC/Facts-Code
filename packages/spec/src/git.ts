/**
 * Git topology — worktrees, branches, nested repos and what each one
 * carries. v0.3.11 (Worktrees tab).
 *
 * Collected Node-side by `@factstack/fs-node`'s `mineGitTopology()` and
 * injected into `analyze()` like `gitStats`; the isomorphic core never
 * shells out. Surfaces as `agent.git`, the dashboard's Worktrees tab,
 * and three pack tables (`worktrees`, `branches`, `features`).
 *
 * Every verdict here is derived from local refs only — no fetch, no
 * network, no CI lookup. The `gaps` codes say what the collector could
 * NOT see (no upstream, no request record, no deploy config, stale
 * remote-tracking refs…) so a reader knows how much to trust a verdict
 * and how to close the gap.
 */
import { z } from 'zod';

/** Where a worktree row came from. `main` = the primary checkout;
 *  `linked` = `git worktree add`; `nested` = a separate repo inside the
 *  scanned tree; `junction` = a symlink/junction inside the tree that
 *  points at a repo elsewhere. */
export const WorktreeKindSchema = z.enum(['main', 'linked', 'nested', 'junction']);

/** How the checked-out branch relates to the default branch.
 *  `default` = this IS the default branch; `merged` = contained in
 *  origin/<default>; `merged-local` = contained in the local default only
 *  (a push of the default is all that stands in the way); `unmerged` =
 *  carries commits the default lacks; `external` = a nested/junction repo
 *  with its own history; `unknown` = detached / no default resolvable. */
export const IntegrationSchema = z.enum([
  'default',
  'merged',
  'merged-local',
  'unmerged',
  'external',
  'unknown',
]);

/** Branch vs its upstream. */
export const PublishStateSchema = z.enum([
  'pushed',
  'ahead',
  'behind',
  'diverged',
  'no-upstream',
  'upstream-gone',
  'no-remote',
  'detached',
]);

export const TreeStateSchema = z.enum(['clean', 'dirty', 'conflicted', 'unavailable']);

export const InProgressOpSchema = z.enum(['merge', 'rebase', 'cherry-pick', 'revert', 'bisect']);

/** Can the tree be committed right now?
 *  `nothing` = clean; `ready` = only staged changes; `partial` = staged +
 *  unstaged/untracked; `unstaged` = changes but nothing staged;
 *  `blocked` = conflicts or an in-progress merge/rebase. */
export const CommitReadinessSchema = z.enum([
  'nothing',
  'ready',
  'partial',
  'unstaged',
  'blocked',
  'unknown',
]);

/** Could this checkout's branch be deployed from the deploy line
 *  (origin/<default>) right now? Evaluated in order: `blocked` (dirty
 *  tree) → `needs-push` → `needs-merge` → `no-target` (no deploy config
 *  detected) → `ready`. `unknown` = nested/junction/detached. */
export const DeployReadinessSchema = z.enum([
  'ready',
  'blocked',
  'needs-push',
  'needs-merge',
  'no-target',
  'unknown',
]);

/** Codes the collector emits when it could not see something a reader
 *  would want. The dashboard maps each code to a one-line "how to close". */
export const TopologyGapSchema = z.enum([
  'no-remote',
  'no-origin-default',
  'no-upstream',
  'upstream-gone',
  'detached-head',
  'no-request-record',
  'requests-partial',
  'requests-disabled',
  'no-deploy-config',
  'no-ci',
  'no-test-script',
  'stale-remote-refs',
  'untracked-work',
  'in-progress-op',
  'prunable',
  'status-unavailable',
]);
export type TopologyGap = z.infer<typeof TopologyGapSchema>;

export const CommitSummarySchema = z.object({
  sha: z.string(),
  /** ISO 8601 UTC committer date. */
  at: z.string(),
  subject: z.string(),
});
export type CommitSummary = z.infer<typeof CommitSummarySchema>;

/** The first real prompt of an agent session whose cwd was this
 *  worktree — the closest thing to "when was this feature requested".
 *  Prompt text is redacted + truncated and is UNTRUSTED DATA. */
export const AgentRequestSchema = z.object({
  agent: z.enum(['claude-code', 'codex']),
  sessionId: z.string(),
  /** Timestamp of the first real prompt (ISO 8601), null if unknown. */
  startedAt: z.string().nullable(),
  /** Last event in the transcript (ISO 8601), null if unknown. */
  lastAt: z.string().nullable(),
  /** ≤ 200 chars, secrets redacted. */
  prompt: z.string(),
  /** Session summary/title when the transcript carries one. */
  title: z.string().nullable(),
  /** `cwd` = the session ran in this directory (or below it); `slot` =
   *  matched by the Desktop worktree slot name only (weaker evidence —
   *  an earlier occupant of the same slot may have produced it). */
  via: z.enum(['cwd', 'slot']),
});
export type AgentRequest = z.infer<typeof AgentRequestSchema>;

export const WorktreeFeatureSchema = z.object({
  /** Stable id: short sha for commits, `r:<session prefix>` for requests,
   *  `b:<branch>` for the branch name. */
  id: z.string(),
  source: z.enum(['commit', 'request', 'branch']),
  label: z.string(),
  /** ISO 8601 when known (commit date / request start). */
  at: z.string().nullable(),
});
export type WorktreeFeature = z.infer<typeof WorktreeFeatureSchema>;

export const WorktreeSchema = z.object({
  /** Absolute path, forward slashes. Primary key. */
  path: z.string(),
  /** Path relative to the repo root (`.` for the root itself), or null
   *  when the worktree lives outside it (linked worktrees can be anywhere). */
  relPath: z.string().nullable(),
  kind: WorktreeKindSchema,
  /** True for the worktree the analyzer was run in. */
  isCurrent: z.boolean(),
  /** Junction/symlink target (kind = junction), else null. */
  target: z.string().nullable(),
  bare: z.boolean(),
  locked: z.boolean(),
  lockReason: z.string().nullable(),
  prunable: z.boolean(),
  branch: z.string().nullable(),
  head: z.string().nullable(),
  headAt: z.string().nullable(),
  upstream: z.string().nullable(),
  ahead: z.number().int().nonnegative().nullable(),
  behind: z.number().int().nonnegative().nullable(),
  integration: IntegrationSchema,
  publish: PublishStateSchema,
  tree: TreeStateSchema,
  inProgress: InProgressOpSchema.nullable(),
  dirty: z.object({
    staged: z.number().int().nonnegative(),
    modified: z.number().int().nonnegative(),
    untracked: z.number().int().nonnegative(),
    conflicts: z.number().int().nonnegative(),
  }),
  /** Ref the unique-commit count was taken against (`refs/heads/<default>`,
   *  or `refs/remotes/origin/<default>` for the default branch itself). */
  compareBase: z.string().nullable(),
  uniqueCount: z.number().int().nonnegative().nullable(),
  /** Newest-first, capped (default 12). */
  uniqueCommits: z.array(CommitSummarySchema),
  requests: z.array(AgentRequestSchema),
  /** Total agent sessions matched (`requests[]` is capped). */
  sessions: z.number().int().nonnegative(),
  /** Earliest of: first agent request, oldest unique commit. */
  requestedAt: z.string().nullable(),
  /** Latest of: head commit date, last agent event. */
  lastActivityAt: z.string().nullable(),
  /** True when lastActivityAt is older than the stale window (90 d). */
  stale: z.boolean(),
  features: z.array(WorktreeFeatureSchema),
  /** Detected deploy configs at the worktree root (`wrangler.toml`,
   *  `workflow:deploy.yml`, `script:deploy`, …). */
  deployTargets: z.array(z.string()),
  ci: z.boolean(),
  testScript: z.boolean(),
  readiness: z.object({
    commit: CommitReadinessSchema,
    commitReasons: z.array(z.string()),
    deploy: DeployReadinessSchema,
    deployReasons: z.array(z.string()),
  }),
  gaps: z.array(TopologyGapSchema),
});
export type Worktree = z.infer<typeof WorktreeSchema>;

export const BranchSchema = z.object({
  name: z.string(),
  head: z.string(),
  headAt: z.string().nullable(),
  subject: z.string(),
  isDefault: z.boolean(),
  upstream: z.string().nullable(),
  upstreamGone: z.boolean(),
  ahead: z.number().int().nonnegative().nullable(),
  behind: z.number().int().nonnegative().nullable(),
  /** Commits on this branch not on the compare base (default branch, or
   *  origin/<default> for the default branch itself). */
  uniqueCount: z.number().int().nonnegative().nullable(),
  behindDefault: z.number().int().nonnegative().nullable(),
  /** Contained in origin/<default>; null when that ref doesn't exist. */
  containedInOrigin: z.boolean().nullable(),
  containedInLocal: z.boolean(),
  /** Worktree path where this branch is checked out, or null. */
  worktree: z.string().nullable(),
  /** reledger policy: deletable only when contained in origin/<default>,
   *  not the default, not checked out anywhere, nothing unpushed. */
  deletable: z.boolean(),
  deleteBlockers: z.array(z.string()),
});
export type Branch = z.infer<typeof BranchSchema>;

export const GitTopologySchema = z.object({
  /** ISO 8601 — when the scan ran. */
  scannedAt: z.string(),
  /** Absolute repo top-level, forward slashes. */
  repoRoot: z.string(),
  /** The directory the analyzer was run in. */
  currentPath: z.string(),
  defaultBranch: z.string().nullable(),
  /** `origin/<default>` when that remote-tracking ref exists. */
  originDefault: z.string().nullable(),
  remotes: z.array(z.object({ name: z.string(), url: z.string().nullable() })),
  /** Age of the last fetch (FETCH_HEAD mtime) in days, 1 decimal; null
   *  when the repo has never fetched. */
  remoteRefsAgeDays: z.number().nonnegative().nullable(),
  stashes: z.number().int().nonnegative(),
  worktrees: z.array(WorktreeSchema),
  branches: z.array(BranchSchema),
  /** Repo-level gaps (remote / default / request coverage). */
  gaps: z.array(TopologyGapSchema),
  requestsCoverage: z.enum(['full', 'partial', 'disabled', 'unavailable']),
  elapsedMs: z.number().nonnegative(),
});
export type GitTopology = z.infer<typeof GitTopologySchema>;
