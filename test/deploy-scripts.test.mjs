/**
 * The production deploy path: `pnpm deploy:cf` (apps/ui-remix/package.json),
 * scripts/carry-history.mjs and scripts/deploy-check.mjs.
 *
 * Regressions:
 *  - deploy:cf used a floating wrangler@4 and no --branch, so from any worktree
 *    branch it made a Preview and reported success (production unchanged);
 *  - a manual deploy baked only this checkout's snapshots and wiped the live
 *    History (the carry-forward existed only inline in cve-refresh.yml);
 *  - nothing stopped a deploy without the sign-in config, from a dirty tree,
 *    or with a non-public bake.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  carryHistory,
  historyPoints,
  liveCommit,
  snapshotName,
} from '../apps/ui-remix/scripts/carry-history.mjs';
import {
  bakedTreeProblem,
  forceApplies,
  postBuildProblems,
  preflightProblems,
} from '../apps/ui-remix/scripts/deploy-check.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'apps/ui-remix');
const SHA = '954f38e'.padEnd(40, '0');
const LIVE = {
  history: [
    { at: '2026-09-06T10:00:00.000Z', loc: 1, files: 2, tokens: 3, risks: 4, todos: 5 },
    { at: '2026-09-13T10:00:00.000Z', loc: 2 },
    { at: 'not a date' },
    null,
  ],
  git: {
    worktrees: [
      { isCurrent: false, head: 'b'.repeat(40) },
      { isCurrent: true, head: SHA },
    ],
  },
};

const temps = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'fx-deploy-'));
  temps.push(d);
  return d;
};
afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

describe('deploy:cf', () => {
  const script = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8')).scripts['deploy:cf'];
  const steps = script.split('&&').map((s) => s.trim());
  const at = (re) => steps.findIndex((s) => re.test(s));

  it('always deploys to PRODUCTION with a pinned wrangler', () => {
    const deploy = steps[at(/pages deploy/)];
    expect(deploy).toMatch(/wrangler@\d+\.\d+\.\d+ /);
    expect(deploy).toMatch(/--branch main\b/);
    expect(deploy).toMatch(/--project-name factstack\b/);
  });

  it('gates the upload: preflight → carry History → build → require sign-in config → post-check → deploy', () => {
    const order = [
      at(/deploy-check\.mjs pre/),
      at(/carry-history\.mjs/),
      at(/build:static/),
      at(/gen-fb-config\.mjs --require/),
      at(/deploy-check\.mjs post/),
      at(/pages deploy/),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

/* Regression: netlify.toml ran build:static alone, which only WARNS when no
   Firebase web config is found, so a Netlify build without FACTS_FB_WEB_CONFIG
   would have published a site with no /mcp-auth-config.json — and the MCP's
   default sign-in page lives on that site. */
describe('netlify.toml build', () => {
  const toml = readFileSync(join(ROOT, 'netlify.toml'), 'utf8').replace(/\r\n/g, '\n');
  const build = toml.match(/^\[build\]\n([\s\S]*?)(?=^\[)/m)?.[1] ?? '';
  const command = build.match(/^command = "([^"]*)"$/m)?.[1] ?? '';
  const steps = command.split('&&').map((s) => s.trim());
  const at = (re) => steps.findIndex((s) => re.test(s));

  it('requires the sign-in config after build:static, as the last step', () => {
    expect(at(/build:static$/)).toBeGreaterThanOrEqual(0);
    expect(at(/^node apps\/ui-remix\/scripts\/gen-fb-config\.mjs --require$/)).toBe(
      steps.length - 1,
    );
    expect(at(/--require/)).toBeGreaterThan(at(/build:static$/));
  });
});

describe('carry-history', () => {
  it('reads the points and the live build commit', () => {
    expect(historyPoints(LIVE).map((p) => p.at)).toEqual([LIVE.history[0].at, LIVE.history[1].at]);
    expect(liveCommit(LIVE)).toBe(SHA);
    expect(liveCommit({ git: { worktrees: [{ isCurrent: true, head: 'short' }] } })).toBeNull();
  });

  it('writes missing points as analyze-shaped snapshots and skips ones already present', () => {
    const snaps = tmp();
    // Same `at` under a different file name: still counts as present.
    writeFileSync(
      join(snaps, 'local.json'),
      JSON.stringify({ at: LIVE.history[0].at, stats: { loc: 99 } }),
    );
    expect(carryHistory(LIVE, snaps)).toEqual({ written: 1, present: 1 });
    const file = join(snaps, snapshotName(LIVE.history[1].at));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      at: LIVE.history[1].at,
      stats: { loc: 2, fileCount: 0, totalTokenCost: 0 },
      risks: 0,
      todos: 0,
    });
    expect(carryHistory(LIVE, snaps)).toEqual({ written: 0, present: 2 });
  });

  const cli = (args, env = {}) => {
    const clean = { ...process.env };
    delete clean.FACTS_ALLOW_HISTORY_RESET;
    delete clean.GITHUB_OUTPUT;
    return spawnSync(process.execPath, [join(APP, 'scripts/carry-history.mjs'), ...args], {
      encoding: 'utf8',
      env: { ...clean, ...env },
    });
  };

  it('fails when the live dataset is unreadable, unless a History reset is accepted', () => {
    const root = tmp();
    const missing = join(root, 'nope.json');
    expect(cli(['--from', missing, '--root', root]).status).toBe(1);
    expect(
      cli(['--from', missing, '--root', root], { FACTS_ALLOW_HISTORY_RESET: '1' }).status,
    ).toBe(0);
  });

  it('carries the points and reports the live commit to $GITHUB_OUTPUT', () => {
    const root = tmp();
    const from = join(root, 'live.json');
    const out = join(root, 'gh-output');
    writeFileSync(from, JSON.stringify(LIVE));
    writeFileSync(out, '');
    const r = cli(['--from', from, '--root', root], { GITHUB_OUTPUT: out });
    expect(r.status, r.stderr).toBe(0);
    expect(readdirSync(join(root, '.facts', 'snapshots'))).toHaveLength(2);
    expect(readFileSync(out, 'utf8')).toContain(`live_commit=${SHA}`);
    expect(readFileSync(out, 'utf8')).toContain('points=2');
  });

  /* Regression: the weekly refresh carried the points BEFORE
     analyze, whose 50-snapshot retention then deleted the oldest carried ones
     for good. It now only reads the live build first and carries after. */
  it('--report-only reads and reports the live build but writes no snapshot', () => {
    const root = tmp();
    const from = join(root, 'live.json');
    const out = join(root, 'gh-output');
    writeFileSync(from, JSON.stringify(LIVE));
    writeFileSync(out, '');
    const r = cli(['--from', from, '--root', root, '--report-only'], { GITHUB_OUTPUT: out });
    expect(r.status, r.stderr).toBe(0);
    expect(readdirSync(root)).not.toContain('.facts');
    expect(readFileSync(out, 'utf8')).toContain(`live_commit=${SHA}\npoints=2\n`);
    expect(cli(['--from', join(root, 'nope.json'), '--report-only']).status).toBe(1);
  });
});

describe('deploy-check', () => {
  /* deploy-infra#27: wrangler writes .wrangler/cache/*.json into the
     directory it runs from. Untracked, that failed the next `pre` check's
     clean-tree gate and pushed the owner toward FACTS_DEPLOY_FORCE. The
     repo's own .gitignore must match, not a machine's global excludes. */
  it('pre: the repo .gitignore keeps wrangler state out of the clean-tree check', () => {
    for (const p of ['.wrangler/cache/pages.json', 'apps/ui-remix/.wrangler/cache/x.json']) {
      const r = spawnSync('git', ['check-ignore', '-v', '--no-index', p], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      expect(r.status, `${p}: ${r.stderr}`).toBe(0);
      expect(r.stdout.split(':')[0], p).toBe('.gitignore');
    }
  });

  it('pre: refuses a dirty tree and an unpushed HEAD', () => {
    expect(preflightProblems({ porcelain: '', remoteBranches: '  origin/main\n' })).toEqual([]);
    const dirty = preflightProblems({
      porcelain: ' M a.ts\n?? b.ts\n',
      remoteBranches: 'origin/main',
    })[0];
    expect(dirty).toMatch(/2 uncommitted/);
    // Stashing keeps HEAD and the bake analyzed from the dirty tree.
    expect(dirty).toMatch(/commit them, then re-run `factstack analyze \.`/);
    expect(dirty).not.toMatch(/or stash/);
    expect(preflightProblems({ porcelain: '', remoteBranches: '\n' })[0]).toMatch(
      /not on any remote branch/,
    );
  });

  const dist = ({ cfg, data }) => {
    const d = tmp();
    mkdirSync(join(d, 'data'));
    if (cfg !== undefined) writeFileSync(join(d, 'mcp-auth-config.json'), cfg);
    if (data) writeFileSync(join(d, 'data', 'factstack.json'), JSON.stringify(data));
    return d;
  };
  const CLEAN = {
    isCurrent: true,
    tree: 'clean',
    dirty: { staged: 0, modified: 0, untracked: 0, conflicts: 0 },
  };
  const CFG = '{"apiKey":"k","projectId":"p"}';
  const good = {
    history: [{ at: 'a' }, { at: 'b' }],
    git: {
      stashes: 0,
      worktrees: [CLEAN],
      branches: [{ name: 'main', upstream: 'origin/main' }],
    },
  };
  const withCurrent = (over) => ({
    ...good,
    git: { ...good.git, worktrees: [{ ...CLEAN, ...over }] },
  });

  it('post: passes a complete public build', () => {
    expect(postBuildProblems(dist({ cfg: '{"apiKey":"k","projectId":"p"}', data: good }))).toEqual(
      [],
    );
  });

  it('post: catches a missing or HTML sign-in config, a private bake and a wiped History', () => {
    expect(postBuildProblems(dist({ data: good })).join()).toMatch(
      /mcp-auth-config\.json is missing/,
    );
    expect(postBuildProblems(dist({ cfg: '<!doctype html>', data: good })).join()).toMatch(
      /not valid JSON/,
    );
    const leaky = {
      ...good,
      git: { ...good.git, stashes: 1, worktrees: [{ isCurrent: true }, { isCurrent: false }] },
    };
    expect(
      postBuildProblems(dist({ cfg: '{"apiKey":"k","projectId":"p"}', data: leaky })).join(),
    ).toMatch(/not public/);
    const baked = withCurrent({ head: 'a'.repeat(40) });
    const stale = dist({ cfg: '{"apiKey":"k","projectId":"p"}', data: baked });
    expect(postBuildProblems(stale, { head: 'b'.repeat(40) }).join()).toMatch(
      /re-run `factstack analyze/,
    );
    expect(postBuildProblems(stale, { head: 'a'.repeat(40) })).toEqual([]);
    const onePoint = { ...good, history: [{ at: 'a' }] };
    const d = dist({ cfg: '{"apiKey":"k","projectId":"p"}', data: onePoint });
    expect(postBuildProblems(d).join()).toMatch(/1 History point/);
    expect(postBuildProblems(d, { allowHistoryReset: true })).toEqual([]);
  });

  /* Regression: post compared only the baked head with
     HEAD. A bake analyzed from a dirty tree, followed by a stash or an
     exclude, passed pre (clean now) and post (same HEAD) and published the
     uncommitted and untracked content. */
  it('post: refuses a bake analyzed from a dirty tree, or one that does not record its tree', () => {
    const untracked = withCurrent({
      tree: 'dirty',
      dirty: { staged: 0, modified: 0, untracked: 3, conflicts: 0 },
    });
    const problems = postBuildProblems(dist({ cfg: CFG, data: untracked }));
    expect(problems).toEqual([
      'the bake was analyzed from a tree that was not clean (dirty: 0 staged/modified, 3 untracked, 0 conflicted) — ' +
        'commit or remove them, then re-run `factstack analyze .` (and scan-vulns): a public bake must be exactly a commit.',
    ]);
    expect(bakedTreeProblem({ ...CLEAN, dirty: { ...CLEAN.dirty, modified: 1 } })).toMatch(
      /\(clean: 1 staged\/modified/,
    );
    expect(bakedTreeProblem({ isCurrent: true })).toMatch(/\(state not recorded: /);
    expect(bakedTreeProblem({ ...CLEAN, tree: 'unavailable' })).toMatch(/\(unavailable: /);
    expect(bakedTreeProblem(CLEAN)).toBeNull();
  });

  it('post: FACTS_DEPLOY_FORCE never ships a dirty bake (untracked files included)', () => {
    const d = dist({
      cfg: CFG,
      data: withCurrent({
        tree: 'dirty',
        dirty: { staged: 0, modified: 2, untracked: 1, conflicts: 0 },
      }),
    });
    const env = { ...process.env, FACTS_DEPLOY_FORCE: '1' };
    delete env.FACTS_ALLOW_HISTORY_RESET;
    const r = spawnSync(
      process.execPath,
      [join(APP, 'scripts/deploy-check.mjs'), 'post', '--dist', d],
      {
        encoding: 'utf8',
        env,
        cwd: tmp(),
      },
    );
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(/not clean \(dirty: 2 staged\/modified, 1 untracked/);
    expect(r.stderr).toMatch(/does not apply to the post-build checks/);
  });

  /* Regression: the per-edit `analyze --minimal` rewrites human.json
     only; a bake of it next to the older agent.json mixed two analyses. */
  it('post: refuses a bake whose analysis is not .facts/agent.json', () => {
    const d = dist({ cfg: CFG, data: { ...good, generatedAt: '2026-10-02T10:00:00.000Z' } });
    expect(postBuildProblems(d, { agentGeneratedAt: '2026-10-01T09:00:00.000Z' }).join()).toMatch(
      /mixes two analyses .*re-run a full `factstack analyze \.`/,
    );
    expect(postBuildProblems(d, { agentGeneratedAt: '2026-10-02T10:00:00.000Z' })).toEqual([]);
  });

  /* Regression: the weekly gate passed any History of 2+ points,
     so pruned live points went unnoticed. */
  it('post --min-history: the bake keeps at least every live History point', () => {
    const d = dist({ cfg: CFG, data: good });
    expect(postBuildProblems(d, { minHistory: 3 }).join()).toMatch(
      /2 History point\(s\), fewer than the 3 live ones/,
    );
    expect(postBuildProblems(d, { minHistory: 2 })).toEqual([]);
    const env = { ...process.env };
    delete env.FACTS_ALLOW_HISTORY_RESET;
    delete env.FACTS_DEPLOY_FORCE;
    const run = (...extra) =>
      spawnSync(
        process.execPath,
        [join(APP, 'scripts/deploy-check.mjs'), 'post', '--dist', d, ...extra],
        { encoding: 'utf8', env, cwd: tmp() },
      );
    expect(run('--min-history', '5').status).toBe(1);
    expect(run('--min-history', '').status).toBe(0); // the carry step was skipped
  });

  /* Regression: only the JSON was checked, so a raw pack (every checkout,
     local branches, stash count) next to a narrowed JSON passed. */
  it('post: checks /factstack.pack too', () => {
    const d = dist({ cfg: '{"apiKey":"k","projectId":"p"}', data: good });
    const pack = (wts, stashes) =>
      [
        '# factstack/0.3.10\tagent-v4\t-\t1\t1\t-\tmaster\t-',
        `; git: root=/r stashes=${stashes}`,
        '& worktrees\tpath\tkind',
        ...wts.map((w) => `- ${w}\tlinked`),
        '; end rows=1 tables=1 sha256=000000000000',
      ].join('\n');
    writeFileSync(join(d, 'factstack.pack'), pack(['/w/current'], 0));
    expect(postBuildProblems(d)).toEqual([]);
    writeFileSync(join(d, 'factstack.pack'), pack(['/w/current', '/w/laptop'], 1));
    expect(postBuildProblems(d)).toEqual([
      '/factstack.pack is not public: it bakes 2 worktrees — a public bake carries only the current checkout.',
      '/factstack.pack is not public: it bakes the local stash count.',
    ]);
  });

  /* Regression: FACTS_DEPLOY_FORCE is set for the whole deploy:cf chain, so
     using it to get past a dirty tree also let a missing sign-in config, a
     private bake and a wiped History through `post`. */
  it('FACTS_DEPLOY_FORCE downgrades the pre gates only', () => {
    expect(forceApplies('pre', { FACTS_DEPLOY_FORCE: '1' })).toBe(true);
    expect(forceApplies('post', { FACTS_DEPLOY_FORCE: '1' })).toBe(false);
    expect(forceApplies('pre', {})).toBe(false);
    const env = { ...process.env, FACTS_DEPLOY_FORCE: '1' };
    delete env.FACTS_ALLOW_HISTORY_RESET;
    const r = spawnSync(
      process.execPath,
      [join(APP, 'scripts/deploy-check.mjs'), 'post', '--dist', tmp()],
      { encoding: 'utf8', env },
    );
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(/does not apply to the post-build checks/);
  });
});
