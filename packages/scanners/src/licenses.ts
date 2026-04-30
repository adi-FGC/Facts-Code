/**
 * @factstack/scanners — license detection + GPL-in-proprietary flagging.
 *
 * Two signals:
 *   1. **SPDX declaration** — source files often begin with a license
 *      header (`// SPDX-License-Identifier: MIT`). Recognize and count.
 *   2. **Manifest declaration** — package.json `license` / Python
 *      pyproject.toml `license` / cargo Cargo.toml `license`.
 *
 * Output shape:
 *   - `fileLicenses: Map<path, spdxId>` — per-file headers
 *   - `projectLicense: spdxId | null` — the root project's manifest
 *   - `risks: LicenseRisk[]` — GPL/AGPL found while root license is
 *     permissive (MIT/Apache/BSD/ISC/etc.), or unknown.
 *
 * Pure-JS; stays isomorphic.
 */

export interface LicenseScanResult {
  projectLicense: string | null;
  fileLicenses: Map<string, string>;
  risks: LicenseRisk[];
}

export interface LicenseRisk {
  severity: 'info' | 'low' | 'medium' | 'high';
  /** Human-readable one-liner. */
  message: string;
  /** File triggering the finding, if any. */
  file?: string;
  /** SPDX identifier that triggered the finding. */
  license?: string;
}

/** Common SPDX ids we recognize. Non-exhaustive but covers the 99%. */
const SPDX_IDS = [
  'MIT', 'MIT-0', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC',
  'MPL-2.0', 'CC0-1.0', 'Unlicense', '0BSD', 'BlueOak-1.0.0',
  'GPL-2.0', 'GPL-2.0-only', 'GPL-2.0-or-later',
  'GPL-3.0', 'GPL-3.0-only', 'GPL-3.0-or-later',
  'LGPL-2.1', 'LGPL-2.1-only', 'LGPL-2.1-or-later',
  'LGPL-3.0', 'LGPL-3.0-only', 'LGPL-3.0-or-later',
  'AGPL-3.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later',
  'EUPL-1.2', 'Proprietary', 'UNLICENSED',
] as const;

const COPYLEFT = new Set([
  'GPL-2.0', 'GPL-2.0-only', 'GPL-2.0-or-later',
  'GPL-3.0', 'GPL-3.0-only', 'GPL-3.0-or-later',
  'LGPL-2.1', 'LGPL-2.1-only', 'LGPL-2.1-or-later',
  'LGPL-3.0', 'LGPL-3.0-only', 'LGPL-3.0-or-later',
  'AGPL-3.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later',
]);

const PERMISSIVE = new Set([
  'MIT', 'MIT-0', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC',
  'MPL-2.0', 'CC0-1.0', 'Unlicense', '0BSD', 'BlueOak-1.0.0',
]);

/** Extract the SPDX id from a file header (first 60 lines). */
export function scanFileLicense(source: string): string | null {
  const head = source.split('\n').slice(0, 60).join('\n');
  const m = /SPDX-License-Identifier:\s*([A-Za-z0-9.+\-]+)/i.exec(head);
  if (!m || !m[1]) return null;
  const id = m[1];
  return SPDX_IDS.find((s) => s.toLowerCase() === id.toLowerCase()) ?? id;
}

/** Read `license` from package.json content. Returns normalized SPDX id. */
export function scanManifestLicense(text: string, filename: string): string | null {
  try {
    if (filename === 'package.json') {
      const j = JSON.parse(text);
      if (typeof j.license === 'string') return j.license;
      // Legacy object form: `"license": { "type": "MIT", "url": "…" }`.
      if (typeof j.license?.type === 'string') return j.license.type;
    }
    if (filename === 'pyproject.toml') {
      const m = /^\s*license\s*=\s*(?:\{\s*text\s*=\s*)?['"]([^'"]+)['"]/im.exec(text);
      if (m && m[1]) return m[1];
    }
    if (filename === 'Cargo.toml') {
      const m = /^\s*license\s*=\s*['"]([^'"]+)['"]/im.exec(text);
      if (m && m[1]) return m[1];
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Given per-file SPDX ids and the root project license, flag copyleft
 * findings that conflict with a permissive project license (legal risk
 * for shipping a non-GPL product that silently absorbed GPL code).
 */
export function deriveLicenseRisks(
  projectLicense: string | null,
  fileLicenses: Map<string, string>,
): LicenseRisk[] {
  const risks: LicenseRisk[] = [];
  const projIsPermissive = projectLicense ? PERMISSIVE.has(projectLicense) : false;

  for (const [file, id] of fileLicenses) {
    if (COPYLEFT.has(id)) {
      if (projIsPermissive) {
        risks.push({
          severity: 'high',
          message: `${id} header in a ${projectLicense} project — copyleft may bind the whole distribution.`,
          file,
          license: id,
        });
      } else if (!projectLicense) {
        risks.push({
          severity: 'medium',
          message: `${id} header found; no project license declared.`,
          file,
          license: id,
        });
      }
    }
  }

  if (!projectLicense) {
    risks.push({
      severity: 'low',
      message: 'No project license declared. Add a "license" field to package.json (or a LICENSE file).',
    });
  } else if (projectLicense === 'UNLICENSED' || projectLicense === 'Proprietary') {
    // Intentional — not a risk by itself.
  }

  return risks;
}
