#!/usr/bin/env node
/**
 * Assemble apps/mcp-server/publish/ (gitignored): the folder the OWNER
 * publishes to npm as `factstack-mcp`. See PUBLISHING.md. This script never
 * publishes anything.
 *
 *   node scripts/assemble-publish.mjs              → publish/, "private": true kept
 *   node scripts/assemble-publish.mjs --release    → publish/, without the guard
 *                                                    (refused until a license is set)
 *   node scripts/assemble-publish.mjs --out <dir>  → another folder
 *
 * The folder holds only what the package needs:
 *   package.json             name + bin factstack-mcp, engines node >=24.3
 *   dist/server.js           the single-file bundle (scripts/bundle.mjs)
 *   README.md                apps/mcp-server/README.md minus its repo-only parts
 *   THIRD_PARTY_NOTICES.md   licenses of the npm code inlined in the bundle
 *                            (policy: scripts/lib/third-party-licenses.mjs at
 *                            the repo root, shared with the `factstack` CLI)
 *   LICENSE                  once the owner adds apps/mcp-server/LICENSE
 *
 * The last line printed is `assemble ok`; no output means it did not run.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { thirdPartyMarkdown } from '../../../scripts/lib/third-party-licenses.mjs';
import { bundle, PKG_DIR, RUNTIME_EXTERNALS } from './bundle.mjs';

/* The license policy both publish bundles share (mcp-3); re-exported for
   test/publish-scripts.test.ts. */
export { licenseTextFor } from '../../../scripts/lib/third-party-licenses.mjs';

/** Must equal MCP_NPM_PACKAGE in @factstack/spec (a test checks it): this
 *  script runs on plain Node, which cannot import the TypeScript spec. */
export const PUBLISH_NAME = 'factstack-mcp';
export const PUBLISH_DIR = path.join(PKG_DIR, 'publish');
export const BIN_PATH = 'dist/server.js';
/** The CLI's Node floor, everywhere (owner decision 2026-09-24). */
export const NODE_ENGINE = '>=24.3.0';
export const PUBLISH_FILES = [BIN_PATH, 'README.md', 'THIRD_PARTY_NOTICES.md'];

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** The version range a workspace package.json declares for `name`. */
function declaredRange(name) {
  const dirs = [
    PKG_DIR,
    ...readdirSync(path.join(PKG_DIR, '..', '..', 'packages')).map((d) =>
      path.join(PKG_DIR, '..', '..', 'packages', d),
    ),
  ];
  for (const dir of dirs) {
    const pj = path.join(dir, 'package.json');
    if (!existsSync(pj)) continue;
    const range = readJson(pj).dependencies?.[name];
    if (range && !range.startsWith('workspace:')) return range;
  }
  throw new Error(`RUNTIME_EXTERNALS lists ${name}, but no workspace package declares it`);
}

/**
 * The published package.json, from apps/mcp-server/package.json. Pure.
 * `private: true` stays unless `release`: an accidental `npm publish` of the
 * folder is refused until the owner deliberately assembles a release.
 */
export function publishManifest(
  pkg,
  { release = false, dependencies = {}, licenseFile = null } = {},
) {
  return {
    name: PUBLISH_NAME,
    version: pkg.version,
    description:
      'FACTS Model Context Protocol server (stdio): gives AI coding agents a codebase analysis ' +
      '(dependency graph, routes, risks, CVEs, token costs) as MCP tools and resources.',
    ...(release ? {} : { private: true }),
    license: pkg.license,
    type: 'module',
    bin: { [PUBLISH_NAME]: BIN_PATH },
    files: licenseFile ? [...PUBLISH_FILES, licenseFile] : PUBLISH_FILES,
    engines: { node: NODE_ENGINE },
    ...(pkg.homepage ? { homepage: pkg.homepage } : {}),
    ...(Object.keys(dependencies).length ? { dependencies } : {}),
  };
}

/**
 * Why a `--release` assemble is refused; [] when it may go ahead. Pure.
 * A release drops the `private` guard, so the license must be settled first
 * (PUBLISHING.md step 2): a real SPDX id in package.json AND the text in
 * apps/mcp-server/LICENSE.
 */
export function releaseBlockers(pkg, licenseFile) {
  const out = [];
  if (!pkg.license || pkg.license === 'UNLICENSED') {
    out.push(
      `apps/mcp-server/package.json "license" is ${pkg.license ?? 'missing'}: set the chosen SPDX id`,
    );
  }
  if (!licenseFile) out.push('apps/mcp-server/LICENSE is missing: add the license text');
  return out;
}

/** apps/mcp-server's own license file, once the owner adds one (PUBLISHING.md). */
export function ownLicenseFile() {
  return readdirSync(PKG_DIR).find((f) => /^licen[cs]e(\.(md|txt))?$/i.test(f)) ?? null;
}

const REPO_ONLY = /<!-- repo-only:start -->[\s\S]*?<!-- repo-only:end -->\n?/g;
const NPM_ONLY = /<!-- npm-only:start\n([\s\S]*?)npm-only:end -->\n?/g;

/**
 * The README the npm package ships, from apps/mcp-server/README.md. Pure.
 * `<!-- repo-only:start --> … <!-- repo-only:end -->` blocks (clone commands,
 * PUBLISHING.md, source layout) are dropped; `<!-- npm-only:start … npm-only:end -->`
 * comments (the npx commands) are unwrapped. npmjs.com shows neither the
 * repo's relative links nor its source tree, so neither may leak into it.
 */
export function npmReadme(src) {
  const out = src
    .replace(/\r\n/g, '\n') // a Windows checkout (core.autocrlf) must not hide a marker
    .replace(REPO_ONLY, '')
    .replace(NPM_ONLY, (_, body) => body)
    .replace(/\n{3,}/g, '\n\n');
  if (/(repo|npm)-only:(start|end)/.test(out)) {
    throw new Error('README.md: an unbalanced repo-only / npm-only marker');
  }
  return out;
}

/**
 * THIRD_PARTY_NOTICES.md for a bundle() result's thirdParty entries
 * (`{ name, version, license, dir }`), through the shared policy: a
 * package's own license file, else the generated MIT / ISC text with the
 * holder from its package.json, else a throw that stops the assemble. Each
 * package's own package.json is read for that (the entry's fields stand in
 * when a dir has none).
 */
export function notices(thirdParty) {
  const packages = thirdParty.map((p) => {
    const pj = path.join(p.dir, 'package.json');
    return { dir: p.dir, pkg: existsSync(pj) ? readJson(pj) : p };
  });
  return thirdPartyMarkdown(packages, { bundleFile: BIN_PATH }).markdown;
}

/**
 * Build publish/ from scratch. Returns the manifest and what went in. On any
 * failure the half-built folder is removed: it never holds a package.json
 * without its THIRD_PARTY_NOTICES.md. `bundler` is scripts/bundle.mjs's
 * bundle() (a test seam).
 */
export async function assemble({ outDir = PUBLISH_DIR, release = false, bundler = bundle } = {}) {
  /* package.json `version` is the one version: src/about.ts imports it, so
     --version, serverInfo and the published manifest cannot disagree. */
  const pkg = readJson(path.join(PKG_DIR, 'package.json'));
  const licenseFile = ownLicenseFile();
  if (release) {
    const blockers = releaseBlockers(pkg, licenseFile);
    if (blockers.length) {
      throw new Error(
        `refusing to assemble a release (nothing written):\n  - ${blockers.join('\n  - ')}\n` +
          'Settle the license first (PUBLISHING.md step 2).',
      );
    }
  }
  const readme = npmReadme(readFileSync(path.join(PKG_DIR, 'README.md'), 'utf8'));
  /* Only ever wipe an empty folder or one this script made. */
  if (existsSync(outDir) && readdirSync(outDir).length) {
    const prev = path.join(outDir, 'package.json');
    if (!existsSync(prev) || readJson(prev).name !== PUBLISH_NAME) {
      throw new Error(`${outDir} is not empty and was not assembled by this script`);
    }
    rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(path.join(outDir, path.dirname(BIN_PATH)), { recursive: true });

  try {
    const built = await bundler({ outfile: path.join(outDir, BIN_PATH) });
    // Before package.json: a package with no license text stops the build here.
    const thirdPartyNotices = notices(built.thirdParty);
    const dependencies = Object.fromEntries(RUNTIME_EXTERNALS.map((n) => [n, declaredRange(n)]));
    if (licenseFile) copyFileSync(path.join(PKG_DIR, licenseFile), path.join(outDir, licenseFile));
    const manifest = publishManifest(pkg, { release, dependencies, licenseFile });
    writeFileSync(path.join(outDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(path.join(outDir, 'README.md'), readme);
    writeFileSync(path.join(outDir, 'THIRD_PARTY_NOTICES.md'), thirdPartyNotices);
    return { outDir, manifest, bundle: built };
  } catch (err) {
    /* Empty or ours (checked above): a half-built folder must not be left
       for `npm publish`, nor refused by the next run as foreign. */
    rmSync(outDir, { recursive: true, force: true });
    throw err;
  }
}

/* import.meta.main, not an argv[1] URL compare (see scripts/bundle.mjs). */
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--out');
  const outDir = at >= 0 && argv[at + 1] ? path.resolve(argv[at + 1]) : PUBLISH_DIR;
  const r = await assemble({ outDir, release: argv.includes('--release') });
  const kib = (r.bundle.bytes / 1024).toFixed(0);
  console.log(`assembled ${r.outDir}`);
  console.log(`  ${r.manifest.name}@${r.manifest.version}  bin ${BIN_PATH} (${kib} KiB)`);
  console.log(`  inlined: ${r.bundle.thirdParty.map((p) => `${p.name}@${p.version}`).join(', ')}`);
  console.log(
    `  runtime dependencies: ${Object.keys(r.manifest.dependencies ?? {}).join(', ') || 'none'}`,
  );
  if (r.manifest.private) console.log('  "private": true is set; pass --release to drop it.');
  if (r.manifest.license === 'UNLICENSED') {
    console.log(
      '  license is UNLICENSED: the owner must settle it before publishing (PUBLISHING.md).',
    );
  }
  console.log('Nothing was published. Next: node scripts/smoke-bundle.mjs --pack');
  console.log('assemble ok');
}
