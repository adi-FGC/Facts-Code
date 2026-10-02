import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentArtifact } from '@factstack/spec';
import { analyzeProject } from '../src/pipeline.js';
import {
  fullSecretListHint,
  MAX_SECRET_ROWS,
  secretFindings,
  secretSummaryLines,
} from '../src/secretReport.js';
import { fixtureProject, hermeticEnv } from './cli-io.js';

/** A full analyze: it wrote agent.json. */
const FULL = { agentJsonWritten: true };

type Risk = AgentArtifact['risks'][number];
const secret = (file: string, line: number, severity: 'high' | 'low' | 'info'): Risk => ({
  category: 'secret',
  rule: severity === 'info' ? 'generic-secret' : 'github-token',
  severity,
  file,
  line,
  message: 'm',
  preview: severity === 'info' ? '***' : 'ghp_***t0',
});
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('secretFindings', () => {
  it('lists every secret with its exact path + line, exposed first, then fixtures', () => {
    const found = secretFindings([
      secret('test/b.ts', 9, 'low'),
      { category: 'large-file', rule: 'large-file', severity: 'low', message: 'x' }, // not a secret
      secret('src/z.ts', 3, 'high'),
      secret('src/a.ts', 12, 'high'),
      secret('src/a.ts', 2, 'high'),
    ]);
    expect(found.map((f) => `${f.file}:${f.line}:${f.graded}`)).toEqual([
      'src/a.ts:2:true',
      'src/a.ts:12:true',
      'src/z.ts:3:true',
      'test/b.ts:9:false',
    ]);
  });
});

describe('secretSummaryLines', () => {
  it('prints nothing when nothing was found', () => {
    expect(secretSummaryLines([], FULL)).toEqual([]);
  });

  it('counts both groups and prints each path:line with only the redacted preview', () => {
    const out = secretSummaryLines(
      secretFindings([secret('src/a.ts', 2, 'high'), secret('test/b.ts', 9, 'low')]),
      FULL,
    ).map(plain);
    expect(out.join('\n')).toContain('1 exposed · 1 in test/fixture files (not graded)');
    expect(out).toContain('  ✗ src/a.ts:2  github-token  ghp_***t0');
    expect(out).toContain('  · test/b.ts:9  github-token  ghp_***t0  (test/fixture)');
  });

  it('lists generic (info) matches as possible secrets — never counted as exposed', () => {
    const found = secretFindings([
      secret('src/db.ts', 4, 'info'),
      secret('src/a.ts', 2, 'high'),
      secret('test/b.ts', 9, 'low'),
    ]);
    expect(found.map((f) => `${f.file}:${f.kind}:${f.graded}`)).toEqual([
      'src/a.ts:exposed:true',
      'src/db.ts:possible:false',
      'test/b.ts:fixture:false',
    ]);
    const out = secretSummaryLines(found, FULL).map(plain);
    expect(out.join('\n')).toContain(
      '1 exposed · 1 possible (not graded) · 1 in test/fixture files (not graded)',
    );
    expect(out).toContain('  · src/db.ts:4  generic-secret  ***  (possible secret, not graded)');
    const onlyPossible = secretSummaryLines(secretFindings([secret('src/db.ts', 4, 'info')]), FULL);
    expect(onlyPossible.map(plain).join('\n')).toContain('0 exposed · 1 possible (not graded)');
  });

  it('caps the terminal list and says where the rest is', () => {
    const many = Array.from({ length: MAX_SECRET_ROWS + 7 }, (_, i) =>
      secret(`src/f${String(i).padStart(3, '0')}.ts`, 1, 'high'),
    );
    const out = secretSummaryLines(secretFindings(many), FULL).map(plain);
    expect(out.filter((l) => l.startsWith('  ✗ '))).toHaveLength(MAX_SECRET_ROWS);
    expect(out.at(-1)).toContain('7 more');
  });

  /* ux#21: the pointer named "the dashboard's Security → Secrets tab", which
     only the hosted app has; `factstack ui` (the legacy dashboard this CLI
     serves) has a Risks tab. Pinned against the UI it actually serves. */
  it('names a tab that `factstack ui` really has', () => {
    const many = Array.from({ length: MAX_SECRET_ROWS + 1 }, (_, i) =>
      secret(`src/f${i}.ts`, 1, 'high'),
    );
    const tail = plain(secretSummaryLines(secretFindings(many), FULL).at(-1)!);
    expect(tail).toBe(`  … 1 more — ${fullSecretListHint(true)}`);
    expect(tail).not.toMatch(/Security|Secrets tab/);
    const ui = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'index.html'),
      'utf8',
    );
    for (const hint of [fullSecretListHint(true), fullSecretListHint(false)]) {
      const tab = /the (\w+) tab of `factstack ui`/.exec(hint)![1]!;
      expect(ui).toMatch(new RegExp(`data-tab="${tab.toLowerCase()}">${tab}\\b`));
    }
    expect(ui).not.toMatch(/data-tab="security"/);
  });
});

/* cli-rev-4 (ux#21 follow-up): `analyze --minimal` writes no agent.json and
   marks an existing one stale (emit, performance#1), yet the pointer still
   sent the reader to .facts/agent.json. It names a file the run wrote. */
describe('the full-list pointer names a file this run wrote, with every row', () => {
  const temps: string[] = [];
  const restoreEnv = hermeticEnv();
  afterAll(() => {
    restoreEnv();
    for (const d of temps) rmSync(d, { recursive: true, force: true });
  });

  it('under --minimal it names human.json, never agent.json', () => {
    const many = Array.from({ length: MAX_SECRET_ROWS + 1 }, (_, i) =>
      secret(`src/f${i}.ts`, 1, 'high'),
    );
    const tail = plain(
      secretSummaryLines(secretFindings(many), { agentJsonWritten: false }).at(-1)!,
    );
    expect(tail).toContain('.facts/human.json (risks, category "secret")');
    expect(tail).not.toContain('agent.json');
  });

  it.each([
    ['analyze', false],
    ['analyze --minimal', true],
  ])(
    '%s: the named .facts file exists and holds every risk',
    async (_label, minimal) => {
      const root = fixtureProject('facts-secret-hint-');
      temps.push(root);
      const r = await analyzeProject(root, { cache: false, minimal });
      const hint = fullSecretListHint(r.written.agentPath !== null);
      const named = /\.facts\/([\w.]+\.json)/.exec(hint)![1]!;
      const file = path.join(root, '.facts', named);
      expect(existsSync(file), named).toBe(true);
      expect(JSON.parse(readFileSync(file, 'utf8')).risks).toEqual(
        JSON.parse(JSON.stringify(r.agent.risks)),
      );
    },
    60_000,
  );
});
