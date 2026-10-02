/**
 * Every audit ID cited in the code resolves in docs/audit-ids.md.
 *
 * Regression (tech-debt#11): comments and test names cite findings by ID
 * (`security#3`, `CLI-13`, `SCN-P2-02`…), but the reports that define them
 * are local-only (docs/adversarial-review-* and the audit HTML are
 * gitignored), so a maintainer could not look up why the code is the way it
 * is. The index gives each ID a one-line meaning; this test fails when a new
 * citation lands without a row, and when an ID-shaped token belongs to no
 * known family (so a new family cannot slip past the row check, as `ART-7`,
 * `CG-R1` and `mcp-rev-2` once did). Scope: the source trees an audit sweep
 * covers (apps, packages, scripts, test, .github) plus the root config
 * files; generated output and the parked Chrome extension are skipped.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = readFileSync(join(ROOT, 'docs/audit-ids.md'), 'utf8').replace(/\r\n/g, '\n');

const DIRS = ['apps', 'packages', 'scripts', 'test', '.github'];
const ROOT_FILES = ['eslint.config.mjs', 'turbo.json', 'netlify.toml', 'package.json'];
const SKIP =
  /(^|\/)(node_modules|dist|publish|build|coverage|\.turbo|\.remix|test-results|playwright-report)(\/|$)|^apps\/chrome-ext\/|^apps\/cli\/src\/ui\/index\.html$|^apps\/ui-remix\/public\/data\//;
const EXT = /\.(ts|tsx|mts|mjs|js|cjs|yml|yaml|html|css|json|toml|sh)$/;

/* The ID families (see "How to read an ID" in the index). Case-sensitive:
   `cli-r3-1` and `CLI-13` are different passes. */
const AUDIT_ID = new RegExp(
  [
    String.raw`\b(?:correctness|security|performance|data-model|deploy-infra|ux|tech-debt)#\d+\b`,
    String.raw`\b(?:HUNT-CORE|EMIT-ADV|CLI|SCN|MCP|FSB|UI|SEC|DI|DET|EH|AE|CONC|RES|TC|PACK|OPD|XP|BFS|CORE|EMIT|ART|CG|SV)(?:-REV)?-(?:R|P)?\d{1,2}(?:-REV-\d{1,2}|-\d{2})?\b`,
    String.raw`\b(?:CVE-R\d|ISSUE-\d{1,2})\b`,
    String.raw`\b(?:legacy-ui-R\d{1,2}|mcp-r\d-adv-\d{1,2}|(?:cli|core|mcp)-(?:r\d|rev)-\d{1,2}|cli-R\d{1,2}|cli-dry-\d{1,2}|mcp-pkg-\d{1,2}|core-dup-\d{2}|(?:mcp|core)-\d{1,2})\b`,
  ].join('|'),
  'g',
);

/* Anything SHAPED like an audit ID, whatever its family: an upper-case code
   ending in a number (`ART-7`, `CG-R1`) or a lower-case review round
   (`x-rev-2`, `x-r3-1`, `x-adv-1`). A shape AUDIT_ID does not cover is a new
   family, so the row check above would silently skip it. */
const ID_SHAPE = new RegExp(
  [
    String.raw`\b[A-Z]{2,}(?:-[A-Z][A-Z0-9]*)*-[A-Z]?\d{1,2}\b(?![.\d]|-Clause)`,
    String.raw`\b[a-z]+(?:-[a-z0-9]+)*-(?:rev|adv|dry|pkg|dup|r\d)-\d{1,2}\b`,
  ].join('|'),
  'g',
);
/* ID-shaped tokens that are not audit IDs: advisory ids and fixtures
   (`CVE-1`, `GHSA-2`, `AAA-1`, `NEW-1`), SPDX licence ids (`AGPL-3`,
   `MIT-0`), model names (`GPT-6`) and `UTF-8`. */
const NOT_AUDIT =
  /^(?:CVE|GHSA|UTF|GPT|GLM|A?GPL|LGPL|MIT|MPL|BSD|BSL|BUSL|EUPL|NEW|OLD|([A-Z])\1\1)-/;

/* This file names IDs as examples; citations must come from somewhere else. */
const SELF = 'test/audit-ids.test.mjs';

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = relative(ROOT, abs).replace(/\\/g, '/');
    if (SKIP.test(rel)) continue;
    if (statSync(abs).isDirectory()) yield* walk(abs);
    else if (EXT.test(name)) yield rel;
  }
}

const scanned = () =>
  [...DIRS.flatMap((d) => [...walk(join(ROOT, d))]), ...ROOT_FILES].filter((f) => f !== SELF);

/** id → the first file that cites it. */
function citedIds() {
  const ids = new Map();
  for (const f of scanned()) {
    for (const m of readFileSync(join(ROOT, f), 'utf8').matchAll(AUDIT_ID))
      if (!ids.has(m[0])) ids.set(m[0], f);
  }
  return ids;
}

/** ID-shaped tokens outside every AUDIT_ID family → the first file with one. */
function unknownFamilies(text, file, out = new Map()) {
  const known = [...text.matchAll(AUDIT_ID)].map((m) => [m.index, m.index + m[0].length]);
  for (const m of text.matchAll(ID_SHAPE)) {
    if (NOT_AUDIT.test(m[0]) || known.some(([a, b]) => m.index >= a && m.index < b)) continue;
    if (!out.has(m[0])) out.set(m[0], file);
  }
  return out;
}

/* Index rows: "| `ID` | meaning | where |" (Prettier pads the cells). */
const ROW = /^\|\s*`([^`]+)`\s*\|/;
const rows = INDEX.split('\n').filter((l) => ROW.test(l));
const indexed = new Set(rows.map((l) => l.match(ROW)[1]));

describe('docs/audit-ids.md', () => {
  const cited = citedIds();

  it('finds the citations (guards the check below against going vacuous)', () => {
    expect(cited.size).toBeGreaterThan(150);
    /* One ID per family, each cited outside this file (SELF is not scanned). */
    for (const id of [
      'security#3',
      'CLI-13',
      'SCN-P2-02',
      'HUNT-CORE-05',
      'cli-r3-2',
      'mcp-rev-2',
      'ART-7',
      'ISSUE-2',
      'CG-R1',
      'SV-3',
    ])
      expect(cited.has(id), id).toBe(true);
  });

  it('knows every ID family the code cites (a new family would skip the row check)', () => {
    const unknown = new Map();
    for (const f of scanned()) unknownFamilies(readFileSync(join(ROOT, f), 'utf8'), f, unknown);
    expect(
      [...unknown].map(([id, f]) => `${id} (in ${f})`),
      'extend AUDIT_ID (and add rows), or list a non-audit prefix in NOT_AUDIT',
    ).toEqual([]);
  });

  it('the family check flags a new family and skips licence and advisory ids', () => {
    const found = [
      ...unknownFamilies(
        '/* QA-R2 and zz-rev-3; not GPL-3.0, MIT-0, CVE-1, UTF-8, BSD-2-Clause or CLI-13 */',
        'x.ts',
      ).keys(),
    ];
    expect(found).toEqual(['QA-R2', 'zz-rev-3']);
  });

  it('has a row for every audit ID cited in the code', () => {
    const missing = [...cited]
      .filter(([id]) => !indexed.has(id))
      .map(([id, f]) => `${id} (cited in ${f})`);
    expect(missing, 'add a one-line row to docs/audit-ids.md for each').toEqual([]);
  });

  /* The index is public. Until the owner claims the npx launch names, rows
     cite the owner decision instead of spelling out that anyone could
     register them, and describe fixed publish gates as they are now. */
  it('words the open npx-launch findings neutrally', () => {
    expect(INDEX).not.toMatch(/\bunclaimed\b|\bsquat|\bnot on npm\b[^"]/i);
    expect(INDEX).not.toMatch(/publishes with no sign-in/i);
  });

  it('gives every row a meaning', () => {
    expect(rows.length).toBeGreaterThan(150);
    for (const r of rows) expect(r.split('|')[2]?.trim().length ?? 0, r).toBeGreaterThan(10);
  });

  it('points only at files that exist', () => {
    for (const r of rows) {
      const where = [...(r.split('|')[3] ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1]);
      expect(where.length, r).toBeGreaterThan(0);
      for (const p of where.filter((w) => !w.includes('*')))
        expect(existsSync(join(ROOT, p)), `${r.split('|')[1].trim()}: ${p}`).toBe(true);
    }
  });
});
