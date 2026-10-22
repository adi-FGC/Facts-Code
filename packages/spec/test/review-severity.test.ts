/**
 * vulnFindingSeverity — how an advisory's severity grades in the Change
 * Verdict. Audit correctness#8: an advisory whose OSV detail fetch failed is
 * stored id-only with severity 'unknown'. Grading that LOW let a new critical
 * CVE seen during a 429 / timeout pass `--fail-on medium` (the gate failed
 * open). An ungraded-by-OSV advisory must grade at least medium.
 */
import { describe, expect, it } from 'vitest';
import {
  rollupSeverity,
  secretClass,
  SEVERITY_RANK,
  splitSecrets,
  vulnFindingSeverity,
} from '../src/review-severity.js';
import type { ChangeFinding } from '../src/review.js';

describe('vulnFindingSeverity', () => {
  it.each([
    ['critical', 'critical'],
    ['high', 'high'],
    ['medium', 'medium'],
    ['low', 'low'],
  ] as const)('maps a known severity %s to %s', (sev, want) => {
    expect(vulnFindingSeverity(sev)).toBe(want);
  });

  it("grades 'unknown' (detail fetch failed) at least medium — never fails open", () => {
    expect(vulnFindingSeverity('unknown')).toBe('medium');
    expect(SEVERITY_RANK[vulnFindingSeverity('unknown')]).toBeGreaterThanOrEqual(
      SEVERITY_RANK.medium,
    );
  });

  it('grades an unrecognised severity string medium too (fail closed)', () => {
    for (const s of ['', 'UNKNOWN', 'moderate', 'bogus']) {
      expect(vulnFindingSeverity(s)).toBe('medium');
    }
  });

  it('an unknown-severity advisory trips a --fail-on medium rollup', () => {
    const finding: ChangeFinding = {
      kind: 'vulnerability',
      severity: vulnFindingSeverity('unknown'),
      title: 'Adds 1 new known vulnerability',
      detail: 'New advisories matched against dependency manifests: GHSA-x.',
    };
    expect(SEVERITY_RANK[rollupSeverity([finding])]).toBeGreaterThanOrEqual(SEVERITY_RANK.medium);
  });
});

/* The one secret-counting rule the CLI report, the dashboard and the verdict
   share (it used to live in the dashboard alone). */
describe('secretClass', () => {
  it('reads low as a fixture, info as a possible secret, anything else as exposed', () => {
    expect(secretClass({ severity: 'low' })).toBe('fixture');
    expect(secretClass({ severity: 'info' })).toBe('possible');
    for (const s of ['critical', 'high', 'medium'])
      expect(secretClass({ severity: s })).toBe('exposed');
  });

  it('splits only category secret, keeping order', () => {
    const r = (severity: string, category = 'secret', rule = severity) => ({
      severity,
      category,
      rule,
    });
    const out = splitSecrets([
      r('high', 'secret', 'a'),
      r('info'),
      r('high', 'todo'),
      r('low'),
      r('medium', 'secret', 'b'),
    ]);
    expect(out.exposed.map((x) => x.rule)).toEqual(['a', 'b']);
    expect(out.possible).toHaveLength(1);
    expect(out.fixture).toHaveLength(1);
  });
});
