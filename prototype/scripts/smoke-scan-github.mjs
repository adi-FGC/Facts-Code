#!/usr/bin/env node
/**
 * GitHub-source smoke test for prototype/index.html.
 *
 * Verifies the new path that lets users scan any GitHub repo:
 *
 *   1. parseRepoSpec — accepts owner/repo, owner/repo@ref, full URLs.
 *   2. repoSpecKey   — produces stable, sanitized storage paths.
 *   3. buildHandleFromZip — builds a FileSystemDirectoryHandle-shaped
 *      tree from a JSZip-shaped object so the EXISTING scanHandle
 *      pipeline (covered by smoke-scan-deep.mjs) runs unchanged.
 *
 * We don't hit the network here — the prod path uses
 *   GET https://api.github.com/repos/{owner}/{repo}/zipball
 * which is covered by manual QA + the live demo. This test pins the
 * adapter shape so refactors don't silently drop methods scanHandle
 * relies on (`entries`, `getFileHandle`, `kind`, `name`).
 *
 * Run: node prototype/scripts/smoke-scan-github.mjs
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, '..', 'index.html'), 'utf8');

// ── extract via markers ──────────────────────────────────────────────
// Brace-tracking extractors trip on regex literals like /^https?:\/\//
// (the // sequence is parsed as a line-comment). The prototype wraps
// the three pure helpers we want to test in
//   // FACTSTACK_GH_API_START
//   …
//   // FACTSTACK_GH_API_END
// so this test pulls everything between them verbatim. Stable + simple.
const START = '// FACTSTACK_GH_API_START';
const END   = '// FACTSTACK_GH_API_END';
const startIx = html.indexOf(START);
const endIx   = html.indexOf(END);
if (startIx < 0 || endIx < 0 || endIx < startIx) {
  console.error('FAIL: could not find FACTSTACK_GH_API markers in prototype/index.html');
  process.exit(1);
}
let glue = html.slice(startIx, endIx);
// Expose to the surrounding sandbox
glue += '\nglobalThis.__parseRepoSpec__ = parseRepoSpec;\n';
glue += 'globalThis.__repoSpecKey__ = repoSpecKey;\n';
glue += 'globalThis.__buildHandleFromZip__ = buildHandleFromZip;\n';

const sandbox = { console, Map, Set, Array, Object, JSON, Math, Date, RegExp, Error, TextDecoder, TextEncoder, URL, Promise, performance };
vm.runInContext(glue, vm.createContext(sandbox), { filename: 'extracted-gh' });
const parseRepoSpec = sandbox.__parseRepoSpec__;
const repoSpecKey = sandbox.__repoSpecKey__;
const buildHandleFromZip = sandbox.__buildHandleFromZip__;

const fail = (msg) => { console.error('FAIL:', msg); process.exit(1); };
const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) fail(`${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

// ── parseRepoSpec ────────────────────────────────────────────────────
eq(parseRepoSpec('vercel/next.js'),                { owner: 'vercel', repo: 'next.js', ref: '' }, 'bare owner/repo');
eq(parseRepoSpec('vercel/next.js@canary'),         { owner: 'vercel', repo: 'next.js', ref: 'canary' }, 'owner/repo@ref');
eq(parseRepoSpec('https://github.com/vercel/next.js'),                 { owner: 'vercel', repo: 'next.js', ref: '' }, 'plain URL');
eq(parseRepoSpec('https://github.com/vercel/next.js/tree/main'),       { owner: 'vercel', repo: 'next.js', ref: 'main' }, 'tree URL');
eq(parseRepoSpec('https://github.com/vercel/next.js/blob/main/README.md'), { owner: 'vercel', repo: 'next.js', ref: 'main' }, 'blob URL strips path');
eq(parseRepoSpec('https://github.com/vercel/next.js.git'),             { owner: 'vercel', repo: 'next.js', ref: '' }, '.git suffix stripped');
if (parseRepoSpec('') !== null) fail('empty input must return null');
if (parseRepoSpec('not-a-repo') !== null) fail('missing slash must return null');
if (parseRepoSpec('https://gitlab.com/foo/bar') !== null) fail('non-github host must return null');
if (parseRepoSpec(null) !== null) fail('null input must return null');

// ── repoSpecKey ──────────────────────────────────────────────────────
eq(repoSpecKey({ owner: 'vercel', repo: 'next.js' }), 'vercel/next.js', 'no ref');
eq(repoSpecKey({ owner: 'vercel', repo: 'next.js', ref: 'main' }), 'vercel/next.js@main', 'with ref');
// Path-traversal hardening: any non-safe character must be replaced.
eq(repoSpecKey({ owner: '../evil', repo: '..' }), '.._evil/..', 'sanitizes traversal in owner');
// Special chars are normalized to underscores so storage paths stay flat.
eq(repoSpecKey({ owner: 'a b', repo: 'c$d' }), 'a_b/c_d', 'spaces and $ sanitized');

// ── buildHandleFromZip ───────────────────────────────────────────────
// JSZip-shaped fixture: { files: { [zipPath]: { dir, async(type) } } }
function fakeZip(entries) {
  const files = {};
  for (const [path, content] of Object.entries(entries)) {
    const isDir = path.endsWith('/');
    files[path] = {
      dir: isDir,
      async async(type) {
        if (isDir) return type === 'uint8array' ? new Uint8Array() : '';
        const text = String(content);
        if (type === 'uint8array') return new TextEncoder().encode(text);
        return text;
      },
      date: new Date('2026-04-30T00:00:00Z'),
    };
  }
  return { files };
}

// GitHub zipball wraps everything in `owner-repo-shortsha/`.
const zip = fakeZip({
  'vercel-next.js-abc1234/': null,
  'vercel-next.js-abc1234/package.json': JSON.stringify({ name: 'next-fake', version: '15.0.0' }),
  'vercel-next.js-abc1234/src/': null,
  'vercel-next.js-abc1234/src/index.ts': "export const x = 1;\n",
  'vercel-next.js-abc1234/src/lib/': null,
  'vercel-next.js-abc1234/src/lib/util.ts': "export function util() { return 42; }\n",
  'vercel-next.js-abc1234/README.md': '# next-fake\n\nA test repo.\n',
});

const root = buildHandleFromZip(zip, 'vercel-next.js-abc1234', 'vercel/next.js');

// 1. Root handle must look like a FileSystemDirectoryHandle.
if (root.kind !== 'directory') fail('root.kind must be "directory"');
if (root.name !== 'vercel/next.js') fail('root.name must be the display name');
if (typeof root.entries !== 'function') fail('root.entries must be an async iterator factory');
if (typeof root.getFileHandle !== 'function') fail('root.getFileHandle must exist (scanHandle calls it for .gitignore)');

// 2. Walk the tree depth-first and assert paths land where we expect.
async function collect(dir, prefix = '') {
  const out = [];
  for await (const [name, entry] of dir.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (entry.kind === 'directory') {
      out.push({ kind: 'dir', path });
      out.push(...await collect(entry, path));
    } else {
      out.push({ kind: 'file', path });
    }
  }
  return out;
}

const entries = await collect(root);
const files = entries.filter((e) => e.kind === 'file').map((e) => e.path).sort();
const dirs  = entries.filter((e) => e.kind === 'dir').map((e) => e.path).sort();

eq(files, ['README.md', 'package.json', 'src/index.ts', 'src/lib/util.ts'], 'files at correct relative paths');
if (!dirs.includes('src')) fail(`expected 'src' in dirs, got ${JSON.stringify(dirs)}`);
if (!dirs.includes('src/lib')) fail(`expected 'src/lib' in dirs, got ${JSON.stringify(dirs)}`);

// 3. getFileHandle returns a handle whose getFile() yields {size, lastModified, text()}.
const pkgEntry = (await collect(root)).find((e) => e.path === 'package.json');
if (!pkgEntry) fail('package.json not enumerated');

// Re-grab via getFileHandle (the path the scanner uses for .gitignore lookup)
const pkgHandle = await root.getFileHandle('package.json');
if (pkgHandle.kind !== 'file') fail('getFileHandle must return kind="file"');
const f = await pkgHandle.getFile();
if (typeof f.size !== 'number' || f.size <= 0) fail('file.size must be a positive number');
if (typeof f.lastModified !== 'number') fail('file.lastModified must be a number');
const txt = await f.text();
if (!txt.includes('"next-fake"')) fail('file.text() must return the original content');

// 4. Missing files throw NotFoundError (matches FileSystemDirectoryHandle behaviour
//    that scanHandle's .gitignore lookup catches).
let threw = false;
try { await root.getFileHandle('does-not-exist'); } catch (e) { threw = true; if (e?.name !== 'NotFoundError') fail('expected NotFoundError, got ' + e?.name); }
if (!threw) fail('getFileHandle must throw on missing file');

// 5. Binary file detection — null bytes in first 8 KB make text() return '\0'
//    so scanHandle skips it via the existing null-byte sniff.
const binZip = fakeZip({
  'r/': null,
  'r/logo.png': ' PNGbinary',
});
const binRoot = buildHandleFromZip(binZip, 'r', 'r');
const png = await binRoot.getFileHandle('logo.png');
const pngFile = await png.getFile();
const pngText = await pngFile.text();
if (!pngText.includes('\0')) fail('binary file text() must contain null byte to trigger scanHandle skip');

console.log('OK · 5 GitHub-adapter assertions pass');
console.log('  parseRepoSpec  : 9 cases');
console.log('  repoSpecKey    : 4 cases');
console.log('  zip → handle   :', files.length, 'files,', dirs.length, 'dirs');
console.log('  binary detect  : null-byte sentinel returned for non-text payloads');
