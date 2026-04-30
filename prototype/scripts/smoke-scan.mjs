#!/usr/bin/env node
/**
 * Smoke test for prototype/index.html's scan flow.
 *
 * Approach: extract the function bodies for scanHandle, rootifyDataset,
 * extractImportsFromSource, plus their helpers (dirnameP, normP, probeP,
 * resolveSpecP, ALWAYS_EXCLUDE, EXT_LANG, IMPORT_EXTS) directly from
 * the HTML, glue them into a minimal module, and run them against a
 * mocked FileSystemDirectoryHandle.
 *
 * This is a regression guard for the bug that motivated this file:
 * scanHandle's `isRoot = !ctx` made the openBtn handler (which passes
 * a ctx with progress hooks) skip rootification — DATA.project came
 * back undefined, breaking every renderer.
 *
 * Run: node prototype/scripts/smoke-scan.mjs
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, '..', 'index.html'), 'utf8');

// Pull a single function declaration out by name. Scans for
// `[async ]function NAME(...) {` then balanced braces to find the
// matching close. Lightweight but works for the prototype's straight
// JS (no nested-function-with-same-name shenanigans).
function extractFunction(src, name) {
  const re = new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`, 'g');
  const m = re.exec(src);
  if (!m) throw new Error(`could not find function ${name}`);
  const start = m.index;
  // Find the body's opening brace.
  let i = src.indexOf('{', m.index);
  if (i < 0) throw new Error(`no body for ${name}`);
  let depth = 0;
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;
  let inTemplate = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    // Comments
    if (inLineComment) { if (c === '\n') inLineComment = false; continue; }
    if (inBlockComment) { if (c === '*' && n === '/') { inBlockComment = false; i++; } continue; }
    if (!inString && !inTemplate) {
      if (c === '/' && n === '/') { inLineComment = true; i++; continue; }
      if (c === '/' && n === '*') { inBlockComment = true; i++; continue; }
    }
    // Strings
    if (inString) {
      if (c === '\\') { i++; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (inTemplate > 0) {
      if (c === '\\') { i++; continue; }
      if (c === '`') inTemplate--;
      continue;
    }
    if (c === '"' || c === "'") { inString = c; continue; }
    if (c === '`') { inTemplate++; continue; }
    // Braces
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces for ${name}`);
}

// Pull a top-level const declaration that's a literal object/Set/array.
function extractConst(src, name) {
  const re = new RegExp(`const\\s+${name}\\s*=`, 'g');
  const m = re.exec(src);
  if (!m) throw new Error(`could not find const ${name}`);
  const start = m.index;
  // Match until the line's terminating semicolon at depth 0.
  let i = m.index + m[0].length;
  let depth = 0;
  let inString = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inString) { if (c === '\\') { i++; continue; } if (c === inString) inString = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inString = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ';' && depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated const ${name}`);
}

const FUNCTIONS = ['scanHandle', 'rootifyDataset', 'extractImportsFromSource', 'dirnameP', 'normP', 'probeP', 'resolveSpecP'];
const CONSTANTS = ['ALWAYS_EXCLUDE', 'EXT_LANG', 'IMPORT_EXTS'];

let glue = '';
for (const c of CONSTANTS) glue += extractConst(html, c) + '\n\n';
for (const f of FUNCTIONS) glue += extractFunction(html, f) + '\n\n';
// Stub for getBabelParser — return null so import extraction returns []
glue += 'async function getBabelParser() { return null; }\n';
// Wrap in async IIFE so any await inside the extracted bodies works.
glue = '(async () => {\n' + glue + '\nglobalThis.__scanHandle__ = scanHandle;\n})();';

// Run in a fresh vm with the bare minimum of globals.
const vm = await import('node:vm');
const sandbox = { console, setTimeout, clearTimeout, Promise, Map, Set, Array, Object, JSON, Math, Date, RegExp, Error };
const ctx = vm.createContext(sandbox);
vm.runInContext(glue, ctx, { filename: 'extracted-scan-core' });

// Wait for the IIFE to assign scanHandle.
let scanHandle = null;
for (let i = 0; i < 50; i++) {
  if (typeof sandbox.__scanHandle__ === 'function') { scanHandle = sandbox.__scanHandle__; break; }
  await new Promise((r) => setTimeout(r, 20));
}
if (typeof scanHandle !== 'function') {
  console.error('FAIL: scanHandle was not exposed');
  process.exit(1);
}

// ── Mock FileSystemDirectoryHandle / FileSystemFileHandle ──────────
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

// Realistic fixture: nested folders, package.json, code files, fixture data.
const fixture = mockDir('demo-app', [
  mockFile('package.json', JSON.stringify({ name: 'demo-app', version: '0.1.0', description: 'demo project' })),
  mockFile('README.md', '# demo-app\n\n> a small demo for the smoke test'),
  mockDir('src', [
    mockFile('index.ts', `import { greet } from './lib';\nconsole.log(greet('world'));\n`),
    mockFile('lib.ts', `export function greet(name: string): string { return 'hello ' + name; }\n`),
    mockDir('components', [
      mockFile('Button.tsx', `export function Button() { return null; }\n`),
    ]),
  ]),
]);

// ── Run scanHandle with a ctx that mirrors what openBtn passes ─────
const progressEvents = [];
const dataset = await scanHandle(fixture, '', {
  allFiles: [],
  parse: null,
  packageJsons: [],
  onProgress: (e) => progressEvents.push(e.phase),
  cancelled: () => false,
});

// ── Assertions ──────────────────────────────────────────────────────
const fail = (msg) => { console.error('FAIL:', msg); process.exit(1); };
if (!dataset || typeof dataset !== 'object') fail('dataset is not an object');
if (!dataset.project) fail('dataset.project missing — rootification did not run');
if (!Array.isArray(dataset.project.languages)) fail('dataset.project.languages is not an array');
if (!Array.isArray(dataset.project.frameworks)) fail('dataset.project.frameworks is not an array');
if (!dataset.summary) fail('dataset.summary missing');
if (!dataset.stats) fail('dataset.stats missing');
if (!dataset.tree) fail('dataset.tree missing');
if (typeof dataset.stats.files !== 'number') fail('dataset.stats.files not a number');
if (dataset.stats.files === 0) fail('dataset.stats.files is 0 — fixture did not parse');
if (!progressEvents.includes('walking')) fail('onProgress never reported "walking" phase');
if (!progressEvents.includes('done')) fail('onProgress never reported "done" phase');

console.log('OK · scanHandle returned a complete dataset');
console.log('  project.name        :', dataset.project.name);
console.log('  project.root        :', dataset.project.root);
console.log('  project.languages   :', dataset.project.languages.length, 'language(s)');
console.log('  stats.files         :', dataset.stats.files);
console.log('  stats.tokens        :', dataset.stats.tokens);
console.log('  edges               :', (dataset.edges || []).length);
console.log('  progress phases     :', progressEvents.join(' → '));
