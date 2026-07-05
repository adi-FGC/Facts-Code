// @ts-check
/**
 * Root ESLint config. Enforces the package boundary rules from the plan
 * (constraints C1 and C2) via eslint-plugin-boundaries + a
 * no-restricted-imports rule banning Node built-ins from the isomorphic
 * core packages.
 *
 * This is the insurance policy that prevents the Chrome extension (v0.4)
 * and the WASM analyzer from quietly breaking as core evolves.
 */

import js from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import tseslint from 'typescript-eslint';

const NODE_BUILTINS = [
  'fs',
  'fs/promises',
  'path',
  'os',
  'child_process',
  'worker_threads',
  'cluster',
  'crypto',
  'net',
  'tls',
  'http',
  'https',
  'url',
  'node:fs',
  'node:fs/promises',
  'node:path',
  'node:os',
  'node:child_process',
  'node:worker_threads',
  'node:cluster',
  'node:crypto',
  'node:net',
  'node:tls',
  'node:http',
  'node:https',
  'node:url',
];

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        { type: 'spec', pattern: 'packages/spec/**' },
        { type: 'fs-node', pattern: 'packages/fs-node/**' },
        { type: 'fs-memory', pattern: 'packages/fs-memory/**' },
        { type: 'fs-browser', pattern: 'packages/fs-browser/**' },
        { type: 'walker', pattern: 'packages/walker/**' },
        { type: 'parsers', pattern: 'packages/parsers/**' },
        { type: 'extractors', pattern: 'packages/extractors/**' },
        { type: 'graph', pattern: 'packages/graph/**' },
        { type: 'scanners', pattern: 'packages/scanners/**' },
        { type: 'core', pattern: 'packages/core/**' },
        { type: 'emit', pattern: 'packages/emit/**' },
        { type: 'skills', pattern: 'packages/skills/**' },
        { type: 'registry', pattern: 'packages/registry/**' },
        { type: 'site-kit', pattern: 'packages/site-kit/**' },
        { type: 'ui-theme', pattern: 'packages/ui-theme/**' },
        { type: 'app-cli', pattern: 'apps/cli/**' },
        { type: 'app-ui', pattern: 'apps/ui-remix/**' },
        { type: 'app-mcp', pattern: 'apps/mcp-server/**' },
        { type: 'app-stub', pattern: 'apps/{vscode-ext,chrome-ext,webapp}/**' },
        { type: 'plugin', pattern: 'plugins/*/**' },
      ],
    },
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: 'spec', allow: [] },
            { from: 'fs-node', allow: ['spec'] },
            { from: 'fs-memory', allow: ['spec'] },
            { from: 'fs-browser', allow: ['spec'] },
            { from: 'walker', allow: ['spec'] },
            { from: 'parsers', allow: ['spec'] },
            { from: 'extractors', allow: ['spec', 'parsers'] },
            { from: 'graph', allow: ['spec', 'extractors'] },
            { from: 'scanners', allow: ['spec', 'extractors'] },
            {
              from: 'core',
              allow: ['spec', 'walker', 'parsers', 'extractors', 'graph', 'scanners'],
            },
            {
              from: 'emit',
              allow: ['spec', 'core', 'walker', 'parsers', 'extractors', 'graph', 'scanners'],
            },
            { from: 'ui-theme', allow: [] },
            { from: 'skills', allow: ['spec'] },
            { from: 'registry', allow: ['spec'] },
            { from: 'site-kit', allow: ['registry', 'spec'] },
            // Each app's allow list mirrors its package.json dependencies
            // exactly — adding a workspace import requires declaring the
            // dep AND listing it here. Drift caught by lint, not runtime.
            {
              from: 'app-cli',
              allow: ['spec', 'core', 'emit', 'fs-node', 'extractors'],
            },
            { from: 'app-ui', allow: ['spec', 'ui-theme', 'emit', 'registry', 'site-kit'] },
            {
              from: 'app-mcp',
              allow: ['spec', 'core', 'emit', 'fs-node', 'extractors'],
            },
            {
              from: 'app-stub',
              allow: [
                'spec',
                'core',
                'emit',
                'fs-node',
                'fs-browser',
                'ui-theme',
                'scanners',
                'graph',
              ],
            },
            { from: 'plugin', allow: ['spec'] },
          ],
        },
      ],
    },
  },
  // Constraint C1: isomorphic core may not import Node built-ins.
  {
    files: [
      'packages/spec/**/*.{ts,tsx}',
      'packages/walker/**/*.{ts,tsx}',
      'packages/parsers/**/*.{ts,tsx}',
      'packages/extractors/**/*.{ts,tsx}',
      'packages/graph/**/*.{ts,tsx}',
      'packages/scanners/**/*.{ts,tsx}',
      'packages/core/**/*.{ts,tsx}',
      'packages/fs-memory/**/*.{ts,tsx}',
      'packages/fs-browser/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_BUILTINS.map((name) => ({
            name,
            message:
              'Constraint C1: isomorphic core must use the FactsFS interface from @factstack/spec, not Node built-ins. Only packages/fs-node, packages/emit, and apps/cli may import node:* modules.',
          })),
        },
      ],
    },
  },
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      '.turbo/**',
      '.remix/**',
      'coverage/**',
      'examples/**/node_modules/**',
    ],
  },
);
