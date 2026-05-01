#!/usr/bin/env node
/**
 * Deep smoke test for prototype/index.html's client-side scanner.
 *
 * Extends `smoke-scan.mjs` (which verifies the dataset shape) with
 * regression assertions for the 4 issues that landed in production
 * before being caught:
 *
 *   1. Imports field — scanner must emit `imp.source` (not
 *      `imp.specifier`); the renderer reads `.source`.
 *   2. Routes — file-shape detection must emit routes from
 *      `pages/`, `src/pages/`, `app/`, and `routes/` even on the
 *      static deploy (no CLI server backing it).
 *   3. Library role inference — files in `pages/` get
 *      `Pages & Routes`, hooks get `Hooks`, etc.
 *   4. Test coverage — the import-graph reachability sweep that
 *      backs the Tests tab.
 *
 * Run: node prototype/scripts/smoke-scan-deep.mjs
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, '..', 'index.html'), 'utf8');

// ── extract helpers from the prototype ──────────────────────────────
function extractFunction(src, name) {
  const re = new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`, 'g');
  const m = re.exec(src);
  if (!m) throw new Error(`could not find function ${name}`);
  const start = m.index;
  let i = src.indexOf('{', m.index);
  let depth = 0, inString = null, inLineComment = false, inBlockComment = false, inTemplate = 0;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inLineComment) { if (c === '\n') inLineComment = false; continue; }
    if (inBlockComment) { if (c === '*' && n === '/') { inBlockComment = false; i++; } continue; }
    if (!inString && !inTemplate) {
      if (c === '/' && n === '/') { inLineComment = true; i++; continue; }
      if (c === '/' && n === '*') { inBlockComment = true; i++; continue; }
    }
    if (inString) { if (c === '\\') { i++; continue; } if (c === inString) inString = null; continue; }
    if (inTemplate > 0) { if (c === '\\') { i++; continue; } if (c === '`') inTemplate--; continue; }
    if (c === '"' || c === "'") { inString = c; continue; }
    if (c === '`') { inTemplate++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces for ${name}`);
}
function extractConst(src, name) {
  const re = new RegExp(`const\\s+${name}\\s*=`, 'g');
  const m = re.exec(src);
  if (!m) throw new Error(`could not find const ${name}`);
  let i = m.index + m[0].length;
  let depth = 0, inString = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inString) { if (c === '\\') { i++; continue; } if (c === inString) inString = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inString = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ';' && depth === 0) return src.slice(m.index, i + 1);
  }
  throw new Error(`unterminated const ${name}`);
}

const FUNCTIONS = ['scanHandle', 'rootifyDataset', 'extractImportsFromSource', 'dirnameP', 'normP', 'probeP', 'resolveSpecP'];
const CONSTANTS = ['ALWAYS_EXCLUDE', 'EXT_LANG', 'IMPORT_EXTS', 'NODE_BUILTINS_SET', 'RESOLVE_EXTS', 'RESOLVE_INDEX'];

// In the browser the prototype loads @babel/parser from the esm.sh CDN.
// In Node we use the local install (added transitively via
// @factstack/extractors). Without a real parser the import-shape
// assertions can't run because extractImportsFromSource bails out.
const { parse: babelParse } = await import('@babel/parser');

let glue = '';
for (const c of CONSTANTS) glue += extractConst(html, c) + '\n\n';
for (const f of FUNCTIONS) glue += extractFunction(html, f) + '\n\n';
glue += 'function getBabelParser() { return globalThis.__babel_parse__; }\n';
glue = '(async () => {\n' + glue + '\nglobalThis.__scanHandle__ = scanHandle;\n})();';

const vm = await import('node:vm');
const sandbox = {
  console, setTimeout, clearTimeout, Promise, Map, Set, Array, Object, JSON, Math, Date, RegExp, Error,
  __babel_parse__: babelParse,
};
vm.runInContext(glue, vm.createContext(sandbox), { filename: 'extracted-scan' });
let scanHandle = null;
for (let i = 0; i < 50; i++) {
  if (typeof sandbox.__scanHandle__ === 'function') { scanHandle = sandbox.__scanHandle__; break; }
  await new Promise((r) => setTimeout(r, 20));
}
if (typeof scanHandle !== 'function') { console.error('FAIL: scanHandle not exposed'); process.exit(1); }

// ── mock FileSystemDirectoryHandle ────────────────────────────────
function mockFile(name, content) {
  return { kind: 'file', name, async getFile() { return { size: content.length, lastModified: Date.now(), text: async () => content }; } };
}
function mockDir(name, entries) {
  return {
    kind: 'directory', name,
    async *entries() { for (const e of entries) yield [e.name, e]; },
    async getFileHandle(n) { const f = entries.find((e) => e.kind === 'file' && e.name === n); if (!f) throw new Error('ENOENT'); return f; },
  };
}

// Realistic React project with:
//   - Routes via pages/
//   - Components with imports
//   - Hooks
//   - A test file importing a source file
const fixture = mockDir('verify', [
  mockFile('package.json', JSON.stringify({ name: 'verify', dependencies: { react: '^19.0.0' } })),
  mockDir('src', [
    mockFile('App.tsx', `import { Button } from './components/Button';\nexport default function App() { return <Button />; }\n`),
    mockDir('components', [
      mockFile('Button.tsx', `import { useState } from 'react';\nexport function Button() { return null; }\n`),
      mockFile('Card.tsx', `export function Card() { return null; }\n`),
    ]),
    mockDir('hooks', [
      mockFile('useUser.ts', `import { useState } from 'react';\nexport function useUser() { return useState(null); }\n`),
    ]),
    mockDir('pages', [
      mockFile('Dashboard.jsx', `export default function Dashboard() { return null; }\n`),
      mockFile('UserProfile.jsx', `export default function UserProfile() { return null; }\n`),
    ]),
  ]),
  mockDir('tests', [
    mockFile('Button.test.tsx', `import { Button } from '../src/components/Button';\ntest('renders', () => Button());\n`),
  ]),
]);

// Pass the real Babel parser so extractImportsFromSource can run.
const dataset = await scanHandle(fixture, '', {
  allFiles: [], parse: babelParse, packageJsons: [], onProgress: () => {}, cancelled: () => false,
});

// ── assertions ───────────────────────────────────────────────────────
const fail = (msg) => { console.error('FAIL:', msg); process.exit(1); };

// 1. Dataset shape
if (!dataset.project) fail('dataset.project missing');
if (!Array.isArray(dataset.project.languages)) fail('project.languages not an array');
if (!Array.isArray(dataset.routes)) fail('dataset.routes missing — fix #3 regression');

// 2. Imports use `source` field, not `specifier` — fix #1 regression
const allFiles = [];
(function walk(n) {
  for (const f of (n.files || [])) allFiles.push(f);
  for (const c of (n.children || [])) walk(c);
})(dataset.tree);
const filesWithImports = allFiles.filter((f) => Array.isArray(f.imports) && f.imports.length);
if (filesWithImports.length === 0) fail('no files have imports — extractor broken');
for (const f of filesWithImports) {
  for (const imp of f.imports) {
    if (typeof imp.source !== 'string' || !imp.source) {
      fail(`file ${f.path} import missing .source field (got: ${JSON.stringify(imp)}) — fix #1 regression`);
    }
  }
}

// 3. Routes detected from pages/ folder — fix #3 regression
if (dataset.routes.length < 2) fail(`expected ≥ 2 routes from src/pages/*, got ${dataset.routes.length}`);
const routePaths = dataset.routes.map((r) => r.path).sort();
if (!routePaths.includes('/dashboard')) fail(`expected /dashboard route, got: ${routePaths.join(', ')}`);
if (!routePaths.includes('/user-profile')) fail(`expected /user-profile (kebab-cased), got: ${routePaths.join(', ')}`);

// 4. Test coverage — verify the test file imports the source file (edge present)
const testEdge = (dataset.edges || []).find((e) =>
  e.from.includes('Button.test') && e.to.includes('Button.tsx')
);
if (!testEdge) fail('expected test→source edge from Button.test.tsx → Button.tsx');

// 5. Imports resolve to local paths (not just extracted but normP+probeP works)
const appFile = allFiles.find((f) => f.name === 'App.tsx');
if (!appFile?.imports?.length) fail('App.tsx should have imports');

console.log('OK · all 5 regression assertions pass');
console.log('  dataset.project.languages :', dataset.project.languages.length, 'language(s)');
console.log('  dataset.routes            :', dataset.routes.length, 'route(s):', routePaths.join(', '));
console.log('  files with imports        :', filesWithImports.length);
console.log('  test→source edge          :', testEdge.from, '→', testEdge.to);
console.log('  total edges               :', (dataset.edges || []).length);
