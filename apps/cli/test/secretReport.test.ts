import { describe, expect, it } from 'vitest';
import type { AgentArtifact } from '@factstack/spec';
import { MAX_SECRET_ROWS, secretFindings, secretSummaryLines } from '../src/secretReport.js';

type Risk = AgentArtifact['risks'][number];
const secret = (file: string, line: number, severity: 'high' | 'low'): Risk =>
  ({
    category: 'secret',
    rule: 'github-token',
    severity,
    file,
    line,
    message: 'm',
    preview: 'ghp_***t0',
  }) as Risk;
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('secretFindings', () => {
  it('lists every secret with its exact path + line, exposed first, then fixtures', () => {
    const found = secretFindings([
      secret('test/b.ts', 9, 'low'),
      { category: 'todo', rule: 'todo', severity: 'low', message: 'x' } as Risk,
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
    expect(secretSummaryLines([])).toEqual([]);
  });

  it('counts both groups and prints each path:line with only the redacted preview', () => {
    const out = secretSummaryLines(
      secretFindings([secret('src/a.ts', 2, 'high'), secret('test/b.ts', 9, 'low')]),
    ).map(plain);
    expect(out.join('\n')).toContain('1 exposed · 1 in test/fixture files (not graded)');
    expect(out).toContain('  ✗ src/a.ts:2  github-token  ghp_***t0');
    expect(out).toContain('  · test/b.ts:9  github-token  ghp_***t0  (test/fixture)');
  });

  it('caps the terminal list and says where the rest is', () => {
    const many = Array.from({ length: MAX_SECRET_ROWS + 7 }, (_, i) =>
      secret(`src/f${String(i).padStart(3, '0')}.ts`, 1, 'high'),
    );
    const out = secretSummaryLines(secretFindings(many)).map(plain);
    expect(out.filter((l) => l.startsWith('  ✗ '))).toHaveLength(MAX_SECRET_ROWS);
    expect(out.at(-1)).toContain('7 more');
  });
});
