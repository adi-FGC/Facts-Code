import { describe, expect, it } from 'vitest';
import { resolveSpecifier, isRelative, isNodeBuiltin } from '../src/resolver.js';

const ctx = (paths: string[], workspaces: Array<{ name: string; dir: string; entry?: string | null }> = []) => ({
  files: new Set(paths),
  workspaces: new Map(workspaces.map((w) => [w.name, { name: w.name, dir: w.dir, entry: w.entry ?? null }])),
});

describe('resolveSpecifier — relative imports', () => {
  it('resolves ./b from a.ts when b.ts exists', () => {
    expect(resolveSpecifier('./b', 'a.ts', ctx(['a.ts', 'b.ts']))).toBe('b.ts');
  });

  it('resolves ./b.tsx with explicit extension', () => {
    expect(resolveSpecifier('./b.tsx', 'a.tsx', ctx(['a.tsx', 'b.tsx']))).toBe('b.tsx');
  });

  it('resolves ../sibling from nested dir', () => {
    expect(resolveSpecifier('../sibling', 'src/auth/login.ts', ctx(['src/sibling.ts', 'src/auth/login.ts']))).toBe('src/sibling.ts');
  });

  it('resolves ./folder/index.ts via index probe', () => {
    expect(resolveSpecifier('./util', 'a.ts', ctx(['a.ts', 'util/index.ts']))).toBe('util/index.ts');
  });

  it('returns null when target file does not exist', () => {
    expect(resolveSpecifier('./missing', 'a.ts', ctx(['a.ts']))).toBeNull();
  });

  it('handles ./ exactly (current dir index)', () => {
    expect(resolveSpecifier('.', 'src/sub/x.ts', ctx(['src/sub/x.ts', 'src/sub/index.ts']))).toBe('src/sub/index.ts');
  });
});

describe('resolveSpecifier — bare specifiers (workspaces vs externals)', () => {
  it('resolves a workspace package by name to its entry', () => {
    const c = ctx(['packages/util/src/index.ts'], [
      { name: '@org/util', dir: 'packages/util', entry: 'packages/util/src/index.ts' },
    ]);
    expect(resolveSpecifier('@org/util', 'apps/web/src/main.ts', c)).toBe('packages/util/src/index.ts');
  });

  it('returns null for unknown bare specifier (npm package)', () => {
    expect(resolveSpecifier('react', 'a.ts', ctx(['a.ts']))).toBeNull();
  });

  it('returns null for node:* builtins', () => {
    expect(resolveSpecifier('node:fs', 'a.ts', ctx(['a.ts']))).toBeNull();
    expect(resolveSpecifier('node:path', 'a.ts', ctx(['a.ts']))).toBeNull();
  });

  it('returns null for bare-name builtins', () => {
    expect(resolveSpecifier('fs', 'a.ts', ctx(['a.ts']))).toBeNull();
    expect(resolveSpecifier('path', 'a.ts', ctx(['a.ts']))).toBeNull();
  });

  it('resolves workspace subpath imports', () => {
    const c = ctx(['packages/util/src/sub.ts'], [
      { name: '@org/util', dir: 'packages/util', entry: 'packages/util/src/index.ts' },
    ]);
    expect(resolveSpecifier('@org/util/src/sub', 'apps/web/main.ts', c)).toBe('packages/util/src/sub.ts');
  });
});

describe('resolveSpecifier — Python', () => {
  it('returns null for Python stdlib modules', () => {
    expect(resolveSpecifier('os', 'app.py', ctx(['app.py']))).toBeNull();
    expect(resolveSpecifier('json', 'app.py', ctx(['app.py']))).toBeNull();
    expect(resolveSpecifier('asyncio', 'app.py', ctx(['app.py']))).toBeNull();
  });
});

describe('isRelative + isNodeBuiltin (additional edges)', () => {
  it('isRelative handles "./" "../" "." ".."', () => {
    expect(isRelative('.')).toBe(true);
    expect(isRelative('..')).toBe(true);
    expect(isRelative('./')).toBe(true);
    expect(isRelative('../')).toBe(true);
  });

  it('isNodeBuiltin handles fs/promises and timers/promises', () => {
    expect(isNodeBuiltin('fs/promises')).toBe(true);
    expect(isNodeBuiltin('node:fs/promises')).toBe(true);
  });
});
