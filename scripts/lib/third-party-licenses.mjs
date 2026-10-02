/**
 * The third-party license policy for every single-file npm bundle this repo
 * assembles: apps/cli/scripts/bundle.mjs (`factstack`,
 * THIRD_PARTY_LICENSES.md) and apps/mcp-server/scripts/assemble-publish.mjs
 * (`factstack-mcp`, THIRD_PARTY_NOTICES.md). Both import this module, so the
 * two publish paths cannot drift apart again (mcp-3):
 *
 *   - which file holds a package's notice (LICENSE_FILE: LICENSE, LICENCE.md,
 *     LICENSE-MIT, COPYING, …; files only, the sorted first pick);
 *   - a package that ships none gets the standard text for its SPDX id with
 *     the holder from package.json (MIT, ISC), marked as generated;
 *   - anything else stops the build (licenseTextFor throws), so a bundle is
 *     never assembled without one of its notices;
 *   - one markdown layout (thirdPartyMarkdown).
 *
 * Build-time only (Node): nothing here ships in a bundle.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** LICENSE, LICENCE.md, LICENSE-MIT (ignore@6), COPYING, … */
export const LICENSE_FILE = /^(?:licen[cs]e|copying)(?:[-._].*)?$/i;

/* Standard texts for the SPDX ids we can regenerate when a package ships no
   license file (R10): MIT and ISC require the copyright + permission notice
   to travel with every copy, so a bare "MIT" is not enough. */
export const LICENSE_TEXT = {
  MIT: (holder) =>
    `MIT License\n\nCopyright (c) ${holder}\n\n` +
    'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\n' +
    'The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\n' +
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
  ISC: (holder) =>
    `ISC License\n\nCopyright (c) ${holder}\n\n` +
    'Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.\n\n' +
    'THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.',
};

/** The copyright holder a package.json names (`author` string or object). */
export function holderOf(pkg) {
  const a = pkg.author;
  const name = typeof a === 'string' ? a.replace(/\s*[<(].*$/, '').trim() : a?.name;
  return name || `the ${pkg.name} authors`;
}

/** Nearest package.json with a `name` at or above `dir` (its package root). */
export function packageRootAt(dir) {
  for (let at = dir; ;) {
    const pj = join(at, 'package.json');
    if (existsSync(pj)) {
      try {
        const pkg = JSON.parse(readFileSync(pj, 'utf8'));
        if (pkg.name) return { dir: at, pkg };
      } catch {
        /* keep walking */
      }
    }
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/** The package root of one bundled input file. */
export const packageRootOf = (file) => packageRootAt(dirname(file));

/**
 * Every npm package an esbuild metafile says was inlined, as `{ dir, pkg }`,
 * once per name@version, sorted by name then version (code-point order, so
 * the notices file is the same on every machine). `absWorkingDir` is the
 * build's, which the metafile's input paths are relative to.
 */
export function bundledPackages(metafile, absWorkingDir) {
  return uniqueSorted(
    Object.keys(metafile.inputs)
      .filter((input) => input.includes('node_modules'))
      .map((input) => packageRootOf(resolve(absWorkingDir, input)))
      .filter(Boolean),
  );
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** Once per name@version (the first one seen), sorted by name then version. */
function uniqueSorted(packages) {
  const seen = new Map();
  for (const p of packages) {
    const key = `${p.pkg.name}@${p.pkg.version}`;
    if (!seen.has(key)) seen.set(key, p);
  }
  return [...seen.values()].sort(
    (a, b) => cmp(a.pkg.name, b.pkg.name) || cmp(String(a.pkg.version), String(b.pkg.version)),
  );
}

/**
 * The license text for one bundled package: its own license file, or —
 * when it ships none — the standard text for its SPDX id with the holder
 * from package.json (`generated: true`). Throws for a package with neither,
 * so the build fails instead of shipping a copy without its notice.
 */
export function licenseTextFor({ dir, pkg }) {
  const file = readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f) && statSync(join(dir, f)).isFile())
    .sort()[0];
  if (file) return { text: readFileSync(join(dir, file), 'utf8').trim(), generated: false };
  const make = typeof pkg.license === 'string' ? LICENSE_TEXT[pkg.license] : undefined;
  if (make) return { text: make(holderOf(pkg)), generated: true };
  throw new Error(
    `${pkg.name}@${pkg.version} ships no license file and its license (${JSON.stringify(pkg.license ?? null)}) has no standard text here — add it to LICENSE_TEXT in scripts/lib/third-party-licenses.mjs after checking the package`,
  );
}

/**
 * The third-party license file shipped beside `bundleFile` (e.g.
 * `dist/cli.js`): one `## name@version — license` section per package, each
 * holding its text in a ```text block. Throws (licenseTextFor) before
 * returning anything when a package has no text. `packages` is
 * `{ dir, pkg }[]`; duplicates by name@version are listed once.
 */
export function thirdPartyMarkdown(packages, { bundleFile }) {
  const entries = uniqueSorted(packages);
  const lines = [
    '# Third-party licenses',
    '',
    `\`${bundleFile}\` is a single-file bundle. Besides FACTS's own code, it contains the npm`,
    'packages below, under their own licenses.',
    '',
  ];
  for (const e of entries) {
    const { text, generated } = licenseTextFor(e);
    const license = typeof e.pkg.license === 'string' ? e.pkg.license : '(see text)';
    lines.push(`## ${e.pkg.name}@${e.pkg.version} — ${license}`, '');
    if (generated) {
      lines.push(
        '_The package ships no license file; this is the standard text for its license, with the copyright holder from its package.json._',
        '',
      );
    }
    lines.push('```text\n' + text + '\n```', '');
  }
  return {
    markdown: lines.join('\n'),
    packages: entries.map((e) => `${e.pkg.name}@${e.pkg.version}`),
  };
}
