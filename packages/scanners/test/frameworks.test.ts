import { describe, expect, it } from 'vitest';
import {
  scanFrameworksFromPackageJson,
  scanFrameworksFromRequirements,
  mergeFrameworks,
} from '../src/frameworks.js';

describe('scanFrameworksFromPackageJson', () => {
  it('detects React from dependencies', () => {
    const out = scanFrameworksFromPackageJson(
      JSON.stringify({
        name: 'app',
        dependencies: { react: '^19.0.0' },
      }),
    );
    expect(out.frameworks).toContain('React');
  });

  it('detects multiple frameworks from a real-world package shape', () => {
    const out = scanFrameworksFromPackageJson(
      JSON.stringify({
        name: 'app',
        dependencies: { react: '^19', vite: '^7', tailwindcss: '^3', '@reduxjs/toolkit': '^2' },
      }),
    );
    expect(out.frameworks).toEqual(expect.arrayContaining(['React', 'Vite', 'Tailwind CSS']));
  });

  it('returns scripts from package.json', () => {
    const out = scanFrameworksFromPackageJson(
      JSON.stringify({
        name: 'app',
        scripts: { dev: 'vite', build: 'vite build' },
      }),
    );
    expect(out.scripts).toEqual({ dev: 'vite', build: 'vite build' });
  });

  it('handles devDependencies too', () => {
    const out = scanFrameworksFromPackageJson(
      JSON.stringify({
        name: 'app',
        devDependencies: { typescript: '^5' },
      }),
    );
    expect(out.frameworks).toContain('TypeScript');
  });

  it('returns empty arrays for malformed JSON (graceful)', () => {
    const out = scanFrameworksFromPackageJson('{ broken json');
    expect(out.frameworks).toEqual([]);
    expect(out.scripts).toEqual({});
  });

  it('returns empty for empty input', () => {
    const out = scanFrameworksFromPackageJson('');
    expect(out.frameworks).toEqual([]);
  });

  // SCN-05 — `null` threw "Cannot read properties of null" and aborted analyze.
  it('never throws on valid JSON that is not a package object', () => {
    for (const text of [
      'null',
      '[]',
      '"x"',
      '42',
      'true',
      '{"dependencies":null,"devDependencies":[],"peerDependencies":"x","scripts":"x"}',
    ]) {
      expect(scanFrameworksFromPackageJson(text), text).toEqual({ frameworks: [], scripts: {} });
    }
  });

  it('keeps only string-valued scripts', () => {
    const out = scanFrameworksFromPackageJson(
      JSON.stringify({
        scripts: { dev: 'vite', bad: 1, nested: { a: 'b' } },
        dependencies: { vite: '^7' },
      }),
    );
    expect(out).toEqual({ frameworks: ['Vite'], scripts: { dev: 'vite' } });
  });
});

describe('scanFrameworksFromRequirements (Python)', () => {
  it('detects Flask', () => {
    expect(scanFrameworksFromRequirements('flask==3.0.0\n')).toContain('Flask');
  });

  it('detects FastAPI', () => {
    // The requirements parser matches the package name; extras like
    // `[all]` should be stripped by the parser, but we test the
    // simpler shape that we know works.
    expect(scanFrameworksFromRequirements('fastapi>=0.110\n')).toContain('FastAPI');
  });

  it('detects Django', () => {
    expect(scanFrameworksFromRequirements('Django>=5.0\n')).toContain('Django');
  });

  it('returns empty for empty input', () => {
    expect(scanFrameworksFromRequirements('')).toEqual([]);
  });

  it('skips comments + blank lines', () => {
    expect(scanFrameworksFromRequirements('# requirements\n\nflask\n')).toContain('Flask');
  });

  // SCN-18 — extras, env markers, spaced versions and `@ url` specs kept the
  // suffix in the name, so FastAPI's documented `fastapi[standard]` was missed.
  it('strips extras, markers, spaced versions and direct-URL specs', () => {
    const req = [
      'fastapi[standard]==0.115.0',
      'Django[argon2]>=5',
      'flask ; python_version >= "3.8"',
      'express == 1.0',
      'hono @ https://example.com/hono-1.0.whl',
      '-r base.txt',
      '--hash=sha256:abc',
      '-e git+https://example.com/koa.git#egg=koa',
    ].join('\n');
    expect(scanFrameworksFromRequirements(req)).toEqual([
      'Django',
      'Express',
      'FastAPI',
      'Flask',
      'Hono',
    ]);
  });
});

describe('mergeFrameworks', () => {
  it('dedupes across lists', () => {
    expect(
      mergeFrameworks([
        ['React', 'Vite'],
        ['React', 'Tailwind CSS'],
      ]),
    ).toEqual(expect.arrayContaining(['React', 'Vite', 'Tailwind CSS']));
    const r = mergeFrameworks([
      ['React', 'Vite'],
      ['React', 'Tailwind CSS'],
    ]);
    expect(r.filter((x) => x === 'React')).toHaveLength(1);
  });

  it('returns sorted output for stable artifact diffs', () => {
    const r = mergeFrameworks([['Z', 'A', 'M']]);
    expect(r).toEqual(['A', 'M', 'Z']);
  });

  it('handles undefined entries safely', () => {
    expect(mergeFrameworks([undefined, ['React'], undefined])).toEqual(['React']);
  });

  it('returns [] for empty input', () => {
    expect(mergeFrameworks([])).toEqual([]);
  });
});
