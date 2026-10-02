/**
 * The C1/C2 boundary gate (eslint.config.mjs) must be able to FAIL.
 *
 * `pnpm lint:boundaries` on a clean tree proves only that the tree is clean.
 * These probes lint virtual files (nothing is written) at real package paths
 * and assert each known-bad import is reported and each known-good one is
 * not. The config header records that an earlier gate "looked configured but
 * could not fail"; this is the regression test for that, and for the
 * dynamic import() / require() / relative-path bypasses found 2026-09-24.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BOUNDARY_RULES = new Set(['no-restricted-imports', 'factstack/no-boundary-bypass']);

let eslint;
beforeAll(() => {
  eslint = new ESLint({ cwd: ROOT });
});

async function boundaryErrors(filePath, code) {
  const [res] = await eslint.lintText(code, { filePath: join(ROOT, filePath) });
  return res.messages.filter((m) => m.severity === 2 && BOUNDARY_RULES.has(m.ruleId));
}

const BAD = [
  [
    'C2 spec → core',
    'packages/spec/src/boundary-probe.ts',
    "import { analyze } from '@factstack/core';\nexport { analyze };",
  ],
  [
    'C1 core → node:fs',
    'packages/core/src/boundary-probe.ts',
    "import fs from 'node:fs';\nexport { fs };",
  ],
  [
    'C1 bare builtin',
    'packages/graph/src/boundary-probe.ts',
    "import path from 'path';\nexport { path };",
  ],
  [
    'C2 core → emit',
    'packages/core/src/boundary-probe.ts',
    "import { x } from '@factstack/emit';\nexport { x };",
  ],
  [
    'C1 core test → node:zlib',
    'packages/core/test/boundary-probe.test.ts',
    "import zlib from 'node:zlib';\nexport { zlib };",
  ],
  [
    'C2 walker → core',
    'packages/walker/src/boundary-probe.ts',
    "import { analyze } from '@factstack/core';\nexport { analyze };",
  ],
  [
    'C2 ui-remix → fs-node',
    'apps/ui-remix/src/boundary-probe.ts',
    "import { NodeFS } from '@factstack/fs-node';\nexport { NodeFS };",
  ],
  [
    'C1 ui-remix src → node:path',
    'apps/ui-remix/src/boundary-probe.ts',
    "import path from 'node:path';\nexport { path };",
  ],
  ['C2 re-export', 'packages/core/src/boundary-probe.ts', "export { x } from '@factstack/emit';"],
  [
    'C2 type-only import',
    'packages/core/src/boundary-probe.ts',
    "import type { X } from '@factstack/emit';\nexport type { X };",
  ],
  [
    'C2 disallowed subpath',
    'packages/core/src/boundary-probe.ts',
    "import x from '@factstack/fs-node/sub';\nexport { x };",
  ],
  [
    'C2 dynamic import()',
    'packages/spec/src/boundary-probe.ts',
    "export const m = await import('@factstack/core');",
  ],
  [
    'C2 dynamic import() in the browser app',
    'apps/ui-remix/src/boundary-probe.ts',
    "export const m = await import('@factstack/fs-node');",
  ],
  ['C1 require()', 'packages/core/src/boundary-probe.ts', "export const fs = require('node:fs');"],
  [
    'C1 process.getBuiltinModule()',
    'packages/core/src/boundary-probe.ts',
    "export const fs = process.getBuiltinModule('fs');",
  ],
  [
    'C1 template-literal import()',
    'packages/skills/src/boundary-probe.ts',
    'export const fs = await import(`node:fs`);',
  ],
  [
    'C2 relative cross-package import',
    'packages/spec/src/boundary-probe.ts',
    "import { analyze } from '../../core/src/index.js';\nexport { analyze };",
  ],
  [
    'C2 relative cross-package require()',
    'packages/walker/test/boundary-probe.test.ts',
    "export const c = require('../../core/src/index.js');",
  ],
  /* The real file once had a per-file exemption for exactly this import; it
     outlived the fix and would have re-allowed it silently. */
  [
    'C2 relative cross-package import in fs-node/test/bom.test.ts (no exemption)',
    'packages/fs-node/test/bom.test.ts',
    "import { MemoryFS } from '../../fs-memory/src/index.js';\nexport { MemoryFS };",
  ],
];

const GOOD = [
  [
    'core → graph (declared)',
    'packages/core/src/boundary-probe.ts',
    "import { g } from '@factstack/graph';\nexport { g };",
  ],
  [
    'core → spec subpath (declared)',
    'packages/core/src/boundary-probe.ts',
    "import { ROUTE_CATALOG } from '@factstack/spec/routes';\nexport { ROUTE_CATALOG };",
  ],
  [
    'emit → node:fs (Node tier)',
    'packages/emit/src/boundary-probe.ts',
    "import fs from 'node:fs';\nexport { fs };",
  ],
  [
    'factspack test → node:crypto',
    'packages/factspack/test/boundary-probe.test.ts',
    "import { createHash } from 'node:crypto';\nexport { createHash };",
  ],
  [
    'ui-remix lazy-loads a declared package',
    'apps/ui-remix/src/boundary-probe.ts',
    "export const m = await import('@factstack/core');",
  ],
  [
    'ui-remix lazy-loads its own route',
    'apps/ui-remix/src/boundary-probe.ts',
    "export const r = await import('./routes/About.tsx');",
  ],
  [
    'relative import inside the package',
    'packages/core/test/boundary-probe.test.ts',
    "import { analyze } from '../src/index.js';\nexport { analyze };",
  ],
  [
    'non-literal specifier is not guessed at',
    'packages/core/src/boundary-probe.ts',
    'export const load = (s: string) => import(s);',
  ],
];

describe('C1/C2 boundary gate fails on every known bypass', () => {
  it.each(BAD)('%s', async (_name, file, code) => {
    expect((await boundaryErrors(file, code)).length).toBeGreaterThan(0);
  });
});

describe('C1/C2 boundary gate allows what the manifests declare', () => {
  it.each(GOOD)('%s', async (_name, file, code) => {
    expect(await boundaryErrors(file, code)).toEqual([]);
  });
});
