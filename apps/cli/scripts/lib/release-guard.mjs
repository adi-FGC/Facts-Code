/**
 * The release guard for an npm publish folder (deploy-infra#8). The same two
 * rules apps/mcp-server/scripts/assemble-publish.mjs applies to
 * `factstack-mcp` (publishManifest / releaseBlockers), written without that
 * package's paths so both bundles can share one copy once it moves to the
 * repo's scripts/lib (requested; this file is the CLI's until then):
 *
 *   - the folder's package.json carries `"private": true` unless the owner
 *     deliberately builds a release: npm refuses to publish a private
 *     package, so a stray `npm publish` in the folder cannot ship it;
 *   - a release is refused while the license is unsettled: package.json
 *     `"license"` missing or `UNLICENSED`, or no license text beside it.
 *
 * Build-time only (Node): nothing here ships in a bundle.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The package's own license text: LICENSE, LICENCE, LICENSE.md, LICENSE.txt. */
export const OWN_LICENSE_FILE = /^licen[cs]e(\.(md|txt))?$/i;

/** `dir`'s own license file name, or null until the owner adds one. */
export function ownLicenseFile(dir) {
  return (
    readdirSync(dir)
      .filter((f) => OWN_LICENSE_FILE.test(f) && statSync(join(dir, f)).isFile())
      .sort()[0] ?? null
  );
}

/**
 * Why a release build is refused; [] when it may go ahead. Pure. `label` is
 * the package directory as the owner sees it (e.g. `apps/cli`), for the text.
 */
export function releaseBlockers(pkg, licenseFile, label) {
  const out = [];
  if (!pkg.license || pkg.license === 'UNLICENSED') {
    out.push(
      `${label}/package.json "license" is ${pkg.license ?? 'missing'}: set the chosen SPDX id`,
    );
  }
  if (!licenseFile) out.push(`${label}/LICENSE is missing: add the license text`);
  return out;
}

/** The manifest fields that differ between a guarded folder and a release:
 *  `"private": true` until released, `publishConfig` only on a release. */
export function releaseFields(release) {
  return release ? { publishConfig: { access: 'public' } } : { private: true };
}
