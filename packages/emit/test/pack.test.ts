/**
 * Tests for the agent → FactsPack emission. This is integration-shaped:
 * we build a small but realistic AgentArtifact and assert the PACK
 * round-trips, that the byte count beats the JSON equivalent, and that
 * each of the 6 tables is present with the right columns.
 */

import { describe, expect, it } from 'vitest';
import { decode } from '@factstack/factspack';
import type { AgentArtifact } from '@factstack/spec';
import { FACTS_SCHEMA_VERSION } from '@factstack/spec';
import { encodeAgentPack } from '../src/pack.js';

function makeAgent(): AgentArtifact {
  return {
    $schema: 'https://factstack.dev/schema/agent.v1.json',
    factsVersion: FACTS_SCHEMA_VERSION,
    generatedAt: '2026-05-02T12:00:00.000Z',
    project: {
      name: 'demo',
      root: '.',
      languages: ['TypeScript', 'JavaScript'],
      frameworks: ['Vite', 'React'],
      entryPoints: ['npm run dev'],
      monorepo: null,
      gitAvailable: true,
    },
    files: [
      {
        path: 'src/auth.ts',
        language: 'typescript',
        loc: 80,
        bytes: 1500,
        bundleSize: { raw: 1500, minified: 1200, gzipped: 480 },
        tokenCost: 320,
        imports: [],
        exports: [{ name: 'login', kind: 'function', isDefault: false }],
        declarations: [
          { name: 'login', kind: 'function', startLine: 12, endLine: 30, exported: true },
          { name: 'logout', kind: 'function', startLine: 35, endLine: 50, exported: true },
        ],
        todos: [],
        complexity: { cyclomatic: 0, cognitive: 0 },
        status: 'ok',
        lastModifiedMs: 1714600000000,
        churnScore: 5,
        readingMinutes: 3.5,
      },
      {
        path: 'src/users.ts',
        language: 'typescript',
        loc: 60,
        bytes: 1100,
        bundleSize: null,
        tokenCost: 240,
        imports: [],
        exports: [],
        declarations: [{ name: 'User', kind: 'class', startLine: 5, endLine: 30, exported: true }],
        todos: [],
        complexity: { cyclomatic: 0, cognitive: 0 },
        status: 'stale',
        lastModifiedMs: null,
        churnScore: null,
        readingMinutes: 2.5,
      },
    ],
    graph: {
      nodes: [],
      edges: [
        { from: 'src/auth.ts', to: 'src/users.ts', kind: 'import' },
        { from: 'src/auth.ts', to: 'src/users.ts', kind: 'type-import' },
      ],
      cycles: [],
      callerIndex: {},
      workspaces: [],
    },
    routes: [
      {
        framework: 'express',
        method: 'GET',
        path: '/api/users',
        handlerFile: 'src/auth.ts',
        handlerSymbol: 'list',
      },
      {
        framework: 'express',
        method: 'POST',
        path: '/api/users',
        handlerFile: 'src/auth.ts',
        handlerSymbol: 'create',
      },
    ],
    scripts: { dev: 'vite', build: 'vite build' },
    capabilities: ['Renders a React UI'],
    risks: [
      {
        severity: 'high',
        category: 'secret',
        rule: 'aws-access-key',
        file: 'src/secrets.ts',
        line: 12,
        message: 'An AWS access key is hardcoded in src/secrets.ts. Rotate it now.',
        messageTechnical: 'Detected AKIA**** signature with high entropy at line 12.',
      },
    ],
    stats: { loc: 140, fileCount: 2, packageCount: 1, totalTokenCost: 560 },
    config: {
      envVars: [
        {
          name: 'DATABASE_URL',
          reads: [
            { file: 'src/auth.ts', line: 5, access: 'process.env', defaultValue: null },
            { file: 'src/users.ts', line: 3, access: 'process.env', defaultValue: null },
          ],
          defaults: [],
          primaryAccess: 'process.env',
        },
      ],
      schemas: [],
    },
  };
}

describe('encodeAgentPack — shape + content', () => {
  it('emits a v4 header line with producer + schema + snapshotId + rowCount + chain fields', () => {
    const pack = encodeAgentPack(makeAgent());
    expect(pack.startsWith('# factstack/0.3.10\tagent-v4\t')).toBe(true);
    // v0.2 chain fields are appended after rowCount: seq, parent, kind, generated.
    const header = pack.split('\n', 1)[0] as string;
    const fields = header.replace(/^# /, '').split('\t');
    expect(fields.length).toBeGreaterThanOrEqual(8);
    expect(fields[6]).toMatch(/^(master|diff)$/);
  });

  it('emits all sixteen tables in fixed order', () => {
    const pack = encodeAgentPack(makeAgent());
    const order = [
      pack.indexOf('& top'),
      pack.indexOf('& files'),
      pack.indexOf('& imports'),
      pack.indexOf('& routes'),
      pack.indexOf('& risks'),
      pack.indexOf('& envs'),
      pack.indexOf('& declarations'),
      pack.indexOf('& symbols'),
      pack.indexOf('& calls'),
      pack.indexOf('& nodeMetrics'),
      pack.indexOf('& rationale'),
      pack.indexOf('& entities'),
      pack.indexOf('& entityEdges'),
      pack.indexOf('& worktrees'),
      pack.indexOf('& branches'),
      pack.indexOf('& features'),
    ];
    // Every table is present (F2 added symbols + calls; F5 added nodeMetrics;
    // F10 added rationale; F11 added entities + entityEdges; the agent-v4 `top`
    // digest leads; v0.3.11 added worktrees + branches + features) — emitted
    // even when empty, so the 16-table shape is stable.
    expect(order.every((i) => i >= 0)).toBe(true);
    // And in the documented order.
    for (let i = 1; i < order.length; i++) {
      expect(order[i]!).toBeGreaterThan(order[i - 1]!);
    }
  });

  it('F5: nodeMetrics table carries importance + community', () => {
    const agent = makeAgent();
    agent.graph.nodes = [
      {
        id: 'src/auth.ts',
        path: 'src/auth.ts',
        language: 'typescript',
        loc: 80,
        tokenCost: 320,
        status: 'ok',
        importance: 1,
        community: 0,
      },
      {
        id: 'src/users.ts',
        path: 'src/users.ts',
        language: 'typescript',
        loc: 60,
        tokenCost: 240,
        status: 'stale',
        importance: 0.42,
        community: 1,
      },
    ];
    const pack = encodeAgentPack(agent);
    expect(pack).toContain('& nodeMetrics');
    const decoded = decode(pack);
    const nm = decoded.tables.get('nodeMetrics')!;
    expect(nm.rows).toHaveLength(2);
    const auth = nm.rows.find((r) => r[0] === 'src/auth.ts')!;
    expect(auth[1]).toBe('1'); // importance
    expect(auth[2]).toBe('0'); // community
    const users = nm.rows.find((r) => r[0] === 'src/users.ts')!;
    expect(users[1]).toBe('0.42');
    expect(users[2]).toBe('1');
  });

  it('F2: symbols + calls tables carry the symbol graph', () => {
    const agent = makeAgent();
    agent.graph.symbolNodes = [
      {
        id: 'a.ts#caller@1',
        path: 'a.ts',
        name: 'caller',
        kind: 'function',
        startLine: 1,
        endLine: 9,
        exported: true,
      },
      {
        id: 'a.ts#helper@11',
        path: 'a.ts',
        name: 'helper',
        kind: 'function',
        startLine: 11,
        endLine: 13,
        exported: false,
      },
    ];
    agent.graph.symbolEdges = [
      { from: 'a.ts#caller@1', to: 'a.ts#helper@11', kind: 'call', confidence: 'extracted' },
    ];
    const pack = encodeAgentPack(agent);
    expect(pack).toContain('& symbols');
    expect(pack).toContain('& calls');
    expect(pack).toContain('caller'); // symbol name (literal in symbols)
    expect(pack).toContain('a.ts#helper@11'); // symbol id (symbols PK + calls S/T dict)
    expect(pack.slice(pack.indexOf('& calls'))).toContain('call'); // edge kind literal
  });

  it('F1: imports table carries a conf column; edges default to extracted', () => {
    const pack = encodeAgentPack(makeAgent());
    const afterImports = pack.slice(pack.indexOf('& imports'));
    const importsTable = afterImports.slice(0, afterImports.indexOf('& routes'));
    expect(importsTable).toContain('conf'); // the new agent-v2 column header
    expect(importsTable).toContain('extracted'); // edges without explicit confidence
  });

  it('round-trips decode → expected row counts per table', () => {
    const pack = encodeAgentPack(makeAgent());
    const decoded = decode(pack);
    expect(decoded.tables.get('files')!.rows).toHaveLength(2);
    expect(decoded.tables.get('imports')!.rows).toHaveLength(2);
    expect(decoded.tables.get('routes')!.rows).toHaveLength(2);
    expect(decoded.tables.get('risks')!.rows).toHaveLength(1);
    expect(decoded.tables.get('envs')!.rows).toHaveLength(2);
    expect(decoded.tables.get('declarations')!.rows).toHaveLength(3);
  });

  it('preserves file metadata through the round-trip', () => {
    const pack = encodeAgentPack(makeAgent());
    const decoded = decode(pack);
    const files = decoded.tables.get('files')!;
    const auth = files.rows.find((r) => r[0] === 'src/auth.ts')!;
    // path | L | loc | tok | bytes | gz | status | mtime | churn | read
    expect(auth[0]).toBe('src/auth.ts');
    expect(auth[1]).toBe('typescript');
    expect(auth[2]).toBe('80');
    expect(auth[3]).toBe('320');
    expect(auth[5]).toBe('480'); // gz
    expect(auth[6]).toBe('ok');
    expect(auth[8]).toBe('5'); // churn
    expect(auth[9]).toBe('3.5'); // read
  });

  it('emits null gz / churn / mtime as bare `-` when missing', () => {
    const pack = encodeAgentPack(makeAgent());
    const decoded = decode(pack);
    const users = decoded.tables.get('files')!.rows.find((r) => r[0] === 'src/users.ts')!;
    expect(users[5]).toBeNull(); // gz
    expect(users[7]).toBeNull(); // mtime
    expect(users[8]).toBeNull(); // churn
  });

  it('preserves declaration metadata + exported flag as 1/0', () => {
    const pack = encodeAgentPack(makeAgent());
    const decoded = decode(pack);
    const decls = decoded.tables.get('declarations')!.rows;
    const login = decls.find((r) => r[2] === 'login')!;
    expect(login[1]).toBe('src/auth.ts');
    expect(login[3]).toBe('function');
    expect(login[4]).toBe('12');
    expect(login[5]).toBe('30');
    expect(login[6]).toBe('1'); // exported
  });

  it('preserves risk messageTechnical alongside CXO message', () => {
    const pack = encodeAgentPack(makeAgent());
    const decoded = decode(pack);
    const risks = decoded.tables.get('risks')!.rows;
    expect(risks[0]![6]).toContain('Rotate'); // CXO message
    expect(risks[0]![7]).toContain('AKIA'); // technical
  });

  it('flattens env vars to one row per read site', () => {
    const pack = encodeAgentPack(makeAgent());
    const decoded = decode(pack);
    const envs = decoded.tables.get('envs')!.rows;
    expect(envs).toHaveLength(2);
    expect(envs[0]![1]).toBe('DATABASE_URL');
    expect(envs[1]![1]).toBe('DATABASE_URL');
    expect(envs[0]![4]).toBe('process.env');
  });
});

describe('encodeAgentPack — top table ranking (agent-v4)', () => {
  type Node = NonNullable<AgentArtifact['graph']['nodes']>[number];
  const node = (path: string, importance: number | undefined, extra: Partial<Node> = {}): Node => ({
    id: path,
    path,
    language: 'typescript',
    loc: 5,
    tokenCost: 20,
    status: 'ok',
    community: 0,
    ...(importance != null ? { importance } : {}),
    ...extra,
  });

  it('caps at the 20 most important files, ranked by importance descending', () => {
    const agent = makeAgent();
    // 25 files with importance 0.01 … 0.25 — only the top 20 (0.06 … 0.25) survive.
    agent.graph.nodes = Array.from({ length: 25 }, (_, i) => node(`f${i}.ts`, (i + 1) / 100));
    const top = decode(encodeAgentPack(agent)).tables.get('top')!;
    expect(top.rows).toHaveLength(20); // TOP_FILES cap
    expect(top.rows[0]![0]).toBe('f24.ts'); // highest importance first
    expect(top.rows[0]![1]).toBe('0.25');
    expect(top.rows[19]![0]).toBe('f5.ts'); // 20th = importance 0.06; f0..f4 dropped
    const imps = top.rows.map((r) => Number(r[1]));
    for (let i = 1; i < imps.length; i++) expect(imps[i]!).toBeLessThanOrEqual(imps[i - 1]!);
  });

  it('excludes nodes with null importance (never ranked)', () => {
    const agent = makeAgent();
    agent.graph.nodes = [node('ranked.ts', 0.9), node('unranked.ts', undefined)];
    const top = decode(encodeAgentPack(agent)).tables.get('top')!;
    expect(top.rows.map((r) => r[0])).toEqual(['ranked.ts']);
  });

  it('breaks importance ties by path ascending (byte-determinism)', () => {
    const agent = makeAgent();
    agent.graph.nodes = [node('zeta.ts', 0.5), node('alpha.ts', 0.5)];
    const top = decode(encodeAgentPack(agent)).tables.get('top')!;
    expect(top.rows.map((r) => r[0])).toEqual(['alpha.ts', 'zeta.ts']);
  });

  it('reports in_deg from node.callers when present', () => {
    const agent = makeAgent();
    agent.graph.nodes = [node('hub.ts', 0.9, { callers: ['x.ts', 'y.ts', 'z.ts'] })];
    const top = decode(encodeAgentPack(agent)).tables.get('top')!;
    expect(top.rows[0]![2]).toBe('3');
  });

  it('falls back to counting import edges for in_deg when callers are absent', () => {
    const agent = makeAgent(); // has two edges src/auth.ts -> src/users.ts (import + type-import)
    agent.graph.nodes = [node('src/users.ts', 0.9)];
    const top = decode(encodeAgentPack(agent)).tables.get('top')!;
    expect(top.rows.find((r) => r[0] === 'src/users.ts')![2]).toBe('2');
  });
});

describe('encodeAgentPack — byte cost', () => {
  it('data rows beat JSON; the fixed self-description overhead stays bounded', () => {
    const agent = makeAgent();
    const pack = encodeAgentPack(agent);
    const json = JSON.stringify(agent);
    /* v0.2 carries a fixed self-description block (legend, hot hints, trailer)
       that amortizes to noise on real repos but dominates this 2-file fixture.
       So the compression property is asserted on the DATA portion, and the
       overhead is pinned separately so it can't silently balloon. */
    const meta = pack
      .split('\n')
      .filter((l) => l.startsWith('; '))
      .join('\n');
    const dataLength = pack.length - meta.length;
    expect(dataLength).toBeLessThan(json.length);
    /* v0.3.11 added three tables + a gap-code line to the legend (~1.8 KB);
       the block is still fixed-size and amortizes on real repos. */
    expect(meta.length).toBeLessThan(5600);
    /* The 50%-on-real-data measurement happens in the workspace-level
       integration test against .facts/agent.json. */
  });
});

/* ───────────── v0.3.11 — worktrees / branches / features ───────────── */

describe('encodeAgentPack — worktrees / branches / features (v0.3.11)', () => {
  function makeTopology(): NonNullable<AgentArtifact['git']> {
    const mainPath = 'D:/repo';
    const linkedPath = 'D:/repo/.claude/worktrees/feature-x';
    return {
      scannedAt: '2026-09-06T10:00:00Z',
      repoRoot: mainPath,
      currentPath: mainPath,
      defaultBranch: 'main',
      originDefault: 'origin/main',
      remotes: [{ name: 'origin', url: 'https://example.invalid/repo.git' }],
      remoteRefsAgeDays: 0.5,
      stashes: 1,
      worktrees: [
        {
          path: mainPath,
          relPath: '.',
          kind: 'main',
          isCurrent: true,
          target: null,
          bare: false,
          locked: false,
          lockReason: null,
          prunable: false,
          branch: 'main',
          head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          headAt: '2026-09-04T01:18:31Z',
          upstream: 'origin/main',
          ahead: 0,
          behind: 0,
          integration: 'default',
          publish: 'pushed',
          tree: 'clean',
          inProgress: null,
          dirty: { staged: 0, modified: 0, untracked: 0, conflicts: 0 },
          compareBase: 'refs/remotes/origin/main',
          uniqueCount: 0,
          uniqueCommits: [],
          requests: [],
          sessions: 0,
          requestedAt: null,
          lastActivityAt: '2026-09-04T01:18:31Z',
          stale: false,
          features: [],
          deployTargets: ['wrangler.toml'],
          ci: true,
          testScript: true,
          readiness: {
            commit: 'nothing',
            commitReasons: ['working tree clean'],
            deploy: 'ready',
            deployReasons: ['on origin/main · wrangler.toml'],
          },
          gaps: ['no-request-record'],
        },
        {
          path: linkedPath,
          relPath: '.claude/worktrees/feature-x',
          kind: 'linked',
          isCurrent: false,
          target: null,
          bare: false,
          locked: false,
          lockReason: null,
          prunable: false,
          branch: 'feat/x',
          head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          headAt: '2026-09-05T08:00:00Z',
          upstream: null,
          ahead: null,
          behind: null,
          integration: 'unmerged',
          publish: 'no-upstream',
          tree: 'dirty',
          inProgress: null,
          dirty: { staged: 2, modified: 1, untracked: 3, conflicts: 0 },
          compareBase: 'refs/heads/main',
          uniqueCount: 1,
          uniqueCommits: [
            {
              sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              at: '2026-09-05T08:00:00Z',
              subject: 'feat(x): add the x panel',
            },
          ],
          requests: [
            {
              agent: 'claude-code',
              sessionId: '0123456789abcdef',
              startedAt: '2026-09-03T09:00:00Z',
              lastAt: '2026-09-05T09:00:00Z',
              prompt: 'build the x panel',
              title: null,
              via: 'cwd',
            },
          ],
          sessions: 1,
          requestedAt: '2026-09-03T09:00:00Z',
          lastActivityAt: '2026-09-05T09:00:00Z',
          stale: false,
          features: [
            {
              id: 'bbbbbbb',
              source: 'commit',
              label: 'x: add the x panel',
              at: '2026-09-05T08:00:00Z',
            },
            {
              id: 'r:01234567',
              source: 'request',
              label: 'build the x panel',
              at: '2026-09-03T09:00:00Z',
            },
            { id: 'b:feat/x', source: 'branch', label: 'x', at: null },
          ],
          deployTargets: [],
          ci: false,
          testScript: true,
          readiness: {
            commit: 'partial',
            commitReasons: ['2 files staged', '1 file modified, unstaged', '3 untracked files'],
            deploy: 'blocked',
            deployReasons: ['commit or discard 6 changes first'],
          },
          gaps: ['no-upstream', 'no-deploy-config', 'no-ci', 'untracked-work'],
        },
      ],
      branches: [
        {
          name: 'main',
          head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          headAt: '2026-09-04T01:18:31Z',
          subject: 'chore: release',
          isDefault: true,
          upstream: 'origin/main',
          upstreamGone: false,
          ahead: 0,
          behind: 0,
          uniqueCount: 0,
          behindDefault: 0,
          containedInOrigin: true,
          containedInLocal: true,
          worktree: mainPath,
          deletable: false,
          deleteBlockers: ['is the default branch', 'checked out at .'],
        },
        {
          name: 'feat/x',
          head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          headAt: '2026-09-05T08:00:00Z',
          subject: 'feat(x): add the x panel',
          isDefault: false,
          upstream: null,
          upstreamGone: false,
          ahead: null,
          behind: null,
          uniqueCount: 1,
          behindDefault: 0,
          containedInOrigin: false,
          containedInLocal: false,
          worktree: linkedPath,
          deletable: false,
          deleteBlockers: [
            'checked out at .claude/worktrees/feature-x',
            '1 commits not in origin/main',
          ],
        },
        {
          name: 'old/merged',
          head: 'cccccccccccccccccccccccccccccccccccccccc',
          headAt: '2026-08-01T00:00:00Z',
          subject: 'fix: typo',
          isDefault: false,
          upstream: 'origin/old/merged',
          upstreamGone: false,
          ahead: 0,
          behind: 0,
          uniqueCount: 0,
          behindDefault: 12,
          containedInOrigin: true,
          containedInLocal: true,
          worktree: null,
          deletable: true,
          deleteBlockers: [],
        },
      ],
      gaps: ['stale-remote-refs'],
      requestsCoverage: 'full',
      elapsedMs: 42,
    };
  }

  it('emits the three tables empty when the artifact carries no git topology', () => {
    const decoded = decode(encodeAgentPack(makeAgent()));
    expect(decoded.tables.get('worktrees')!.rows).toHaveLength(0);
    expect(decoded.tables.get('branches')!.rows).toHaveLength(0);
    expect(decoded.tables.get('features')!.rows).toHaveLength(0);
  });

  it('carries readiness, request dates, features and gaps per worktree', () => {
    const agent = makeAgent();
    agent.git = makeTopology();
    const pack = encodeAgentPack(agent);
    const decoded = decode(pack);

    const wt = decoded.tables.get('worktrees')!;
    expect(wt.rows).toHaveLength(2);
    const linked = wt.rows.find((r) => r[0] === 'D:/repo/.claude/worktrees/feature-x')!;
    expect(linked[1]).toBe('linked');
    expect(linked[2]).toBe('feat/x');
    expect(linked[5]).toBe('dirty');
    expect(linked.slice(6, 10)).toEqual(['2', '1', '3', '0']);
    expect(linked[11]).toBeNull(); // no upstream → null cell
    expect(linked[14]).toBe('1'); // unique commits
    expect(linked[15]).toBe('unmerged');
    expect(linked[16]).toBe('no-upstream');
    expect(linked[17]).toBe('2026-09-03T09:00:00Z'); // requested_at = first agent prompt
    expect(linked[20]).toBe('partial');
    expect(linked[21]).toBe('blocked');
    expect(linked[22]).toBeNull(); // no deploy targets
    expect(linked[23]).toBe('no-upstream,no-deploy-config,no-ci,untracked-work');

    const main = wt.rows.find((r) => r[0] === 'D:/repo')!;
    expect(main[20]).toBe('nothing');
    expect(main[21]).toBe('ready');
    expect(main[22]).toBe('wrangler.toml');

    const br = decoded.tables.get('branches')!;
    expect(br.rows).toHaveLength(3);
    const merged = br.rows.find((r) => r[0] === 'old/merged')!;
    expect(merged[8]).toBe('1'); // merged into origin/main
    expect(merged[12]).toBe('1'); // deletable

    const feats = decoded.tables.get('features')!;
    expect(feats.rows).toHaveLength(3);
    expect(feats.rows.map((r) => r[2])).toEqual(['commit', 'request', 'branch']);
    // Column 0 is the diff chain's primary key: it must stay unique across
    // worktrees (two checkouts on stacked branches share a commit sha).
    expect(feats.rows.map((r) => r[0])).toEqual(['w1:bbbbbbb', 'w1:r:01234567', 'w1:b:feat/x']);
    expect(new Set(feats.rows.map((r) => r[0])).size).toBe(feats.rows.length);
    expect(feats.rows.find((r) => r[2] === 'request')![4]).toBe('build the x panel');
    expect(feats.rows.find((r) => r[2] === 'branch')![3]).toBeNull();

    // Legend documents every new table + the gap codes, in-band.
    expect(pack).toContain('worktrees: path(absolute; PK)');
    expect(pack).toContain('branches: name head head_at');
    expect(pack).toContain('features: id(w<worktree index>:');
    expect(pack).toContain('gaps: codes in worktrees.gaps');
  });

  it('keeps the schema name agent-v4 — additive tables only (wire-compat)', () => {
    const agent = makeAgent();
    agent.git = makeTopology();
    const pack = encodeAgentPack(agent);
    expect(pack.startsWith('# factstack/0.3.10\tagent-v4\t')).toBe(true);
    expect(pack).toMatch(/; end rows=\d+ tables=16 sha256=[0-9a-f]{12}/);
  });
});
