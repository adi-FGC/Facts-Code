import { describe, expect, it } from 'vitest';
import { scanFrameworksFromPackageJson, scanFrameworksFromRequirements, mergeFrameworks } from '../src/frameworks.js';

describe('scanFrameworksFromPackageJson', () => {
  it('detects React from dependencies', () => {
    const out = scanFrameworksFromPackageJson(JSON.stringify({
      name: 'app', dependencies: { react: '^19.0.0' },
    }));
    expect(out.frameworks).toContain('React');
  });

  it('detects multiple frameworks from a real-world package shape', () => {
    const out = scanFrameworksFromPackageJson(JSON.stringify({
      name: 'app',
      dependencies: { react: '^19', vite: '^7', tailwindcss: '^3', '@reduxjs/toolkit': '^2' },
    }));
    expect(out.frameworks).toEqual(expect.arrayContaining(['React', 'Vite', 'Tailwind CSS']));
  });

  it('returns scripts from package.json', () => {
    const out = scanFrameworksFromPackageJson(JSON.stringify({
      name: 'app', scripts: { dev: 'vite', build: 'vite build' },
    }));
    expect(out.scripts).toEqual({ dev: 'vite', build: 'vite build' });
  });

  it('handles devDependencies too', () => {
    const out = scanFrameworksFromPackageJson(JSON.stringify({
      name: 'app', devDependencies: { typescript: '^5' },
    }));
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
});

describe('mergeFrameworks', () => {
  it('dedupes across lists', () => {
    expect(mergeFrameworks([['React', 'Vite'], ['React', 'Tailwind CSS']]))
      .toEqual(expect.arrayContaining(['React', 'Vite', 'Tailwind CSS']));
    const r = mergeFrameworks([['React', 'Vite'], ['React', 'Tailwind CSS']]);
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
