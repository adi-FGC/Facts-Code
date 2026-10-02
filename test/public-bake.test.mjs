/**
 * Public bakes carry only the clean current checkout (owner decision
 * 2026-09-24) — apps/ui-remix/scripts/lib/public-bake.mjs + inject-data.mjs.
 *
 * Regression: the production bake published every laptop checkout (dirty
 * counts, readiness), local branch names and — when present — the subjects of
 * unpushed commits, in /data/factstack.json, index.html and /factstack.pack.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  publicBakeProblems,
  publicGitTopology,
  publicPackProblems,
} from '../apps/ui-remix/scripts/lib/public-bake.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'apps/ui-remix');
const SECRET = 'SECRET-unpushed-subject-7f3a';

const wt = (over) => ({
  path: '/w/main',
  relPath: '.',
  kind: 'main',
  isCurrent: false,
  branch: 'main',
  head: 'a'.repeat(40),
  publish: 'pushed',
  tree: 'clean',
  dirty: { staged: 0, modified: 0, untracked: 0, conflicts: 0 },
  uniqueCommits: [],
  requests: [],
  features: [],
  readiness: { commit: 'nothing', commitReasons: [], deploy: 'ready', deployReasons: [] },
  gaps: [],
  ...over,
});
const br = (over) => ({
  name: 'main',
  head: 'a'.repeat(40),
  subject: 'pushed subject',
  isDefault: false,
  upstream: 'origin/main',
  upstreamGone: false,
  ahead: 0,
  worktree: null,
  deletable: false,
  deleteBlockers: [],
  ...over,
});

describe('publicGitTopology', () => {
  const git = {
    stashes: 2,
    worktrees: [
      wt({
        path: '/w/laptop',
        isCurrent: false,
        dirty: { staged: 0, modified: 64, untracked: 5, conflicts: 0 },
      }),
      wt({
        path: '/w/current',
        isCurrent: true,
        branch: 'feat/x',
        publish: 'ahead',
        uniqueCommits: [{ sha: 'b', at: '2026-01-01', subject: SECRET }],
        features: [
          { id: 'c', source: 'commit', label: SECRET, at: null },
          { id: 'b:feat/x', source: 'branch', label: 'feat x', at: null },
        ],
      }),
    ],
    branches: [
      br({
        name: 'main',
        isDefault: true,
        worktree: '/w/laptop',
        deleteBlockers: ['checked out at /w/laptop'],
      }),
      br({ name: 'feat/x', ahead: 2, subject: SECRET, worktree: '/w/current' }),
      br({ name: 'local-only', upstream: null }),
      br({ name: 'integrate/other' }),
    ],
  };
  const pub = publicGitTopology(git);

  it('keeps only the current checkout', () => {
    expect(pub.worktrees.map((w) => w.path)).toEqual(['/w/current']);
  });

  it('drops unpushed commit subjects but keeps the branch feature', () => {
    expect(JSON.stringify(pub)).not.toContain(SECRET);
    expect(pub.worktrees[0].features.map((f) => f.source)).toEqual(['branch']);
  });

  it('keeps only published default + current branches, without hidden-checkout references', () => {
    expect(pub.branches.map((b) => b.name)).toEqual(['main', 'feat/x']);
    expect(pub.branches[0]).toMatchObject({ worktree: null, deleteBlockers: [] });
    expect(pub.stashes).toBe(0);
    expect(publicBakeProblems({ git: pub })).toEqual([]);
    expect(publicBakeProblems({ git })).toHaveLength(3);
  });

  it('keeps unique commits once the branch is fully pushed', () => {
    const pushed = publicGitTopology({
      ...git,
      worktrees: [
        wt({
          isCurrent: true,
          publish: 'pushed',
          uniqueCommits: [{ sha: 'b', at: 'x', subject: 'public' }],
        }),
      ],
    });
    expect(pushed.worktrees[0].uniqueCommits).toHaveLength(1);
  });
});

/* End to end: run the real inject-data.mjs over a copy of this checkout's
   .facts/ with a hidden sibling checkout + local branch planted in it. */
const facts = join(ROOT, '.facts');
const haveFacts = ['agent.json', 'human.json', 'agent.pack'].every((f) =>
  existsSync(join(facts, f)),
);
const agent = haveFacts ? JSON.parse(readFileSync(join(facts, 'agent.json'), 'utf8')) : null;

describe.skipIf(!agent?.git)('inject-data.mjs public bake (end to end)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fx-bake-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const root = join(tmp, 'repo');
  mkdirSync(join(root, '.facts'), { recursive: true });
  const planted = JSON.parse(JSON.stringify(agent));
  const cur = planted.git.worktrees.find((w) => w.isCurrent) ?? planted.git.worktrees[0];
  planted.git.worktrees.push({
    ...JSON.parse(JSON.stringify(cur)),
    path: 'Z:/elsewhere/hidden-checkout',
    relPath: null,
    isCurrent: false,
    branch: 'hidden-local',
    publish: 'no-upstream',
    uniqueCommits: [{ sha: 'f'.repeat(40), at: '2026-09-01T00:00:00Z', subject: SECRET }],
    features: [{ id: 'w9:fff', source: 'commit', label: SECRET, at: null }],
  });
  planted.git.branches.push({
    ...planted.git.branches[0],
    name: 'hidden-local',
    upstream: null,
    subject: SECRET,
    isDefault: false,
  });
  planted.git.stashes = 3;
  writeFileSync(join(root, '.facts', 'agent.json'), JSON.stringify(planted));
  writeFileSync(join(root, '.facts', 'agent.pack'), readFileSync(join(facts, 'agent.pack')));
  /* One analysis, as inject-data requires: a per-edit `--minimal` run may
     have rewritten this checkout's human.json since its last full analyze. */
  const human = JSON.parse(readFileSync(join(facts, 'human.json'), 'utf8'));
  writeFileSync(
    join(root, '.facts', 'human.json'),
    JSON.stringify({ ...human, generatedAt: planted.generatedAt }),
  );

  const bake = (dist, extra = []) => {
    mkdirSync(dist, { recursive: true });
    writeFileSync(
      join(dist, 'index.html'),
      '<!doctype html><script id="factstack-data" type="application/json">__INLINE_FACTSTACK_JSON__</script>',
    );
    const r = spawnSync(
      process.execPath,
      [
        join(APP, 'node_modules/tsx/dist/cli.mjs'),
        'scripts/inject-data.mjs',
        '--root',
        root,
        '--dist',
        dist,
        ...extra,
      ],
      { cwd: APP, encoding: 'utf8' },
    );
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(readFileSync(join(dist, 'data', 'factstack.json'), 'utf8'));
  };

  it('publishes one worktree, no local branch, no unpushed subject — in the JSON, the HTML and the pack', () => {
    const dist = join(tmp, 'dist');
    const data = bake(dist);
    expect(publicBakeProblems(data)).toEqual([]);
    expect(data.git.worktrees).toHaveLength(1);
    for (const f of ['data/factstack.json', 'index.html', 'factstack.pack']) {
      const body = readFileSync(join(dist, ...f.split('/')), 'utf8');
      expect(body, f).not.toContain(SECRET);
      expect(body, f).not.toContain('hidden-local');
    }
    const pack = readFileSync(join(dist, 'factstack.pack'), 'utf8').split('\n');
    const rowsOf = (table) => {
      const at = pack.findIndex((l) => l.startsWith(`& ${table}\t`));
      const rows = [];
      for (let i = at + 1; i < pack.length && /^[-+x] /.test(pack[i]); i++) rows.push(pack[i]);
      return rows;
    };
    expect(rowsOf('worktrees')).toHaveLength(1);
    expect(pack.filter((l) => /^@ W\d+=/.test(l))).toHaveLength(1);
    expect(pack.find((l) => l.startsWith('; git:'))).toMatch(/stashes=0/);
    expect(publicPackProblems(pack.join('\n'))).toEqual([]);
  });

  it('--full-git keeps every checkout (private local builds only)', () => {
    const data = bake(join(tmp, 'dist-full'), ['--full-git']);
    expect(data.git.worktrees.length).toBe(planted.git.worktrees.length);
  });
});

/* Regression: the per-edit `analyze --minimal` rewrites human.json
   (tree, risks, health — possibly from a dirty tree) and only MARKS
   agent.json stale. The bake paired the two anyway, and re-encoded the pack
   from the older agent.json, so /data/factstack.json and /factstack.pack
   disagreed. */
describe('inject-data.mjs bakes one analysis or nothing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fx-bake-stale-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const AT = '2026-10-01T09:00:00.000Z';

  const run = (name, { humanAt = AT, staleMark = false } = {}) => {
    const root = join(tmp, name);
    mkdirSync(join(root, '.facts'), { recursive: true });
    writeFileSync(join(root, '.facts', 'agent.json'), JSON.stringify({ generatedAt: AT }));
    writeFileSync(join(root, '.facts', 'human.json'), JSON.stringify({ generatedAt: humanAt }));
    if (staleMark)
      writeFileSync(
        join(root, '.facts', 'agent.json.stale'),
        JSON.stringify({ file: 'agent.json', staleSince: '2026-10-02T09:00:00.000Z' }),
      );
    const dist = join(tmp, `${name}-dist`);
    mkdirSync(dist, { recursive: true });
    return spawnSync(
      process.execPath,
      [
        join(APP, 'node_modules/tsx/dist/cli.mjs'),
        'scripts/inject-data.mjs',
        '--root',
        root,
        '--dist',
        dist,
      ],
      { cwd: APP, encoding: 'utf8' },
    );
  };

  it('refuses when agent.json is marked stale', () => {
    const r = run('stale', { staleMark: true });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(
      /refusing to bake: \.facts\/agent\.json is older than the newest analysis/,
    );
    expect(r.stderr).toMatch(/Run a full `factstack analyze \.`/);
  });

  it('refuses when human.json and agent.json come from different analyses', () => {
    const r = run('mixed', { humanAt: '2026-10-02T09:00:00.000Z' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/human\.json \(2026-10-02T09:00:00\.000Z\) and \.facts\/agent\.json/);
  });
});

/* A raw .facts/agent.pack as analyze writes it: every checkout, a local-only
   branch, the stash count. */
const LEAKY_PACK = [
  '# factstack/0.3.10\tagent-v4\t2026-09-24T00:00:00.000Z\t3\t1\t-\tmaster\t2026-09-24T00:00:00.000Z',
  '; git: repo-level scan facts — root=/r default=main stashes=2',
  '& worktrees\tpath\tkind\tbranch',
  '- /w/current\tmain\tmain',
  '- /w/hidden-checkout\tlinked\thidden-local',
  '& branches\tname\thead\thead_at\tupstream',
  '- main\taaa\t-\torigin/main',
  '- hidden-local\tbbb\t-\t-',
  '; end rows=4 tables=2 sha256=000000000000',
  '',
].join('\n');

describe('publicPackProblems', () => {
  it('flags extra worktrees, local-only branches and a stash count in a pack', () => {
    expect(publicPackProblems(LEAKY_PACK)).toEqual([
      'bakes 2 worktrees — a public bake carries only the current checkout.',
      'bakes 1 local-only branch(es).',
      'bakes the local stash count.',
    ]);
  });

  it('passes a narrowed pack (and a pack with no git tables)', () => {
    const pub = LEAKY_PACK.replace('- /w/hidden-checkout\tlinked\thidden-local\n', '')
      .replace('- hidden-local\tbbb\t-\t-\n', '')
      .replace('stashes=2', 'stashes=0');
    expect(publicPackProblems(pub)).toEqual([]);
    expect(publicPackProblems('# factstack\n; end rows=0 tables=0 sha256=000000000000\n')).toEqual(
      [],
    );
  });
});

/* Regression: with `--src` or the fixture fallback there is no agent.json to
   re-encode a narrowed pack from, and the raw .facts/agent.pack (every
   checkout, local branches, stash count) was copied to /factstack.pack while
   the JSON was narrowed — so the post-build check passed. */
describe('inject-data.mjs without .facts/agent.json never publishes the raw pack', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fx-bake-src-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const DATASET = { project: { name: 'demo' }, stats: { files: 1 }, docs: [] };

  const bake = (root, dist, extra = []) => {
    mkdirSync(join(root, '.facts'), { recursive: true });
    writeFileSync(join(root, '.facts', 'agent.pack'), LEAKY_PACK);
    mkdirSync(dist, { recursive: true });
    writeFileSync(
      join(dist, 'index.html'),
      '<!doctype html><script id="factstack-data" type="application/json">__INLINE_FACTSTACK_JSON__</script>',
    );
    const r = spawnSync(
      process.execPath,
      [
        join(APP, 'node_modules/tsx/dist/cli.mjs'),
        'scripts/inject-data.mjs',
        '--root',
        root,
        '--dist',
        dist,
        ...extra,
      ],
      { cwd: APP, encoding: 'utf8' },
    );
    expect(r.status, r.stderr).toBe(0);
    return r.stdout;
  };

  it('--src <dataset>: no /factstack.pack, and the log says why', () => {
    const src = join(tmp, 'dataset.json');
    writeFileSync(src, JSON.stringify(DATASET));
    const dist = join(tmp, 'dist-src');
    const out = bake(join(tmp, 'repo-src'), dist, ['--src', src]);
    expect(existsSync(join(dist, 'factstack.pack'))).toBe(false);
    expect(out).toMatch(/not publishing \.facts\/agent\.pack/);
  });

  it('fixture fallback: no /factstack.pack', () => {
    const root = join(tmp, 'repo-fixture');
    mkdirSync(join(root, 'legacy', 'prototype', 'data'), { recursive: true });
    writeFileSync(
      join(root, 'legacy', 'prototype', 'data', 'factstack.json'),
      JSON.stringify(DATASET),
    );
    const dist = join(tmp, 'dist-fixture');
    bake(root, dist);
    expect(existsSync(join(dist, 'factstack.pack'))).toBe(false);
  });

  it('--full-git still copies it (private local builds only)', () => {
    const src = join(tmp, 'dataset.json');
    writeFileSync(src, JSON.stringify(DATASET));
    const dist = join(tmp, 'dist-full');
    bake(join(tmp, 'repo-full'), dist, ['--src', src, '--full-git']);
    expect(readFileSync(join(dist, 'factstack.pack'), 'utf8')).toContain('hidden-checkout');
  });
});
