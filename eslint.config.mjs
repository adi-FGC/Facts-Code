// @ts-check
/**
 * Root ESLint config. Enforces the package boundary rules from the plan
 * (constraints C1 and C2) via per-package no-restricted-imports rules: C1
 * bans Node built-ins from the isomorphic tier, C2 restricts each package to
 * the @factstack/* deps it actually declares.
 *
 * This is the insurance policy that prevents the Chrome extension (v0.4)
 * and the WASM analyzer from quietly breaking as core evolves.
 */

import { builtinModules } from 'node:module';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/* Every Node built-in, bare and `node:`-prefixed, straight from the running
   Node. A hand-written list covered only 13 modules and let node:zlib,
   node:stream, node:util, node:sqlite, node:buffer… through C1. Modules that
   exist only with the prefix (node:sqlite, node:test, node:sea) are listed
   prefixed by Node itself. */
const NODE_BUILTINS = [
  ...new Set(builtinModules.flatMap((m) => (m.startsWith('node:') ? [m] : [m, `node:${m}`]))),
];

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  /* ── Constraints C1 + C2, enforced together ─────────────────────────────
     One `no-restricted-imports` config per package, because ESLint allows only
     ONE active config per rule per file: a later block silently REPLACES an
     earlier one. C1 (node builtins) and C2 (the dependency DAG) were previously
     split across two blocks, so for the nine packages both matched, C1 won and
     C2 never ran — a guard that looked configured but could not fail. They are
     merged here so both fire.

     Not eslint-plugin-boundaries: re-verified 2026-09-24 against v7.2.0 with
     in-memory probes — `boundaries/element-types` (deprecated alias of
     `boundaries/dependencies`) reported NOTHING for spec→core, walker→core,
     core→emit, ui-remix→fs-node, cli→ui-theme or a relative
     `../../core/src/index.js` from packages/spec. Every one of those probes
     except the relative import fails under the blocks below.
     The plugin was removed from devDependencies and pnpm-lock.yaml on
     2026-09-24.

     C1 scope: the nine packages that were already C1-gated (spec, walker,
     parsers, extractors, graph, scanners, core, fs-memory, fs-browser) stay
     gated on the WHOLE package, tests included. factspack and intent are
     gated on src only: their tests run in Node and legitimately import node:*
     (e.g. factspack/test uses node:crypto). The browser-bound sources —
     emit-browser/src, skills/src and apps/ui-remix/src — are C1-gated on src
     only for the same reason.

     C2 allow-lists mirror each package.json's @factstack/* deps (dependencies
     + devDependencies), last synced 2026-09-24. They are static: importing a
     newly declared dep fails lint until it is added here, and a dropped dep
     stays allowed until removed here. A package may import exactly what it
     declares. Relative cross-package imports (`../../core/src/…`) are NOT
     caught — use the package name. */
  {
    // C1 + C2 for the WHOLE package, tests included (see the header above).
    files: ['packages/core/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_BUILTINS.map((name) => ({
            name,
            message:
              'Constraint C1: packages/core (src and tests) is isomorphic — use the FactsFS/FileWriter interfaces from @factstack/spec, never node:* builtins. Only fs-node, emit and apps/cli may import them.',
          })),
          patterns: [
            {
              group: [
                '@factstack/*',
                '!@factstack/extractors',
                '!@factstack/factspack',
                '!@factstack/fs-memory',
                '!@factstack/graph',
                '!@factstack/intent',
                '!@factstack/parsers',
                '!@factstack/scanners',
                '!@factstack/spec',
                '!@factstack/walker',
              ],
              message:
                'Constraint C2: packages/core may import only the @factstack/* packages it declares in package.json (@factstack/extractors, @factstack/factspack, @factstack/fs-memory, @factstack/graph, @factstack/intent, @factstack/parsers, @factstack/scanners, @factstack/spec, @factstack/walker). Declare the dependency first, then add it to this allow-list (it mirrors the manifest).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/emit/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@factstack/*',
                '!@factstack/core',
                '!@factstack/factspack',
                '!@factstack/spec',
              ],
              message:
                'Constraint C2: packages/emit may import only the @factstack/* packages it declares in package.json (@factstack/core, @factstack/factspack, @factstack/spec). Declare the dependency first, then add it to this allow-list (it mirrors the manifest).',
            },
          ],
        },
      ],
    },
  },
  {
    // C1 + C2 for SOURCE: emit-browser ships to the browser, so node:* is
    // banned there. Tests run in Node and get C2 only (next block).
    files: ['packages/emit-browser/src/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_BUILTINS.map((name) => ({
            name,
            message:
              'Constraint C1: packages/emit-browser/src ships to the browser — never import node:* builtins.',
          })),
          patterns: [
            {
              group: ['@factstack/*', '!@factstack/emit', '!@factstack/skills', '!@factstack/spec'],
              message:
                'Constraint C2: packages/emit-browser may import only the @factstack/* packages it declares in package.json (@factstack/emit, @factstack/skills, @factstack/spec). Declare the dependency first, then add it to this allow-list (it mirrors the manifest).',
            },
          ],
        },
      ],
    },
  },
  {
    // C2 only for everything outside src (tests).
    files: ['packages/emit-browser/**/*.{ts,tsx,mts,cts}'],
    ignores: ['packages/emit-browser/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@factstack/*', '!@factstack/emit', '!@factstack/skills', '!@factstack/spec'],
              message:
                'Constraint C2: packages/emit-browser may import only the @factstack/* packages it declares in package.json (@factstack/emit, @factstack/skills, @factstack/spec). Declare the dependency first, then add it to this allow-list (it mirrors the manifest).',
            },
          ],
        },
      ],
    },
  },
  {
    // C1 + C2 for the WHOLE package, tests included (see the header above).
    files: ['packages/extractors/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_BUILTINS.map((name) => ({
            name,
            message:
              'Constraint C1: packages/extractors (src and tests) is isomorphic — use the FactsFS/FileWriter interfaces from @factstack/spec, never node:* builtins. Only fs-node, emit and apps/cli may import them.',
          })),
          patterns: [
            {
              group: ['@factstack/*', '!@factstack/parsers', '!@factstack/spec'],
              message:
                'Constraint C2: packages/extractors may import only the @factstack/* packages it declares in package.json (@factstack/parsers, @factstack/spec). Declare the dependency first, then add it to this allow-list (it mirrors the manifest).',
            },
          ],
        },
      ],
    },
  },
  {
    // C1 + C2 for SOURCE. C1 is src-only on purpose: tests run in Node and may
    // legitimately import node:* (e.g. factspack/test uses node:crypto).
    files: ['packages/factspack/src/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_BUILTINS.map((name) => ({
            name,
            message:
              'Constraint C1: packages/factspack/src is isomorphic — use the FactsFS/FileWriter interfaces from @factstack/spec, never node:* builtins. Only fs-node, emit and apps/cli may import them.',
          })),
          patterns: [
            {
              group: ['@factstack/*'],
              message:
                'Constraint C2: packages/factspack may import only the @factstack/* packages it declares in package.json (none). Declare the dependency first, then add it to this allow-list (it mirrors the manifest).',
            },
          ],
        },
      ],
    },
  },
  {
    // C2 only for everything outside src (tests, scripts).
    files: ['packages/factspack/**/*.{ts,tsx,mts,cts}'],
    ignores: ['packages/factspack/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@factstack/*'],
              message:
                'Constraint C2: packages/factspack may import only the @factstack/* packages it declares in package.json (none). Declare the dependency first, then add it to this allow-list (it mirrors the manifest).',
            },
          ],
        },
      ],
    },
  },
  {
    // C1 + C2 for the WHOLE package, tests included (see the header above).
    files: ['packages/fs-browser/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_BUILTINS.map((name) => ({
            name,
            message:
              'Constraint C1: packages/fs-browser (src and tests) is isomorphic — use the FactsFS/FileWriter interfaces from @factstack/spec, never node:* builtins. Only fs-node, emit and apps/cli may import them.',
          })),
          patterns: [
            {
              group: ['@factstack/*', '!@factstack/fs-memory', '!@factstack/spec'],
              message:
                'Constraint C2: packages/fs-browser may import only the @factstack/* packages it declares in package.json (@factstack/fs-memory, @factstack/spec). Declare the dependency first, then add it to this allow-list (it mirrors the manifest).',
            },
          ],
        },
      ],
    },
  },
  {
    // C1 + C2 for the WHOLE package, tests included (see the header above).
    files: ['packages/fs-memory/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_BUILTINS.map((name) => ({
            name,
            message:
              'Constraint C1: packages/fs-memory (src and tests) is isomorphic — use the FactsFS/FileWriter interfaces from @factstack/spec, never node:* builtins. Only fs-node, emit and apps/cli may import them.',
          })),
          patterns: [
            {
              group: ['@factstack/*', '!@factstack/spec'],
              message:
                'Constraint C2: packages/fs-memory may import only the @factstack/* packages it declares in package.json (@factstack/spec). Declare the dependency first, then add it to this allow-list (it mirrors the manifest).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/fs-node/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@factstack/*', '!@factstack/spec'],
              message:
                'Constraint C2: packages/fs-node may import only the @factstack/* packages it declares in package.json (@factstack/spec). Declare the dependency first, then add it to this allow-list (it mirrors the manifest).',
            },
          ],
        },
      ],
    },
  },
  {
    // C1 + C2 for the WHOLE package, tests included (see the header above).
    files: ['packages/graph/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_BUILTINS.map((name) => ({
            name,
            message:
              'Constraint C1: packages/graph (src and tests) is isomorphic — use the FactsFS/FileWriter interfaces from @factstack/spec, never node:* builtins. Only fs-node, emit and apps/cli may import them.',
          })),
          patterns: [
            {
              group: ['@factstack/*', '!@factstack/extractors', '!@factstack/spec'],
              message:
                'Constraint C2: packages/graph may import only the @factstack/* packages it declares in package.json (@factstack/extractors, @factstack/spec). Declare the dependency first, then add it to this allow-list (it mirrors the manifest).',
            },
          ],
        },
      ],
    },
  },
  {
    // C1 + C2 for SOURCE. C1 is src-only on purpose: tests run in Node and may
    // legitimately import node:* (e.g. factspack/test uses node:crypto).
    files: ['packages/intent/src/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_BUILTINS.map((name) => ({
            name,
            message:
              'Constraint C1: packages/intent/src is isomorphic — use the FactsFS/FileWriter interfaces from @factstack/spec, never node:* builtins. Only fs-node, emit and apps/cli may import them.',
          })),
          patterns: [
            {
              group: ['@factstack/*', '!@factstack/spec'],
              message:
                'Constraint C2: packages/intent may import only the @factstack/* packages it declares in package.json (@factstack/spec). Declare the dependency first, then add it to this allow-list (it mirrors the manifest).',
            },
          ],
        },
      ],
    },
  },
  {
    // C2 only for everything outside src (tests, scripts).
    files: ['packages/intent/**/*.{ts,tsx,mts,cts}'],
    ignores: ['packages/intent/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@factstack/*', '!@factstack/spec'],
              message:
                'Constraint C2: packages/intent may import only the @factstack/* packages it declares in package.json (@factstack/spec). Declare the dependency first, then add it to this allow-list (it mirrors the manifest).',
            },
          ],
        },
      ],
    },
  },
  {
    // C1 + C2 for the WHOLE package, tests included (see the header above).
    files: ['packages/parsers/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_BUILTINS.map((name) => ({
            name,
            message:
              'Constraint C1: packages/parsers (src and tests) is isomorphic — use the FactsFS/FileWriter interfaces from @factstack/spec, never node:* builtins. Only fs-node, emit and apps/cli may import them.',
          })),
          patterns: [
            {
              group: ['@factstack/*', '!@factstack/spec'],
              message:
                'Constraint C2: packages/parsers may import only the @factstack/* packages it declares in package.json (@factstack/spec). Declare the dependency first, then add it to this allow-list (it mirrors the manifest).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/registry/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@factstack/*', '!@factstack/spec'],
              message:
                'Constraint C2: packages/registry may import only the @factstack/* packages it declares in package.json (@factstack/spec). Declare the dependency first, then add it to this allow-list (it mirrors the manifest).',
            },
          ],
        },
      ],
    },
  },
  {
    // C1 + C2 for the WHOLE package, tests included (see the header above).
    files: ['packages/scanners/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_BUILTINS.map((name) => ({
            name,
            message:
              'Constraint C1: packages/scanners (src and tests) is isomorphic — use the FactsFS/FileWriter interfaces from @factstack/spec, never node:* builtins. Only fs-node, emit and apps/cli may import them.',
          })),
          patterns: [
            {
              group: ['@factstack/*', '!@factstack/extractors', '!@factstack/spec'],
              message:
                'Constraint C2: packages/scanners may import only the @factstack/* packages it declares in package.json (@factstack/extractors, @factstack/spec). Declare the dependency first, then add it to this allow-list (it mirrors the manifest).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/site-kit/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@factstack/*', '!@factstack/registry', '!@factstack/spec'],
              message:
                'Constraint C2: packages/site-kit may import only the @factstack/* packages it declares in package.json (@factstack/registry, @factstack/spec). Declare the dependency first, then add it to this allow-list (it mirrors the manifest).',
            },
          ],
        },
      ],
    },
  },
  {
    // C1 + C2 for SOURCE: skills is bundled into the browser via emit-browser,
    // so node:* is banned there. Tests run in Node and get C2 only (next block).
    files: ['packages/skills/src/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_BUILTINS.map((name) => ({
            name,
            message:
              'Constraint C1: packages/skills/src ships to the browser (via emit-browser) — never import node:* builtins.',
          })),
          patterns: [
            {
              group: ['@factstack/*', '!@factstack/spec'],
              message:
                'Constraint C2: packages/skills may import only the @factstack/* packages it declares in package.json (@factstack/spec). Declare the dependency first, then add it to this allow-list (it mirrors the manifest).',
            },
          ],
        },
      ],
    },
  },
  {
    // C2 only for everything outside src (tests).
    files: ['packages/skills/**/*.{ts,tsx,mts,cts}'],
    ignores: ['packages/skills/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@factstack/*', '!@factstack/spec'],
              message:
                'Constraint C2: packages/skills may import only the @factstack/* packages it declares in package.json (@factstack/spec). Declare the dependency first, then add it to this allow-list (it mirrors the manifest).',
            },
          ],
        },
      ],
    },
  },
  {
    // C1 + C2 for the WHOLE package, tests included (see the header above).
    files: ['packages/spec/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_BUILTINS.map((name) => ({
            name,
            message:
              'Constraint C1: packages/spec (src and tests) is isomorphic — use the FactsFS/FileWriter interfaces from @factstack/spec, never node:* builtins. Only fs-node, emit and apps/cli may import them.',
          })),
          patterns: [
            {
              group: ['@factstack/*'],
              message:
                'Constraint C2: packages/spec may import only the @factstack/* packages it declares in package.json (none). Declare the dependency first, then add it to this allow-list (it mirrors the manifest).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/ui-theme/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@factstack/*'],
              message:
                'Constraint C2: packages/ui-theme may import only the @factstack/* packages it declares in package.json (none). Declare the dependency first, then add it to this allow-list (it mirrors the manifest).',
            },
          ],
        },
      ],
    },
  },
  {
    // C1 + C2 for the WHOLE package, tests included (see the header above).
    files: ['packages/walker/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_BUILTINS.map((name) => ({
            name,
            message:
              'Constraint C1: packages/walker (src and tests) is isomorphic — use the FactsFS/FileWriter interfaces from @factstack/spec, never node:* builtins. Only fs-node, emit and apps/cli may import them.',
          })),
          patterns: [
            {
              group: ['@factstack/*', '!@factstack/fs-memory', '!@factstack/spec'],
              message:
                'Constraint C2: packages/walker may import only the @factstack/* packages it declares in package.json (@factstack/fs-memory, @factstack/spec). Declare the dependency first, then add it to this allow-list (it mirrors the manifest).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/chrome-ext/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@factstack/*',
                '!@factstack/core',
                '!@factstack/emit',
                '!@factstack/fs-browser',
                '!@factstack/fs-memory',
                '!@factstack/spec',
                '!@factstack/ui-theme',
              ],
              message:
                'Constraint C2: apps/chrome-ext may import only the @factstack/* packages it declares in package.json (@factstack/core, @factstack/emit, @factstack/fs-browser, @factstack/fs-memory, @factstack/spec, @factstack/ui-theme). Declare the dependency first, then add it to this allow-list (it mirrors the manifest).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/cli/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@factstack/*',
                '!@factstack/core',
                '!@factstack/emit',
                '!@factstack/extractors',
                '!@factstack/fs-node',
                '!@factstack/scanners',
                '!@factstack/skills',
                '!@factstack/spec',
              ],
              message:
                'Constraint C2: apps/cli may import only the @factstack/* packages it declares in package.json (@factstack/core, @factstack/emit, @factstack/extractors, @factstack/fs-node, @factstack/scanners, @factstack/skills, @factstack/spec). Declare the dependency first, then add it to this allow-list (it mirrors the manifest).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/mcp-server/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@factstack/*',
                '!@factstack/core',
                '!@factstack/emit',
                '!@factstack/extractors',
                '!@factstack/factspack',
                '!@factstack/fs-node',
                '!@factstack/scanners',
                '!@factstack/spec',
              ],
              message:
                'Constraint C2: apps/mcp-server may import only the @factstack/* packages it declares in package.json (@factstack/core, @factstack/emit, @factstack/extractors, @factstack/factspack, @factstack/fs-node, @factstack/scanners, @factstack/spec). Declare the dependency first, then add it to this allow-list (it mirrors the manifest).',
            },
          ],
        },
      ],
    },
  },
  {
    // C1 + C2 for the browser app's SOURCE. vite.config.ts, scripts and tests
    // run in Node and get C2 only (next block).
    files: ['apps/ui-remix/src/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_BUILTINS.map((name) => ({
            name,
            message:
              'Constraint C1: apps/ui-remix/src runs in the browser — never import node:* builtins.',
          })),
          patterns: [
            {
              group: [
                '@factstack/*',
                '!@factstack/core',
                '!@factstack/emit',
                '!@factstack/emit-browser',
                '!@factstack/fs-browser',
                '!@factstack/fs-memory',
                '!@factstack/registry',
                '!@factstack/scanners',
                '!@factstack/site-kit',
                '!@factstack/spec',
                '!@factstack/ui-theme',
              ],
              message:
                'Constraint C2: apps/ui-remix may import only the @factstack/* packages it declares in package.json (@factstack/core, @factstack/emit, @factstack/emit-browser, @factstack/fs-browser, @factstack/fs-memory, @factstack/registry, @factstack/scanners, @factstack/site-kit, @factstack/spec, @factstack/ui-theme). Declare the dependency first, then add it to this allow-list (it mirrors the manifest).',
            },
          ],
        },
      ],
    },
  },
  {
    // C2 only for everything outside src (vite.config.ts, tests).
    files: ['apps/ui-remix/**/*.{ts,tsx,mts,cts}'],
    ignores: ['apps/ui-remix/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@factstack/*',
                '!@factstack/core',
                '!@factstack/emit',
                '!@factstack/emit-browser',
                '!@factstack/fs-browser',
                '!@factstack/fs-memory',
                '!@factstack/registry',
                '!@factstack/scanners',
                '!@factstack/site-kit',
                '!@factstack/spec',
                '!@factstack/ui-theme',
              ],
              message:
                'Constraint C2: apps/ui-remix may import only the @factstack/* packages it declares in package.json (@factstack/core, @factstack/emit, @factstack/emit-browser, @factstack/fs-browser, @factstack/fs-memory, @factstack/registry, @factstack/scanners, @factstack/site-kit, @factstack/spec, @factstack/ui-theme). Declare the dependency first, then add it to this allow-list (it mirrors the manifest).',
            },
          ],
        },
      ],
    },
  },
  /* ── BOUNDARY GATE, NOT A STYLE LINTER ──────────────────────────────────
   * This config exists for the C1/C2 no-restricted-imports bans above;
   * oxlint owns style (`pnpm lint`). It was never
   * actually installed until 2026-09-14, and the recommended rule sets it
   * pulls in had drifted 200+ findings across the repo — every one of them a
   * duplicate of an oxlint warning, none of them a boundary. Style findings
   * are kept visible as WARNINGS so the gate cannot go red for a reason it
   * was never meant to police; a real boundary violation still fails it. */
  {
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        queueMicrotask: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        performance: 'readonly',
        structuredClone: 'readonly',
        AbortController: 'readonly',
        crypto: 'readonly',
        document: 'readonly',
        window: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        matchMedia: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        HTMLElement: 'readonly',
        Element: 'readonly',
        Node: 'readonly',
        Event: 'readonly',
        CustomEvent: 'readonly',
        MutationObserver: 'readonly',
        ResizeObserver: 'readonly',
        IntersectionObserver: 'readonly',
        Worker: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        FileReader: 'readonly',
        FormData: 'readonly',
        WebSocket: 'readonly',
        EventSource: 'readonly',
        module: 'readonly',
        require: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
      },
    },
    rules: {
      /* `_`-prefixed names are the codebase's "deliberately unused" convention
         (e.g. `_handle` for a destructured-but-ignored value, `_` for an
         ignored callback arg) — honour it instead of reporting them. */
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
      'no-useless-assignment': 'warn',
      'no-useless-escape': 'warn',
      'no-empty': 'warn',
      'no-regex-spaces': 'warn',
      /* The only hits are deliberate zero-width spaces used to write `*<ZWSP>/`
         inside a block comment without closing it. Removing them would break
         the file, so allow them in comments while still flagging them in code. */
      'no-irregular-whitespace': ['warn', { skipComments: true }],
      'preserve-caught-error': 'warn',
      'no-unused-vars': 'warn',
    },
  },
  // TypeScript files: the compiler already checks every identifier; ESLint's
  // `no-undef` has no type information and flags DOM/Node globals (the
  // typescript-eslint docs say to turn it off for TS).
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    rules: { 'no-undef': 'off' },
  },
  {
    ignores: [
      // Flat-config globs are root-relative: `dist/**` alone ignored only a
      // top-level dist and let `apps/ui-remix/dist/**` — the built bundle —
      // be linted whenever a build had just run (114 phantom errors).
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.turbo/**',
      '**/.remix/**',
      '**/coverage/**',
      // Not this project's source: the pre-v0.3 prototype, agent worktrees,
      // generated docs/audits, the benchmark corpus, and analyzer output.
      'legacy/**',
      'prototype/**',
      '.claude/**',
      'docs/**',
      'bench/corpus/**',
      '**/.facts/**',
      /* Untracked local scratch (all gitignored). Linting files git does not
         track makes the result machine-dependent — CI never sees them, so a
         locally-clean tree could still differ from a locally-noisy one. */
      '**/probe*.mjs',
      '**/_scrub-test*.mjs',
      'fb.mjs',
      // Vendored agent skill packs — third-party content, not project source.
      '.agents/**',
    ],
  },
);
