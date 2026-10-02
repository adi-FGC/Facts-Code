#!/usr/bin/env node
/**
 * Production deploy gates for `pnpm deploy:cf` (see docs/DEPLOY.md).
 *
 *   node scripts/deploy-check.mjs pre    before the build
 *     - the checkout is clean: the public bake must be exactly a commit, and
 *       the weekly refresh rebuilds that commit, so uncommitted changes would
 *       ship once and silently vanish on the next Monday;
 *     - HEAD is on a remote branch: the refresh job can only check out commits
 *       GitHub has.
 *   node scripts/deploy-check.mjs post   after the build
 *     - dist/mcp-auth-config.json is the Firebase web config (not missing — the
 *       SPA fallback would serve index.html for it and sign-in breaks);
 *     - the bake is public (one checkout, no local branches, no stash count),
 *       in dist/data/factstack.json AND dist/factstack.pack;
 *     - the bake was analyzed at HEAD from a CLEAN tree: `pre` checks the tree
 *       at deploy time, but the bake records the tree at analyze time, and
 *       stashing or excluding files afterwards leaves HEAD unchanged;
 *     - the bake is one analysis: its generatedAt matches .facts/agent.json
 *       (the per-edit `analyze --minimal` rewrites human.json only);
 *     - the History was carried (more than one point, and at least
 *       `--min-history <n>`: the live point count carry-history reported).
 *
 * FACTS_DEPLOY_FORCE=1 downgrades the PRE failures to warnings (an emergency
 * hotfix from an unpushed HEAD; commit the fix first). It never touches
 * `post`: the same variable is set for the whole deploy:cf chain, and a broken
 * sign-in config, a private bake or a bake of uncommitted or untracked files
 * must not ride along. FACTS_ALLOW_HISTORY_RESET=1 accepts a one-point
 * History. Both are deliberate, visible choices — never defaults.
 *
 * `post --dist <dir>` checks another build output (cve-refresh.yml runs this
 * copy of the script against the live commit's build).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';
import { publicBakeProblems, publicPackProblems } from './lib/public-bake.mjs';

/** Problems with the checkout, from `git status --porcelain` and `git branch -r --contains HEAD`. */
export function preflightProblems({ porcelain, remoteBranches }) {
  const problems = [];
  const dirty = porcelain.split('\n').filter((l) => l.trim()).length;
  if (dirty)
    problems.push(
      `${dirty} uncommitted change(s) — commit them, then re-run \`factstack analyze .\` (and scan-vulns): a public bake must be exactly the current commit, and stashing leaves the bake analyzed from them.`,
    );
  if (!remoteBranches.split('\n').some((l) => l.trim()))
    problems.push(
      'HEAD is not on any remote branch — push it first: the weekly CVE refresh rebuilds the live commit from GitHub.',
    );
  return problems;
}

/** Why the bake's current checkout was not a clean tree when it was
 *  analyzed, or null. A bake without the tree state cannot prove it was clean. */
export function bakedTreeProblem(cur) {
  const d = cur?.dirty ?? {};
  const count = (k) => (Number.isFinite(d[k]) ? d[k] : 0);
  const edits = count('staged') + count('modified');
  const untracked = count('untracked');
  const conflicts = count('conflicts');
  if (cur?.tree === 'clean' && edits + untracked + conflicts === 0) return null;
  return (
    `the bake was analyzed from a tree that was not clean (${cur?.tree ?? 'state not recorded'}: ` +
    `${edits} staged/modified, ${untracked} untracked, ${conflicts} conflicted) — commit or remove ` +
    'them, then re-run `factstack analyze .` (and scan-vulns): a public bake must be exactly a commit.'
  );
}

/** Problems with a built dist/ that is about to go live. `head` (the commit
 *  being deployed) catches a bake analyzed at another commit;
 *  `agentGeneratedAt` (.facts/agent.json's) a bake that mixes two analyses;
 *  `minHistory` (the live point count) a History that lost points. */
export function postBuildProblems(
  dist,
  { allowHistoryReset = false, head = null, agentGeneratedAt = null, minHistory = 0 } = {},
) {
  const problems = [];
  const cfgPath = join(dist, 'mcp-auth-config.json');
  if (!existsSync(cfgPath)) {
    problems.push(
      'dist/mcp-auth-config.json is missing — the MCP sign-in page would break. Put fb.mjs in the main checkout or set FACTS_FB_WEB_CONFIG.',
    );
  } else {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      if (!cfg?.apiKey || !cfg?.projectId)
        problems.push('dist/mcp-auth-config.json has no apiKey + projectId.');
    } catch {
      problems.push('dist/mcp-auth-config.json is not valid JSON.');
    }
  }
  let data = null;
  try {
    data = JSON.parse(readFileSync(join(dist, 'data', 'factstack.json'), 'utf8'));
  } catch {
    problems.push('dist/data/factstack.json is missing or unreadable — was the build baked?');
  }
  if (data) {
    for (const p of publicBakeProblems(data)) problems.push(`the bake is not public: it ${p}`);
    const cur = data.git?.worktrees?.find((w) => w.isCurrent) ?? null;
    const baked = cur?.head ?? null;
    if (head && baked && baked !== head)
      problems.push(
        `the bake was analyzed at ${baked.slice(0, 12)}, not HEAD ${head.slice(0, 12)} — re-run \`factstack analyze .\` (and scan-vulns) first.`,
      );
    /* Never relaxed (FACTS_DEPLOY_FORCE included): uncommitted or untracked
       files baked here would ship once and vanish on the next weekly refresh. */
    const tree = cur ? bakedTreeProblem(cur) : null;
    if (tree) problems.push(tree);
    if (agentGeneratedAt && data.generatedAt && data.generatedAt !== agentGeneratedAt)
      problems.push(
        `the bake mixes two analyses (human.json ${data.generatedAt}, agent.json ${agentGeneratedAt}) — ` +
          're-run a full `factstack analyze .` (and scan-vulns), then rebuild.',
      );
    const points = Array.isArray(data.history) ? data.history.length : 0;
    if (points < 2 && !allowHistoryReset)
      problems.push(
        `the bake carries ${points} History point(s) — run scripts/carry-history.mjs first (or set FACTS_ALLOW_HISTORY_RESET=1).`,
      );
    else if (points < minHistory && !allowHistoryReset)
      problems.push(
        `the bake carries ${points} History point(s), fewer than the ${minHistory} live ones — ` +
          'carry the History AFTER analyze (its snapshot retention prunes the oldest carried points).',
      );
  }
  /* The pack is a separate file with its own copy of the git topology. */
  const packPath = join(dist, 'factstack.pack');
  if (existsSync(packPath))
    for (const p of publicPackProblems(readFileSync(packPath, 'utf8')))
      problems.push(`/factstack.pack is not public: it ${p}`);
  return problems;
}

/** FACTS_DEPLOY_FORCE applies to the pre-build gates only (see the header). */
export const forceApplies = (phase, env = process.env) =>
  phase === 'pre' && env.FACTS_DEPLOY_FORCE === '1';

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function main() {
  const phase = process.argv[2];
  const here = dirname(fileURLToPath(import.meta.url));
  const appDir = resolve(here, '..');
  const root = resolve(appDir, '..', '..');
  let problems;
  if (phase === 'pre') {
    try {
      problems = preflightProblems({
        porcelain: git(root, ['status', '--porcelain']),
        remoteBranches: git(root, ['branch', '-r', '--contains', 'HEAD']),
      });
    } catch (e) {
      problems = [`git failed (${e?.message || e}) — run the deploy from a git checkout.`];
    }
  } else if (phase === 'post') {
    const arg = (name) => {
      const i = process.argv.indexOf(name);
      return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
    };
    const dist = arg('--dist') ? resolve(arg('--dist')) : join(appDir, 'dist');
    let head = null;
    let agentGeneratedAt = null;
    try {
      // cwd, not the script's checkout: CI runs a copy of this script from $RUNNER_TEMP.
      head = git(process.cwd(), ['rev-parse', 'HEAD']).trim();
      const top = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
      const agentPath = join(top, '.facts', 'agent.json');
      if (existsSync(agentPath))
        agentGeneratedAt = JSON.parse(readFileSync(agentPath, 'utf8'))?.generatedAt ?? null;
    } catch {
      /* not a git checkout (the pre phase already said so), or no readable agent.json */
    }
    problems = postBuildProblems(dist, {
      allowHistoryReset: process.env.FACTS_ALLOW_HISTORY_RESET === '1',
      head,
      agentGeneratedAt,
      minHistory: Number(arg('--min-history')) || 0,
    });
  } else {
    console.error(
      'usage: node scripts/deploy-check.mjs pre | post [--dist <dir>] [--min-history <n>]',
    );
    process.exit(2);
  }
  if (problems.length === 0) {
    console.log(`[deploy-check] ${phase}: OK`);
    return;
  }
  const force = forceApplies(phase);
  for (const p of problems) console[force ? 'warn' : 'error'](`[deploy-check] ${phase}: ${p}`);
  if (force) {
    console.warn('[deploy-check] FACTS_DEPLOY_FORCE=1 — continuing anyway.');
    return;
  }
  if (process.env.FACTS_DEPLOY_FORCE === '1')
    console.error('[deploy-check] FACTS_DEPLOY_FORCE=1 does not apply to the post-build checks.');
  process.exit(1);
}

/* Run only as a script, not when imported by the test suite. */
if (isMain(import.meta.url)) main();
