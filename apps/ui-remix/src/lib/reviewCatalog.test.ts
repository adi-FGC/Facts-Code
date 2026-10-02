/**
 * The review catalog is shown to users as measured fact. These checks keep a
 * row from quietly becoming unverifiable: every row needs a public source, a
 * measurement date, and pass rules that can actually be applied.
 */
import { describe, expect, it } from 'vitest';
import { MODEL_CATALOG } from './modelCatalog.ts';
import { REVIEW_CATALOG } from './reviewCatalog.ts';
import { reviewFloor } from './reviewFloor.ts';

describe('REVIEW_CATALOG', () => {
  it('has unique ids and a public https source on every row', () => {
    const ids = REVIEW_CATALOG.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of REVIEW_CATALOG) {
      expect(s.sourceUrl, s.id).toMatch(/^https:\/\/(github\.com|code\.claude\.com)\//);
      expect(s.measuredOn, s.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('never carries a local path or user name in text users read', () => {
    for (const s of REVIEW_CATALOG) {
      const text = [s.label, s.maker, s.version, s.readers, s.notes, s.sourceUrl].join(' ');
      expect(text, s.id).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\/|~\//);
    }
  });

  it('prices every row: a measured row must produce a floor', () => {
    for (const s of REVIEW_CATALOG) {
      if (s.instructionChars !== null && s.codeReadPasses !== null) {
        expect(reviewFloor(s, at(10)), s.id).not.toBeNull();
      }
    }
  });

  it('names a model id that exists when a row is model-specific', () => {
    const ids = new Set(MODEL_CATALOG.map((m) => m.id));
    for (const s of REVIEW_CATALOG) {
      if (s.measuredOnModel) expect(ids.has(s.measuredOnModel), s.id).toBe(true);
    }
  });

  it('keeps tiers applicable: positive thresholds and additions', () => {
    for (const s of REVIEW_CATALOG) {
      for (const t of s.tiers ?? []) {
        expect(t.minLines, s.id).toBeGreaterThan(0);
        expect(Number.isInteger(t.addPasses) && t.addPasses > 0, s.id).toBe(true);
        expect(t.addInstructionChars, s.id).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('applies gstack’s size rules as its own text states them', () => {
    const g = REVIEW_CATALOG.find((s) => s.id === 'gstack-review')!;
    expect(reviewFloor(g, at(49))!.passes).toBe(2); // "If DIFF_LINES < 50: Skip all specialists"
    expect(reviewFloor(g, at(50))!.passes).toBe(4); // Testing + Maintainability, always-on at 50+
    expect(reviewFloor(g, at(200))!.passes).toBe(4); // red team: "Only if DIFF_LINES > 200"
    expect(reviewFloor(g, at(201))!.passes).toBe(5);
  });

  it('charges gstack’s adversarial reviewer the non-test code only', () => {
    const g = REVIEW_CATALOG.find((s) => s.id === 'gstack-review')!;
    const f = reviewFloor(g, { tokens: 1_000, nonTestTokens: 600, lines: 10 })!;
    expect(f.codeTokens).toBe(1_600);
  });
});

function at(lines: number) {
  return { tokens: 1_000, nonTestTokens: 1_000, lines };
}
