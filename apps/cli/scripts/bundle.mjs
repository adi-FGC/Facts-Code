#!/usr/bin/env node
// Assemble the publishable `factstack` npm package (deploy-infra#7) in
// apps/cli/publish/ (gitignored). The workspace packages ship TypeScript
// sources (`main: ./src/index.ts`), so the tsc output in dist/ cannot run
// under plain Node; this bundles src/cli.ts and EVERY dependency (workspace
// and npm) with esbuild into one ESM file with a shebang:
//
//   publish/
//     package.json              name `factstack`, bin `factstack`, engines,
//                               license; "private": true unless --release
//     README.md                 apps/cli/README.md
//     THIRD_PARTY_LICENSES.md   every bundled npm package's license text
//                               (policy: scripts/lib/third-party-licenses.mjs
//                               at the repo root, shared with factstack-mcp)
//     LICENSE                   once the owner adds apps/cli/LICENSE
//     dist/cli.js               the bundle (#!/usr/bin/env node)
//     dist/ui/index.html        the hardened local UI (src/ui/index.html)
//     dist/vendor/babel-parser.mjs  served at /vendor/ by `factstack ui`
//     dist/xdg-open             `open`'s Linux fallback, where it looks for it
//
// No runtime `dependencies`: everything bundles (node:sqlite is a built-in,
// loaded lazily). It NEVER publishes — see PUBLISHING.md for the owner's steps.
//
// Release guard (deploy-infra#8, as factstack-mcp's assemble-publish.mjs):
// the folder keeps "private": true, so a stray `npm publish` in it is refused
// by npm. `--release` drops it, and is itself refused (nothing written) while
// apps/cli/package.json says UNLICENSED or apps/cli/LICENSE is missing.
//
// The build starts by deleting the out folder, so --out is guarded (R4): it
// may not be or contain apps/cli, the repo root or the cwd, and an existing
// folder must be empty or an earlier publish folder.
//
// Usage: node scripts/bundle.mjs [--out <dir>] [--release] [--pack-dry-run]

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundledPackages, thirdPartyMarkdown } from '../../../scripts/lib/third-party-licenses.mjs';
import { assertNoRemoteResources, bundleBabelParser } from './lib/build-ui.mjs';
import { ownLicenseFile, releaseBlockers, releaseFields } from './lib/release-guard.mjs';

/* The license policy both publish bundles share (mcp-3); re-exported for
   scripts/test/bundle-guard.test.ts. */
export { licenseTextFor } from '../../../scripts/lib/third-party-licenses.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const CLI_ROOT = resolve(here, '..');
export const REPO_ROOT = resolve(CLI_ROOT, '..', '..');
export const DEFAULT_OUT = resolve(CLI_ROOT, 'publish');
/** The name the owner reserves/publishes (@factstack/spec CLI_NPM_PACKAGE). */
export const PUBLISH_NAME = 'factstack';
/** What the package ships besides an owner-added LICENSE. */
export const PUBLISH_FILES = ['dist', 'README.md', 'THIRD_PARTY_LICENSES.md'];

/**
 * The published package.json, from apps/cli/package.json. Pure.
 * `"private": true` stays unless `release` (deploy-infra#8): an accidental
 * `npm publish` of the folder is refused until the owner deliberately builds
 * a release, which releaseBlockers gates on a settled license.
 *
 * @param {{ version?: string, license?: string, homepage?: string, engines?: { node?: string } }} cliPkg
 * @param {{ release?: boolean, licenseFile?: string | null }} [opts]
 * @returns {{ name: string, version: string | undefined, description: string, private?: true,
 *   license: string | undefined, type: 'module', bin: Record<string, string>,
 *   engines: { node: string }, files: string[], homepage: string | undefined,
 *   dependencies: Record<string, string>, publishConfig?: { access: string } }}
 */
export function publishManifest(cliPkg, { release = false, licenseFile = null } = {}) {
  const engines = cliPkg.engines?.node;
  if (!engines) throw new Error('apps/cli/package.json has no engines.node');
  return {
    name: PUBLISH_NAME,
    version: cliPkg.version,
    description:
      'FACTS — Fun AI Coding Tools. Analyze a codebase into an AI-agent-readable map (.facts/agent.pack) and a local dashboard. Offline analysis; Node >= 24.3.',
    ...(release ? {} : releaseFields(false)),
    // The owner settles the license before a release (PUBLISHING.md); until
    // then the repo's own field is carried over unchanged.
    license: cliPkg.license,
    type: 'module',
    bin: { [PUBLISH_NAME]: 'dist/cli.js' },
    engines: { node: engines },
    files: licenseFile ? [...PUBLISH_FILES, licenseFile] : PUBLISH_FILES,
    homepage: cliPkg.homepage,
    // Everything is bundled into dist/cli.js; nothing to install.
    dependencies: {},
    ...(release ? releaseFields(true) : {}),
  };
}

/** Why `--release` is refused for apps/cli; [] when it may go ahead. */
export const cliReleaseBlockers = (cliPkg, licenseFile) =>
  releaseBlockers(cliPkg, licenseFile, 'apps/cli');

const require = createRequire(import.meta.url);

/** `child` is `parent` or below it (case-insensitive on Windows). */
const isWithin = (child, parent) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
const real = (p) => (existsSync(p) ? realpathSync.native(p) : p);

/** Top-level names an earlier publish folder holds: what bundleCli writes,
 *  a LICENSE the owner adds, and the tarball `npm pack` leaves. */
const PUBLISH_ENTRY = new RegExp(
  `^(?:package\\.json|README\\.md|THIRD_PARTY_LICENSES\\.md|LICEN[CS]E(?:\\..+)?|dist|${PUBLISH_NAME}-.+\\.tgz)$`,
  'i',
);

/**
 * Throw unless `outDir` is safe to delete and rebuild (R4 — the build
 * starts with a recursive delete). It must not be or contain apps/cli, the
 * repo root or `cwd`; if it exists it must be a directory that is empty or
 * an earlier publish folder: package.json named `factstack` and nothing but
 * publish entries (a clone of this repo, also named `factstack`, has .git,
 * apps/, … and is refused).
 */
export function assertSafeOutDir(outDir, { cwd = process.cwd() } = {}) {
  const out = resolve(outDir);
  const protectedDirs = [
    ['apps/cli', CLI_ROOT],
    ['the repository root', REPO_ROOT],
    ['the current directory', resolve(cwd)],
  ];
  for (const [label, dir] of protectedDirs) {
    for (const [o, d] of [
      [out, dir],
      [real(out), real(dir)],
    ]) {
      if (isWithin(d, o)) {
        throw new Error(
          `refusing --out ${out}: it is or contains ${label} (${dir}), and the build deletes the out folder first`,
        );
      }
    }
  }
  if (!existsSync(out)) return;
  if (!statSync(out).isDirectory()) throw new Error(`refusing --out ${out}: not a directory`);
  const entries = readdirSync(out);
  if (entries.length === 0) return;
  let name = null;
  try {
    name = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8')).name ?? null;
  } catch {
    /* no or unreadable package.json: not a publish folder */
  }
  const strays = entries.filter((e) => !PUBLISH_ENTRY.test(e));
  if (name !== PUBLISH_NAME || strays.length > 0) {
    throw new Error(
      `refusing --out ${out}: it is not empty and not an earlier publish folder` +
        (strays.length > 0 ? ` (holds ${strays.slice(0, 5).join(', ')})` : '') +
        ' — pass a new or empty directory',
    );
  }
}

/**
 * Build the publish folder. Returns what was written (for the test and the
 * summary line). Throws on any failure — a half-built folder is removed.
 * `release` drops the `"private": true` guard; it is refused, before anything
 * is deleted or written, while the license is unsettled (deploy-infra#8).
 */
export async function bundleCli({ outDir = DEFAULT_OUT, release = false } = {}) {
  assertSafeOutDir(outDir); // before anything is deleted (R4)
  const cliPkg = JSON.parse(readFileSync(join(CLI_ROOT, 'package.json'), 'utf8'));
  const licenseFile = ownLicenseFile(CLI_ROOT);
  if (release) {
    const blockers = cliReleaseBlockers(cliPkg, licenseFile);
    if (blockers.length) {
      throw new Error(
        `refusing to bundle a release (nothing written):\n  - ${blockers.join('\n  - ')}\n` +
          'Settle the license first (PUBLISHING.md step 2).',
      );
    }
  }
  const manifest = publishManifest(cliPkg, { release, licenseFile }); // checks engines.node
  const { build } = await import('esbuild');

  rmSync(outDir, { recursive: true, force: true });
  const dist = join(outDir, 'dist');
  mkdirSync(join(dist, 'ui'), { recursive: true });
  mkdirSync(join(dist, 'vendor'), { recursive: true });
  try {
    const result = await build({
      entryPoints: [join(CLI_ROOT, 'src', 'cli.ts')],
      outfile: join(dist, 'cli.js'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      // CommonJS dependencies (commander, @babel/parser, …) call require();
      // an ESM bundle has none, so give them one. The entry's shebang stays
      // on line 1 (esbuild emits it ahead of the banner).
      banner: {
        js: "import { createRequire as __factstackCreateRequire } from 'node:module';\nconst require = __factstackCreateRequire(import.meta.url);",
      },
      legalComments: 'eof',
      metafile: true,
      logLevel: 'warning',
      absWorkingDir: CLI_ROOT,
    });
    const cliJs = join(dist, 'cli.js');
    const code = readFileSync(cliJs, 'utf8');
    if (!code.startsWith('#!/usr/bin/env node\n')) throw new Error('bundle lost its shebang');
    chmodSync(cliJs, 0o755);

    // Local UI: the committed, hardened template (legacy-ui's gate test pins
    // it to what sync-ui builds) + the vendored parser the ui server serves.
    // In the bundle, src/ui/embed.ts looks for vendor/ beside dist/cli.js.
    const template = readFileSync(join(CLI_ROOT, 'src', 'ui', 'index.html'), 'utf8');
    assertNoRemoteResources(template);
    writeFileSync(join(dist, 'ui', 'index.html'), template);
    writeFileSync(join(dist, 'vendor', 'babel-parser.mjs'), await bundleBabelParser());

    // `open` looks for its bundled xdg-open next to its own module file —
    // now dist/cli.js — before falling back to the system one.
    const xdg = join(dirname(require.resolve('open')), 'xdg-open');
    if (existsSync(xdg)) {
      copyFileSync(xdg, join(dist, 'xdg-open'));
      chmodSync(join(dist, 'xdg-open'), 0o755);
    }

    // Every inlined npm package's notice; a package with no text stops the build.
    const licenses = thirdPartyMarkdown(bundledPackages(result.metafile, CLI_ROOT), {
      bundleFile: 'dist/cli.js',
    });
    writeFileSync(join(outDir, 'THIRD_PARTY_LICENSES.md'), licenses.markdown);
    copyFileSync(join(CLI_ROOT, 'README.md'), join(outDir, 'README.md'));
    if (licenseFile) copyFileSync(join(CLI_ROOT, licenseFile), join(outDir, licenseFile));
    writeFileSync(join(outDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');

    return {
      outDir,
      manifest,
      bytes: Buffer.byteLength(code),
      bundled: licenses.packages,
      inputs: Object.keys(result.metafile.inputs).length,
    };
  } catch (err) {
    rmSync(outDir, { recursive: true, force: true });
    throw err;
  }
}

/** `npm pack --dry-run` in the publish folder — lists what would ship. */
export function packDryRun(outDir = DEFAULT_OUT) {
  const r = spawnSync('npm', ['pack', '--dry-run'], {
    cwd: outDir,
    stdio: 'inherit',
    // npm is npm.cmd on Windows; fixed arguments only.
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) throw new Error(`npm pack --dry-run exited ${r.status}`);
}

/* import.meta.main (Node >= 24.2; the floor is 24.3), never a URL compare
   with argv[1] (deploy-infra#7): Node realpaths the module URL but not
   argv[1], so run through a junction, symlink or subst'd path, `bundle` and
   `pack:dry-run` did nothing and exited 0 — and the owner then published an
   older publish/ folder. Same guard as apps/mcp-server/scripts/bundle.mjs. */
if (import.meta.main) {
  const args = process.argv.slice(2);
  const outAt = args.indexOf('--out');
  const outDir = outAt >= 0 && args[outAt + 1] ? resolve(args[outAt + 1]) : DEFAULT_OUT;
  try {
    const r = await bundleCli({ outDir, release: args.includes('--release') });
    const rel = relative(process.cwd(), r.outDir).split(sep).join('/') || '.';
    console.log(
      `[bundle] ${rel}/dist/cli.js ${(r.bytes / 1024).toFixed(0)} KB · ${r.inputs} inputs · ` +
        `${r.bundled.length} npm packages inlined · package ${PUBLISH_NAME} (not published)`,
    );
    if (r.manifest.private) {
      console.log(
        '[bundle] "private": true is set — npm refuses to publish it; --release drops it.',
      );
    }
    if (r.manifest.license === 'UNLICENSED') {
      console.log(
        '[bundle] license is UNLICENSED: the owner settles it before a release (PUBLISHING.md).',
      );
    }
    if (args.includes('--pack-dry-run')) packDryRun(outDir);
  } catch (err) {
    console.error('[bundle] failed:', err?.message ?? err);
    process.exit(1);
  }
}
