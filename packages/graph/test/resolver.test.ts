import { describe, expect, it } from 'vitest';
import {
  resolveSpecifier,
  resolveAlias,
  buildAliasIndex,
  isRelative,
  isNodeBuiltin,
  type AliasRule,
} from '../src/resolver.js';

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
    // Newly-allowlisted common modules that the old set was missing.
    expect(resolveSpecifier('glob', 'app.py', ctx(['app.py']))).toBeNull();
    expect(resolveSpecifier('contextlib', 'app.py', ctx(['app.py']))).toBeNull();
    expect(resolveSpecifier('queue', 'app.py', ctx(['app.py']))).toBeNull();
  });

  it('treats a stdlib module as external even when a local file shadows it', () => {
    // A root `glob.py` must NOT capture `import glob` (the stdlib) — otherwise
    // the analyzer emits a false internal dependency edge that pollutes cycle
    // detection + health metrics.
    expect(resolveSpecifier('glob', 'app.py', ctx(['app.py', 'glob.py']))).toBeNull();
    expect(resolveSpecifier('queue', 'app.py', ctx(['app.py', 'queue.py']))).toBeNull();
    // Dotted stdlib import is matched on its head segment.
    expect(resolveSpecifier('concurrent.futures', 'app.py', ctx(['app.py', 'concurrent/futures.py']))).toBeNull();
  });

  it('still resolves a genuinely-local (non-stdlib) module a file provides', () => {
    expect(resolveSpecifier('myutils', 'app.py', ctx(['app.py', 'myutils.py']))).toBe('myutils.py');
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

// ── tsconfig `paths` alias resolution ──────────────────────────────────────

/** Resolver context carrying alias rules (no workspaces). */
const ctxA = (paths: string[], aliases: AliasRule[]) => ({
  files: new Set(paths),
  workspaces: new Map(),
  aliases,
});

const libRule: AliasRule = {
  prefix: '@lib/',
  suffix: '',
  wildcard: true,
  targets: ['src/lib/*'],
};

describe('resolveSpecifier — tsconfig path aliases', () => {
  it('resolves a wildcard alias to an internal file', () => {
    const c = ctxA(['src/a.ts', 'src/lib/foo.ts'], [libRule]);
    expect(resolveSpecifier('@lib/foo', 'src/a.ts', c)).toBe('src/lib/foo.ts');
  });

  it('probes index files through an alias', () => {
    const c = ctxA(['src/lib/widget/index.ts'], [libRule]);
    expect(resolveSpecifier('@lib/widget', 'src/a.ts', c)).toBe('src/lib/widget/index.ts');
  });

  it('returns null (external) when the alias target does not exist', () => {
    const c = ctxA(['src/a.ts'], [libRule]);
    expect(resolveSpecifier('@lib/ghost', 'src/a.ts', c)).toBeNull();
  });

  it('resolves a non-wildcard (exact) alias', () => {
    const rule: AliasRule = { prefix: '@config', suffix: '', wildcard: false, targets: ['src/config/index.ts'] };
    const c = ctxA(['src/config/index.ts'], [rule]);
    expect(resolveSpecifier('@config', 'src/a.ts', c)).toBe('src/config/index.ts');
  });

  it('tries multiple targets in order, taking the first that exists', () => {
    const rule: AliasRule = { prefix: '~/', suffix: '', wildcard: true, targets: ['src/*', 'generated/*'] };
    const c = ctxA(['generated/types.ts'], [rule]);
    expect(resolveSpecifier('~/types', 'src/a.ts', c)).toBe('generated/types.ts');
  });

  it('still resolves relative imports when aliases are present', () => {
    const c = ctxA(['src/a.ts', 'src/b.ts'], [libRule]);
    expect(resolveSpecifier('./b', 'src/a.ts', c)).toBe('src/b.ts');
  });

  it('leaves bare specifiers external when no alias matches', () => {
    const c = ctxA(['src/a.ts'], [libRule]);
    expect(resolveSpecifier('react', 'src/a.ts', c)).toBeNull();
  });
});

describe('resolveAlias — scoping (monorepo)', () => {
  const webRule: AliasRule = { prefix: '@lib/', suffix: '', wildcard: true, targets: ['apps/web/src/lib/*'], scope: 'apps/web' };
  const apiRule: AliasRule = { prefix: '@lib/', suffix: '', wildcard: true, targets: ['apps/api/src/lib/*'], scope: 'apps/api' };
  const files = new Set(['apps/web/src/lib/x.ts', 'apps/api/src/lib/x.ts']);
  const c = { files, workspaces: new Map(), aliases: [webRule, apiRule] };

  it('applies a scoped rule only within its subtree', () => {
    expect(resolveAlias('@lib/x', 'apps/web/main.ts', c)).toBe('apps/web/src/lib/x.ts');
    expect(resolveAlias('@lib/x', 'apps/api/main.ts', c)).toBe('apps/api/src/lib/x.ts');
  });

  it('does not let an out-of-scope file resolve a package alias', () => {
    expect(resolveAlias('@lib/x', 'apps/cli/main.ts', c)).toBeNull();
  });

  it('prefers the nearest (longest-scope) tsconfig', () => {
    const rootRule: AliasRule = { prefix: '@lib/', suffix: '', wildcard: true, targets: ['shared/lib/*'], scope: '' };
    const cc = { files: new Set(['shared/lib/x.ts', 'apps/web/src/lib/x.ts']), workspaces: new Map(), aliases: [rootRule, webRule] };
    expect(resolveAlias('@lib/x', 'apps/web/main.ts', cc)).toBe('apps/web/src/lib/x.ts');
  });

  it('honors a non-empty suffix in the pattern', () => {
    const rule: AliasRule = { prefix: '#styles/', suffix: '.css', wildcard: true, targets: ['src/styles/*.css'] };
    const cc = { files: new Set(['src/styles/app.css']), workspaces: new Map(), aliases: [rule] };
    expect(resolveAlias('#styles/app.css', 'src/a.ts', cc)).toBe('src/styles/app.css');
  });

  it('returns null when no rules are present', () => {
    expect(resolveAlias('@x/y', 'a.ts', { files: new Set(), workspaces: new Map() })).toBeNull();
  });
});

describe('resolveSpecifier — relative-path escape containment (AE-2)', () => {
  it('returns null for a relative import that climbs above the project root', () => {
    // From a root-level file, `..` must not fabricate a path outside the repo
    // (previously over-escaping produced a corrupt root-relative join).
    const c = ctxA(['a.ts', 'b.ts'], []);
    expect(resolveSpecifier('../../etc/passwd', 'a.ts', c)).toBeNull();
  });

  it('still resolves a legitimate parent-relative import within the tree', () => {
    const c = ctxA(['src/app.ts', 'shared/util.ts'], []);
    expect(resolveSpecifier('../shared/util', 'src/app.ts', c)).toBe('shared/util.ts');
  });
});

describe('buildAliasIndex', () => {
  it('resolves wildcard paths against baseUrl + tsconfig dir', () => {
    const rules = buildAliasIndex([
      { path: 'apps/web/tsconfig.json', text: JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['src/lib/*'] } } }) },
    ]);
    expect(rules).toEqual([
      { prefix: '@lib/', suffix: '', wildcard: true, targets: ['apps/web/src/lib/*'], scope: 'apps/web' },
    ]);
  });

  it('defaults baseUrl to the tsconfig directory when absent', () => {
    const rules = buildAliasIndex([
      { path: 'packages/x/tsconfig.json', text: JSON.stringify({ compilerOptions: { paths: { '@lib/*': ['./lib/*'] } } }) },
    ]);
    expect(rules).toEqual([
      { prefix: '@lib/', suffix: '', wildcard: true, targets: ['packages/x/lib/*'], scope: 'packages/x' },
    ]);
  });

  it('folds baseUrl into the target; root tsconfig has empty scope', () => {
    const rules = buildAliasIndex([
      { path: 'tsconfig.json', text: JSON.stringify({ compilerOptions: { baseUrl: './src', paths: { '@/*': ['*'] } } }) },
    ]);
    expect(rules).toEqual([
      { prefix: '@/', suffix: '', wildcard: true, targets: ['src/*'], scope: '' },
    ]);
  });

  it('handles non-wildcard (exact) patterns', () => {
    const rules = buildAliasIndex([
      { path: 'tsconfig.json', text: JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@config': ['src/config/index.ts'] } } }) },
    ]);
    expect(rules).toEqual([
      { prefix: '@config', suffix: '', wildcard: false, targets: ['src/config/index.ts'], scope: '' },
    ]);
  });

  it('tolerates JSONC comments and trailing commas', () => {
    const text = `{
      // project config
      "compilerOptions": {
        /* alias map */
        "baseUrl": ".",
        "paths": { "@lib/*": ["src/lib/*"], },
      },
    }`;
    const rules = buildAliasIndex([{ path: 'tsconfig.json', text }]);
    expect(rules).toEqual([
      { prefix: '@lib/', suffix: '', wildcard: true, targets: ['src/lib/*'], scope: '' },
    ]);
  });

  it('returns no rules when paths is absent or unparseable', () => {
    expect(buildAliasIndex([{ path: 'tsconfig.json', text: '{ "compilerOptions": { "baseUrl": "." } }' }])).toEqual([]);
    expect(buildAliasIndex([{ path: 'tsconfig.json', text: '{ not json' }])).toEqual([]);
  });

  it('skips patterns with more than one wildcard', () => {
    const rules = buildAliasIndex([
      { path: 'tsconfig.json', text: JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@x/*/*': ['src/*/*'] } } }) },
    ]);
    expect(rules).toEqual([]);
  });
});
