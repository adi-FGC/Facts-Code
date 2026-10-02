import { describe, expect, it } from 'vitest';
import {
  resolveSpecifier,
  resolveImportTargets,
  resolveAlias,
  buildAliasIndex,
  isRelative,
  isNodeBuiltin,
  stripSpecifierQuery,
  type AliasRule,
} from '../src/resolver.js';

const ctx = (
  paths: string[],
  workspaces: Array<{ name: string; dir: string; entry?: string | null }> = [],
) => ({
  files: new Set(paths),
  workspaces: new Map(
    workspaces.map((w) => [w.name, { name: w.name, dir: w.dir, entry: w.entry ?? null }]),
  ),
});

describe('resolveSpecifier — relative imports', () => {
  it('resolves ./b from a.ts when b.ts exists', () => {
    expect(resolveSpecifier('./b', 'a.ts', ctx(['a.ts', 'b.ts']))).toBe('b.ts');
  });

  it('resolves ./b.tsx with explicit extension', () => {
    expect(resolveSpecifier('./b.tsx', 'a.tsx', ctx(['a.tsx', 'b.tsx']))).toBe('b.tsx');
  });

  it('resolves ../sibling from nested dir', () => {
    expect(
      resolveSpecifier(
        '../sibling',
        'src/auth/login.ts',
        ctx(['src/sibling.ts', 'src/auth/login.ts']),
      ),
    ).toBe('src/sibling.ts');
  });

  it('resolves ./folder/index.ts via index probe', () => {
    expect(resolveSpecifier('./util', 'a.ts', ctx(['a.ts', 'util/index.ts']))).toBe(
      'util/index.ts',
    );
  });

  it('returns null when target file does not exist', () => {
    expect(resolveSpecifier('./missing', 'a.ts', ctx(['a.ts']))).toBeNull();
  });

  it('handles ./ exactly (current dir index)', () => {
    expect(resolveSpecifier('.', 'src/sub/x.ts', ctx(['src/sub/x.ts', 'src/sub/index.ts']))).toBe(
      'src/sub/index.ts',
    );
  });
});

describe('resolveSpecifier — bundler query/hash suffixes', () => {
  it('resolves ../../x.yaml?raw to the real file', () => {
    const c = ctx(['pnpm-lock.yaml', 'pkg/test/a.test.ts']);
    expect(resolveSpecifier('../../pnpm-lock.yaml?raw', 'pkg/test/a.test.ts', c)).toBe(
      'pnpm-lock.yaml',
    );
  });

  it('resolves ./w.ts?worker and ./w?worker&url', () => {
    const c = ctx(['src/a.ts', 'src/w.ts']);
    expect(resolveSpecifier('./w.ts?worker', 'src/a.ts', c)).toBe('src/w.ts');
    expect(resolveSpecifier('./w?worker&url', 'src/a.ts', c)).toBe('src/w.ts');
  });

  it('resolves ./a.svg?url and ./a.svg#frag', () => {
    const c = ctx(['src/a.ts', 'src/a.svg']);
    expect(resolveSpecifier('./a.svg?url', 'src/a.ts', c)).toBe('src/a.svg');
    expect(resolveSpecifier('./a.svg#frag', 'src/a.ts', c)).toBe('src/a.svg');
  });

  it('strips the suffix for workspace and alias specifiers too', () => {
    const w = ctx(['packages/spec/src/schema.json'], [{ name: '@x/spec', dir: 'packages/spec' }]);
    expect(resolveSpecifier('@x/spec/schema.json?raw', 'a.ts', w)).toBe(
      'packages/spec/src/schema.json',
    );
    const a = ctxA(['src/lib/foo.ts'], [libRule]);
    expect(resolveSpecifier('@lib/foo?inline', 'src/a.ts', a)).toBe('src/lib/foo.ts');
  });

  it('still reports a missing file as unresolved', () => {
    expect(resolveSpecifier('./missing.md?raw', 'a.ts', ctx(['a.ts']))).toBeNull();
  });

  it('stripSpecifierQuery keeps a leading # (Node subpath import)', () => {
    expect(stripSpecifierQuery('#internal/x')).toBe('#internal/x');
    expect(stripSpecifierQuery('#internal/x?raw')).toBe('#internal/x');
    expect(stripSpecifierQuery('./plain')).toBe('./plain');
  });
});

describe('resolveSpecifier — bare specifiers (workspaces vs externals)', () => {
  it('resolves a workspace package by name to its entry', () => {
    const c = ctx(
      ['packages/util/src/index.ts'],
      [{ name: '@org/util', dir: 'packages/util', entry: 'packages/util/src/index.ts' }],
    );
    expect(resolveSpecifier('@org/util', 'apps/web/src/main.ts', c)).toBe(
      'packages/util/src/index.ts',
    );
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
    const c = ctx(
      ['packages/util/src/sub.ts'],
      [{ name: '@org/util', dir: 'packages/util', entry: 'packages/util/src/index.ts' }],
    );
    expect(resolveSpecifier('@org/util/src/sub', 'apps/web/main.ts', c)).toBe(
      'packages/util/src/sub.ts',
    );
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
    expect(
      resolveSpecifier('concurrent.futures', 'app.py', ctx(['app.py', 'concurrent/futures.py'])),
    ).toBeNull();
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
    const rule: AliasRule = {
      prefix: '@config',
      suffix: '',
      wildcard: false,
      targets: ['src/config/index.ts'],
    };
    const c = ctxA(['src/config/index.ts'], [rule]);
    expect(resolveSpecifier('@config', 'src/a.ts', c)).toBe('src/config/index.ts');
  });

  it('tries multiple targets in order, taking the first that exists', () => {
    const rule: AliasRule = {
      prefix: '~/',
      suffix: '',
      wildcard: true,
      targets: ['src/*', 'generated/*'],
    };
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
  const webRule: AliasRule = {
    prefix: '@lib/',
    suffix: '',
    wildcard: true,
    targets: ['apps/web/src/lib/*'],
    scope: 'apps/web',
  };
  const apiRule: AliasRule = {
    prefix: '@lib/',
    suffix: '',
    wildcard: true,
    targets: ['apps/api/src/lib/*'],
    scope: 'apps/api',
  };
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
    const rootRule: AliasRule = {
      prefix: '@lib/',
      suffix: '',
      wildcard: true,
      targets: ['shared/lib/*'],
      scope: '',
    };
    const cc = {
      files: new Set(['shared/lib/x.ts', 'apps/web/src/lib/x.ts']),
      workspaces: new Map(),
      aliases: [rootRule, webRule],
    };
    expect(resolveAlias('@lib/x', 'apps/web/main.ts', cc)).toBe('apps/web/src/lib/x.ts');
  });

  it('honors a non-empty suffix in the pattern', () => {
    const rule: AliasRule = {
      prefix: '#styles/',
      suffix: '.css',
      wildcard: true,
      targets: ['src/styles/*.css'],
    };
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
      {
        path: 'apps/web/tsconfig.json',
        text: JSON.stringify({
          compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['src/lib/*'] } },
        }),
      },
    ]);
    expect(rules).toEqual([
      {
        prefix: '@lib/',
        suffix: '',
        wildcard: true,
        targets: ['apps/web/src/lib/*'],
        scope: 'apps/web',
      },
    ]);
  });

  it('defaults baseUrl to the tsconfig directory when absent', () => {
    const rules = buildAliasIndex([
      {
        path: 'packages/x/tsconfig.json',
        text: JSON.stringify({ compilerOptions: { paths: { '@lib/*': ['./lib/*'] } } }),
      },
    ]);
    expect(rules).toEqual([
      {
        prefix: '@lib/',
        suffix: '',
        wildcard: true,
        targets: ['packages/x/lib/*'],
        scope: 'packages/x',
      },
    ]);
  });

  it('folds baseUrl into the target; root tsconfig has empty scope', () => {
    const rules = buildAliasIndex([
      {
        path: 'tsconfig.json',
        text: JSON.stringify({ compilerOptions: { baseUrl: './src', paths: { '@/*': ['*'] } } }),
      },
    ]);
    expect(rules).toEqual([
      { prefix: '@/', suffix: '', wildcard: true, targets: ['src/*'], scope: '' },
    ]);
  });

  it('handles non-wildcard (exact) patterns', () => {
    const rules = buildAliasIndex([
      {
        path: 'tsconfig.json',
        text: JSON.stringify({
          compilerOptions: { baseUrl: '.', paths: { '@config': ['src/config/index.ts'] } },
        }),
      },
    ]);
    expect(rules).toEqual([
      {
        prefix: '@config',
        suffix: '',
        wildcard: false,
        targets: ['src/config/index.ts'],
        scope: '',
      },
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
    expect(
      buildAliasIndex([
        { path: 'tsconfig.json', text: '{ "compilerOptions": { "baseUrl": "." } }' },
      ]),
    ).toEqual([]);
    expect(buildAliasIndex([{ path: 'tsconfig.json', text: '{ not json' }])).toEqual([]);
  });

  it('skips patterns with more than one wildcard', () => {
    const rules = buildAliasIndex([
      {
        path: 'tsconfig.json',
        text: JSON.stringify({
          compilerOptions: { baseUrl: '.', paths: { '@x/*/*': ['src/*/*'] } },
        }),
      },
    ]);
    expect(rules).toEqual([]);
  });
});

describe('resolveSpecifier — root package self-import (HUNT-CORE-06)', () => {
  // The root package.json has dir '' — probes must not gain a leading '/'.
  const root = { name: 'my-lib', dir: '', entry: 'dist/index.js' };
  const files = ['src/index.ts', 'src/utils.ts', 'test/index.test.ts', 'examples/basic.ts'];

  it('resolves the bare package name to src/index when main points at dist/', () => {
    expect(resolveSpecifier('my-lib', 'test/index.test.ts', ctx(files, [root]))).toBe(
      'src/index.ts',
    );
  });

  it('resolves a sub-path of the root package', () => {
    expect(resolveSpecifier('my-lib/utils', 'examples/basic.ts', ctx(files, [root]))).toBe(
      'src/utils.ts',
    );
  });

  it('maps a nested package dist/ entry back to its source file', () => {
    const c = ctx(
      ['packages/cli/src/cli.ts'],
      [{ name: '@org/cli', dir: 'packages/cli', entry: 'packages/cli/dist/cli.js' }],
    );
    expect(resolveSpecifier('@org/cli', 'apps/x.ts', c)).toBe('packages/cli/src/cli.ts');
  });
});

describe('resolveImportTargets — Python submodules and siblings (HUNT-CORE-05)', () => {
  it('`from . import utils` targets the submodule, not the package __init__', () => {
    const c = ctx(['pkg/__init__.py', 'pkg/core.py', 'pkg/utils.py']);
    expect(resolveImportTargets({ specifier: '.', members: ['utils'] }, 'pkg/core.py', c)).toEqual([
      'pkg/utils.py',
    ]);
  });

  it('`from .core import run` falls back to the module when the member is not a submodule', () => {
    const c = ctx(['pkg/__init__.py', 'pkg/core.py', 'pkg/utils.py']);
    expect(
      resolveImportTargets({ specifier: '.core', members: ['run'] }, 'pkg/__init__.py', c),
    ).toEqual(['pkg/core.py']);
  });

  it('never lands a namespace-package import on an unrelated sibling', () => {
    const c = ctx(['nsp/a.py', 'nsp/b.py', 'nsp/c.py']);
    expect(resolveImportTargets({ specifier: '.', members: ['c'] }, 'nsp/b.py', c)).toEqual([
      'nsp/c.py',
    ]);
    // The package form alone must not pick the first .py in walk order.
    expect(resolveSpecifier('.', 'nsp/b.py', c)).toBeNull();
  });

  it('keeps the package edge for a merged `import pkg` + `from pkg import sub` row', () => {
    const c = ctx(['pkg/__init__.py', 'pkg/sub.py', 'app.py']);
    expect(resolveImportTargets({ specifier: 'pkg', members: ['*', 'sub'] }, 'app.py', c)).toEqual([
      'pkg/__init__.py',
      'pkg/sub.py',
    ]);
  });

  it('resolves an absolute import to the sibling before a same-named file elsewhere', () => {
    const c = ctx(['apps/other/helpers.py', 'services/api/helpers.py', 'services/api/main.py']);
    expect(resolveSpecifier('helpers', 'services/api/main.py', c)).toBe('services/api/helpers.py');
  });

  it('falls back to the shortest matching path anywhere, independent of walk order', () => {
    const c = ctx(['z/deep/src/mypkg/__init__.py', 'src/mypkg/__init__.py', 'tools/run.py']);
    expect(resolveSpecifier('mypkg', 'tools/run.py', c)).toBe('src/mypkg/__init__.py');
  });

  // CORE-R1 — a member is a submodule only INSIDE the resolved package; a
  // same-named path elsewhere in the repo must not steal the edge.
  it('keeps the module edge when the member is a name, not a submodule found elsewhere', () => {
    const c = ctx(['utils.py', 'main.py', 'scripts/legacy/utils/helpers.py']);
    expect(
      resolveImportTargets({ specifier: 'utils', members: ['helpers'] }, 'main.py', c),
    ).toEqual(['utils.py']);
  });

  it('never draws a cross-service edge for a member of a nearer module', () => {
    const c = ctx([
      'services/a/app/main.py',
      'services/a/app/config.py',
      'services/b/app/config/__init__.py',
      'services/b/app/config/settings.py',
    ]);
    expect(
      resolveImportTargets(
        { specifier: 'app.config', members: ['settings'] },
        'services/a/app/main.py',
        c,
      ),
    ).toEqual(['services/a/app/config.py']);
  });

  it('resolves `from pkg.core import run` to pkg/core.py, not other/pkg/core/run.py', () => {
    const c = ctx(['app.py', 'pkg/__init__.py', 'pkg/core.py', 'other/pkg/core/run.py']);
    expect(resolveImportTargets({ specifier: 'pkg.core', members: ['run'] }, 'app.py', c)).toEqual([
      'pkg/core.py',
    ]);
  });

  it('still finds a submodule inside the resolved package, nearest-first', () => {
    const c = ctx([
      'services/a/app/__init__.py',
      'services/a/app/main.py',
      'services/a/app/config.py',
      'services/b/app/__init__.py',
      'services/b/app/db.py',
    ]);
    // `db` is not in services/a/app — the package keeps the edge.
    expect(
      resolveImportTargets(
        { specifier: 'app', members: ['config', 'db'] },
        'services/a/app/main.py',
        c,
      ),
    ).toEqual(['services/a/app/config.py', 'services/a/app/__init__.py']);
  });

  it("prefers the importer's own namespace package over another service's package", () => {
    const c = ctx([
      'services/a/app/main.py', // namespace package: no __init__.py
      'services/a/app/config.py',
      'services/b/app/__init__.py',
      'services/b/app/db.py',
    ]);
    const from = 'services/a/app/main.py';
    expect(resolveSpecifier('app', from, c)).toBeNull();
    expect(resolveImportTargets({ specifier: 'app', members: ['config'] }, from, c)).toEqual([
      'services/a/app/config.py',
    ]);
    expect(resolveImportTargets({ specifier: 'app', members: ['db'] }, from, c)).toEqual([]);
  });
});

/* correctness#4 / #48 — inside a REGULAR package (the importer's dir has
   __init__.py) Python 3 has no implicit relative import: `import utils` is
   looked up on sys.path, which holds the package's parent, never the
   package's own dir. So the package's parent, then the root, win over a
   same-named sibling there; nearest-first stays for script / namespace dirs
   that sit outside every regular package. */
describe('resolveSpecifier — absolute Python imports inside a regular package', () => {
  it('`import utils` in pkg/mod.py lands on the root utils.py, not pkg/utils.py', () => {
    const c = ctx(['utils.py', 'pkg/__init__.py', 'pkg/utils.py', 'pkg/mod.py']);
    expect(resolveSpecifier('utils', 'pkg/mod.py', c)).toBe('utils.py');
    expect(resolveImportTargets({ specifier: 'utils', members: ['x'] }, 'pkg/mod.py', c)).toEqual([
      'utils.py',
    ]);
  });

  it('a nested regular sub-package also skips its own dirs for the root', () => {
    const c = ctx([
      'utils.py',
      'pkg/__init__.py',
      'pkg/utils.py',
      'pkg/sub/__init__.py',
      'pkg/sub/utils.py',
      'pkg/sub/mod.py',
    ]);
    expect(resolveSpecifier('utils', 'pkg/sub/mod.py', c)).toBe('utils.py');
  });

  it("uses the top package's parent (the sys.path entry that holds it)", () => {
    // services/a is the sys.path entry that holds the `app` package.
    const c = ctx([
      'services/a/app/__init__.py',
      'services/a/app/main.py',
      'services/a/app/utils.py',
      'services/a/utils.py',
    ]);
    expect(resolveSpecifier('utils', 'services/a/app/main.py', c)).toBe('services/a/utils.py');
  });

  /* Review CG-R1: the package's parent is searched BEFORE the project root,
     so a package importing itself by name stays inside its own service. */
  it('a package importing itself by name stays in its service, not the root package', () => {
    const c = ctx([
      'tests/__init__.py',
      'tests/helpers.py',
      'services/a/tests/__init__.py',
      'services/a/tests/helpers.py',
      'services/a/tests/test_x.py',
    ]);
    const from = 'services/a/tests/test_x.py';
    expect(resolveSpecifier('tests.helpers', from, c)).toBe('services/a/tests/helpers.py');
    expect(resolveImportTargets({ specifier: 'tests', members: ['helpers'] }, from, c)).toEqual([
      'services/a/tests/helpers.py',
    ]);
  });

  it("a regular package and a script dir in one service agree on the service's utils.py", () => {
    const c = ctx([
      'utils.py',
      'services/a/utils.py',
      'services/a/app/__init__.py',
      'services/a/app/main.py',
      'services/a/scripts/run.py',
    ]);
    expect(resolveSpecifier('utils', 'services/a/app/main.py', c)).toBe('services/a/utils.py');
    expect(resolveSpecifier('utils', 'services/a/scripts/run.py', c)).toBe('services/a/utils.py');
  });

  /* Review CG-R3: a namespace dir (no __init__.py) nested in a regular
     package is still package context — the enclosing package's dir is not
     on sys.path, so its same-named file never wins over the root. */
  it('a namespace subdir inside a regular package skips the enclosing package for the root', () => {
    const c = ctx(['utils.py', 'pkg/__init__.py', 'pkg/utils.py', 'pkg/sub/mod.py']);
    expect(resolveSpecifier('utils', 'pkg/sub/mod.py', c)).toBe('utils.py');
    expect(
      resolveImportTargets({ specifier: 'utils', members: ['x'] }, 'pkg/sub/mod.py', c),
    ).toEqual(['utils.py']);
  });

  it("a namespace subdir inside a regular package uses the package's parent before the package", () => {
    const c = ctx([
      'services/a/utils.py',
      'services/a/pkg/__init__.py',
      'services/a/pkg/utils.py',
      'services/a/pkg/sub/mod.py',
    ]);
    expect(resolveSpecifier('utils', 'services/a/pkg/sub/mod.py', c)).toBe('services/a/utils.py');
  });

  it('a namespace subdir inside a regular package still finds its own sibling first', () => {
    // Run as a script or collected by pytest, pkg/tests is sys.path[0].
    const c = ctx(['helpers.py', 'pkg/__init__.py', 'pkg/tests/helpers.py', 'pkg/tests/test_x.py']);
    expect(resolveSpecifier('helpers', 'pkg/tests/test_x.py', c)).toBe('pkg/tests/helpers.py');
  });

  it('still falls back to an in-package sibling before a far same-named file', () => {
    const c = ctx(['pkg/__init__.py', 'pkg/mod.py', 'pkg/helpers.py', 'other/deep/helpers.py']);
    expect(resolveSpecifier('helpers', 'pkg/mod.py', c)).toBe('pkg/helpers.py');
  });

  it('keeps nearest-first for a script dir (no __init__.py)', () => {
    const c = ctx(['utils.py', 'scripts/utils.py', 'scripts/run.py']);
    expect(resolveSpecifier('utils', 'scripts/run.py', c)).toBe('scripts/utils.py');
  });

  it('keeps nearest-first for a namespace dir (no __init__.py)', () => {
    const c = ctx(['utils.py', 'nsp/utils.py', 'nsp/mod.py']);
    expect(resolveSpecifier('utils', 'nsp/mod.py', c)).toBe('nsp/utils.py');
  });
});

describe('resolver — indexed Python/Go lookups (performance#1)', () => {
  it('resolves 5k third-party Python imports over 20k files in well under a second', () => {
    const paths: string[] = [];
    for (let i = 0; i < 20_000; i++) paths.push(`svc${i % 50}/pkg${i % 400}/mod${i}.py`);
    const c = ctx(paths);
    const t0 = Date.now();
    for (let i = 0; i < 5_000; i++) {
      expect(
        resolveSpecifier(`thirdparty${i}.sub`, `svc${i % 50}/pkg${i % 400}/mod${i}.py`, c),
      ).toBeNull();
    }
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('matches the previous full-scan Go resolution exactly', () => {
    const files = [
      'go/cmd/api/main.go',
      'go/internal/auth/token.go',
      'go/internal/auth/a_test.go',
      'go/internal/auth/claims.go',
      'go/internal/auth/sub/deep.go',
      'go/internal/db/db.go',
      'go/root.go',
    ];
    const goModules = [{ module: 'example.com/shop', dir: 'go' }];
    const c = { ...ctx(files), goModules };
    // The pre-index algorithm, kept here as the oracle.
    const oracle = (spec: string): string | null => {
      for (const m of goModules) {
        let rel: string | null = null;
        if (spec === m.module) rel = '';
        else if (spec.startsWith(m.module + '/')) rel = spec.slice(m.module.length + 1);
        if (rel === null) continue;
        const dir = m.dir ? (rel ? `${m.dir}/${rel}` : m.dir) : rel;
        const prefix = dir ? dir + '/' : '';
        let best: string | null = null;
        for (const f of files) {
          if (!f.endsWith('.go') || f.endsWith('_test.go') || !f.startsWith(prefix)) continue;
          if (f.slice(prefix.length).includes('/')) continue;
          if (best === null || f < best) best = f;
        }
        if (best) return best;
      }
      return null;
    };
    for (const spec of [
      'example.com/shop',
      'example.com/shop/internal/auth',
      'example.com/shop/internal/auth/sub',
      'example.com/shop/internal/db',
      'example.com/shop/internal/none',
      'example.com/shopping',
      'fmt',
    ]) {
      expect(resolveSpecifier(spec, 'go/cmd/api/main.go', c), spec).toBe(oracle(spec));
    }
  });
});
