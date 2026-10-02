#!/usr/bin/env node
/**
 * Bundle the MCP server into ONE ESM file that plain `node` runs: src/server.ts
 * plus every @factstack/* workspace package it imports (they ship TypeScript
 * sources, which Node cannot load from node_modules) and their npm
 * dependencies. Node built-ins stay external.
 *
 *   node scripts/bundle.mjs              → dist/server.js
 *   node scripts/bundle.mjs <outfile>
 *
 * `bundle()` is exported for scripts/assemble-publish.mjs and the bundle test.
 * It never publishes anything.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { builtinModules } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENTRY = path.join(PKG_DIR, 'src', 'server.ts');
export const DEFAULT_OUTFILE = path.join(PKG_DIR, 'dist', 'server.js');

/**
 * npm packages kept OUT of the bundle and declared as runtime `dependencies`
 * of the published package instead: anything that loads files that sit next
 * to it at runtime (a .wasm, a native addon) and so cannot be inlined.
 * None today. tiktoken and web-tree-sitter are declared by workspace
 * packages, but nothing on the server's import path loads them; if that
 * changes, esbuild inlines their JS, the .wasm is missing at runtime, and the
 * bundle smoke (scripts/smoke-bundle.mjs) fails. List such a package here.
 */
export const RUNTIME_EXTERNALS = [];

const SHEBANG = '#!/usr/bin/env node';
/* CommonJS dependencies inlined into an ESM bundle still call `require()` for
   Node built-ins, and ESM has no `require`: give the bundle one. */
const REQUIRE_SHIM =
  "import { createRequire as __factsCreateRequire } from 'node:module';\n" +
  'const require = __factsCreateRequire(import.meta.url);';

const isBuiltin = (id) => id.startsWith('node:') || builtinModules.includes(id.split('/')[0]);

/* src/about.ts imports ../package.json for its version (the one version
   source). Inline only that field, not the workspace manifest (workspace:*
   dependencies, scripts, "private": true). */
const OWN_MANIFEST = path.join(PKG_DIR, 'package.json');
const versionOnlyManifest = {
  name: 'own-package-json-version-only',
  setup(b) {
    b.onLoad({ filter: /[\\/]package\.json$/ }, (args) =>
      path.resolve(args.path) === OWN_MANIFEST
        ? {
            contents: JSON.stringify({
              version: JSON.parse(readFileSync(OWN_MANIFEST, 'utf8')).version,
            }),
            loader: 'json',
          }
        : undefined,
    );
  },
};

/** `…/node_modules/@scope/name/lib/x.js` → `…/node_modules/@scope/name`. */
function packageDirOf(file) {
  const parts = file.split(/[\\/]/);
  const at = parts.lastIndexOf('node_modules');
  if (at < 0) return null;
  const n = parts[at + 1]?.startsWith('@') ? 3 : 2;
  return parts.slice(0, at + n).join('/');
}

/**
 * Build the bundle. Returns what went in: the npm packages inlined (for the
 * publish folder's third-party notices) and the bare imports left external.
 * Throws when anything but a Node built-in or a RUNTIME_EXTERNALS entry was
 * left external (it would be missing at runtime).
 */
export async function bundle({ outfile = DEFAULT_OUTFILE } = {}) {
  const { build } = await import('esbuild');
  const result = await build({
    entryPoints: [ENTRY],
    outfile,
    absWorkingDir: PKG_DIR,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: RUNTIME_EXTERNALS,
    plugins: [versionOnlyManifest],
    banner: { js: REQUIRE_SHIM },
    // Keep license comments (at the end of the file); readable, not minified.
    legalComments: 'eof',
    metafile: true,
    logLevel: 'warning',
  });

  /* Exactly one shebang, on line 1 (esbuild keeps the entry's own hashbang;
     where it lands relative to the banner is not ours to rely on). */
  const lines = readFileSync(outfile, 'utf8').split('\n');
  const body = lines.filter((l, i) => !(i < 5 && l.startsWith('#!')));
  writeFileSync(outfile, `${SHEBANG}\n${body.join('\n')}`);

  const out = Object.values(result.metafile.outputs)[0];
  const external = [...new Set(out.imports.filter((i) => i.external).map((i) => i.path))].sort();
  const unexpected = external.filter(
    (id) => !isBuiltin(id) && !RUNTIME_EXTERNALS.some((e) => id === e || id.startsWith(`${e}/`)),
  );
  if (unexpected.length) {
    throw new Error(`bundle left non-builtin imports external: ${unexpected.join(', ')}`);
  }

  const dirs = new Set();
  for (const input of Object.keys(result.metafile.inputs)) {
    const dir = packageDirOf(path.resolve(PKG_DIR, input));
    if (dir) dirs.add(dir);
  }
  const thirdParty = [...dirs]
    .map((dir) => {
      const pj = path.join(dir, 'package.json');
      const meta = existsSync(pj) ? JSON.parse(readFileSync(pj, 'utf8')) : {};
      return { name: meta.name, version: meta.version, license: meta.license ?? null, dir };
    })
    .filter((p) => p.name)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return {
    outfile,
    bytes: Buffer.byteLength(readFileSync(outfile)),
    inputs: Object.keys(result.metafile.inputs).length,
    external,
    thirdParty,
  };
}

/* import.meta.main (Node >= 24.2; the floor is 24.3), never a URL compare
   with argv[1]: Node realpaths the module URL but not argv[1], so a run
   through a symlink or junction did nothing and exited 0. */
if (import.meta.main) {
  const outfile = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_OUTFILE;
  const r = await bundle({ outfile });
  console.log(
    `bundled ${path.relative(process.cwd(), r.outfile)}: ${(r.bytes / 1024).toFixed(0)} KiB, ` +
      `${r.inputs} inputs, ${r.thirdParty.length} npm packages inlined, ` +
      `external: ${r.external.join(' ') || '(none)'}`,
  );
}
