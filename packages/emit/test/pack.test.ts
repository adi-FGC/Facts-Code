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
        declarations: [
          { name: 'User', kind: 'class', startLine: 5, endLine: 30, exported: true },
        ],
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
      { framework: 'express', method: 'GET', path: '/api/users', handlerFile: 'src/auth.ts', handlerSymbol: 'list' },
      { framework: 'express', method: 'POST', path: '/api/users', handlerFile: 'src/auth.ts', handlerSymbol: 'create' },
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
  it('emits a header line with producer + schema + snapshotId + rowCount', () => {
    const pack = encodeAgentPack(makeAgent());
    expect(pack.startsWith('# factstack/0.3.10\tagent-v2\t')).toBe(true);
  });

  it('emits all eight tables in fixed order', () => {
    const pack = encodeAgentPack(makeAgent());
    const order = [
      pack.indexOf('& files'),
      pack.indexOf('& imports'),
      pack.indexOf('& routes'),
      pack.indexOf('& risks'),
      pack.indexOf('& envs'),
      pack.indexOf('& declarations'),
      pack.indexOf('& symbols'),
      pack.indexOf('& calls'),
    ];
    // Every table is present (F2 added symbols + calls, even when empty).
    expect(order.every((i) => i >= 0)).toBe(true);
    // And in the documented order.
    for (let i = 1; i < order.length; i++) {
      expect(order[i]!).toBeGreaterThan(order[i - 1]!);
    }
  });

  it('F2: symbols + calls tables carry the symbol graph', () => {
    const agent = makeAgent();
    agent.graph.symbolNodes = [
      { id: 'a.ts#caller@1', path: 'a.ts', name: 'caller', kind: 'function', startLine: 1, endLine: 9, exported: true },
      { id: 'a.ts#helper@11', path: 'a.ts', name: 'helper', kind: 'function', startLine: 11, endLine: 13, exported: false },
    ];
    agent.graph.symbolEdges = [
      { from: 'a.ts#caller@1', to: 'a.ts#helper@11', kind: 'call', confidence: 'extracted' },
    ];
    const pack = encodeAgentPack(agent);
    expect(pack).toContain('& symbols');
    expect(pack).toContain('& calls');
    expect(pack).toContain('caller');         // symbol name (literal in symbols)
    expect(pack).toContain('a.ts#helper@11'); // symbol id (symbols PK + calls S/T dict)
    expect(pack.slice(pack.indexOf('& calls'))).toContain('call'); // edge kind literal
  });

  it('F1: imports table carries a conf column; edges default to extracted (agent-v2)', () => {
    const pack = encodeAgentPack(makeAgent());
    const afterImports = pack.slice(pack.indexOf('& imports'));
    const importsTable = afterImports.slice(0, afterImports.indexOf('& routes'));
    expect(importsTable).toContain('conf');       // the new agent-v2 column header
    expect(importsTable).toContain('extracted');  // edges without explicit confidence
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
    expect(risks[0]![6]).toContain('Rotate');           // CXO message
    expect(risks[0]![7]).toContain('AKIA');             // technical
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

describe('encodeAgentPack — byte cost', () => {
  it('produces measurably less than the equivalent JSON for tabular content', () => {
    const agent = makeAgent();
    const pack = encodeAgentPack(agent);
    const json = JSON.stringify(agent);
    /* On this 2-file fixture the win is small (intern density is low),
       but even here PACK should beat JSON by a noticeable margin. The
       50%-on-real-data measurement happens in the workspace-level
       integration test against .facts/agent.json. */
    expect(pack.length).toBeLessThan(json.length);
  });
});
