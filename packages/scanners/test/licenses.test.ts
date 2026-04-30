import { describe, expect, it } from 'vitest';
import {
  deriveLicenseRisks,
  scanFileLicense,
  scanManifestLicense,
} from '../src/licenses.js';

describe('scanFileLicense', () => {
  it('reads SPDX headers', () => {
    expect(scanFileLicense('// SPDX-License-Identifier: MIT\nexport const x = 1;')).toBe('MIT');
    expect(scanFileLicense('# SPDX-License-Identifier: Apache-2.0\nfoo = 1')).toBe('Apache-2.0');
  });
  it('returns null when absent', () => {
    expect(scanFileLicense('export const x = 1;')).toBeNull();
  });
});

describe('scanManifestLicense', () => {
  it('reads string license from package.json', () => {
    expect(scanManifestLicense('{"license":"MIT"}', 'package.json')).toBe('MIT');
  });
  it('reads legacy object form', () => {
    expect(scanManifestLicense('{"license":{"type":"ISC"}}', 'package.json')).toBe('ISC');
  });
  it('reads pyproject.toml', () => {
    expect(scanManifestLicense('license = "Apache-2.0"', 'pyproject.toml')).toBe('Apache-2.0');
  });
});

describe('deriveLicenseRisks', () => {
  it('flags GPL in an MIT project', () => {
    const fileLic = new Map([['src/bad.ts', 'GPL-3.0-only']]);
    const risks = deriveLicenseRisks('MIT', fileLic);
    expect(risks[0]?.severity).toBe('high');
    expect(risks[0]?.file).toBe('src/bad.ts');
  });
  it('flags missing license', () => {
    const risks = deriveLicenseRisks(null, new Map());
    expect(risks.some((r) => r.message.includes('No project license'))).toBe(true);
  });
});
