import { describe, expect, it } from 'vitest';
import {
  CHARS_PER_TOKEN,
  computeTokenRoi,
  dollars,
  fmtPct,
  fmtRatio,
  fmtPerToken,
  fmtTokens,
  fmtUsd,
} from './tokenEconomics.ts';
import { MODEL_CATALOG, modelById, oldestVerifiedOn, pricedModels } from './modelCatalog.ts';

/**
 * The ROI numbers are a value claim FACTS makes on its own landing page,
 * so the arithmetic has to be right and conservative. These tests pin the
 * contract: savings never go negative, the estimate stays on the
 * conservative side, and the money math matches the rate card.
 */

describe('computeTokenRoi', () => {
  it('estimates artifact tokens with the analyzer’s own divisor and computes savings', () => {
    // 228 KB artifact, 1.5M-token codebase — the FACTS-on-FACTS ballpark.
    const roi = computeTokenRoi(1_500_000, 228_000);
    expect(roi.artifactTokens).toBe(Math.round(228_000 / CHARS_PER_TOKEN)); // 65_143
    expect(roi.fullTokens).toBe(1_500_000);
    expect(roi.savedTokens).toBe(1_500_000 - 65_143);
    expect(roi.savedFraction).toBeCloseTo(0.957, 3);
    expect(Math.round(roi.ratio)).toBe(23);
  });

  /**
   * Guards the reason the divisor moved from 4 to 3.5. A ratio whose two
   * sides are measured by different rules is not a ratio, and the asymmetry
   * ran in the product's favour: dividing the artifact by 4 while the
   * analyzer divides the codebase by 3.5 made the artifact look ~14% smaller
   * and inflated both the multiplier and the percentage saved.
   */
  it('measures both sides of the ratio with the analyzer’s divisor', () => {
    // packages/scanners/src/tokencost.ts: Math.round(text.length / 3.5)
    expect(CHARS_PER_TOKEN).toBe(3.5);
    const chars = 100_000;
    const roi = computeTokenRoi(Math.round(chars / CHARS_PER_TOKEN), chars);
    // The same content measured the same way must cancel to no saving at all.
    expect(roi.savedTokens).toBe(0);
    expect(roi.ratio).toBeCloseTo(1, 6);
  });

  it('never reports negative savings when the artifact is bigger than the repo', () => {
    // Pathological tiny project: the map costs more than the source.
    const roi = computeTokenRoi(100, 4_000);
    expect(roi.savedTokens).toBe(0);
    expect(roi.savedFraction).toBe(0);
  });

  it('is safe on an empty project', () => {
    const roi = computeTokenRoi(0, 0);
    expect(roi).toEqual({
      fullTokens: 0,
      artifactTokens: 0,
      savedTokens: 0,
      savedFraction: 0,
      ratio: 0,
    });
  });
});

describe('dollars', () => {
  it('prices tokens against the per-MTok rate', () => {
    // 1.5M tokens at $3 / 1M = $4.50
    expect(dollars(1_500_000, { inputPerMTok: 3 })).toBeCloseTo(4.5, 6);
  });

  it('prices a real catalog row', () => {
    const opus = modelById('claude-opus-5-5');
    expect(opus.inputPerMTok).toBe(4);
    expect(dollars(1_400_000, { inputPerMTok: opus.inputPerMTok! })).toBeCloseTo(5.6, 6);
  });

  it('modelById falls back to the first entry for an unknown id', () => {
    expect(modelById('nope').id).toBe(MODEL_CATALOG[0]!.id);
  });
});

/**
 * The catalog is data the panel presents as fact, so these guard the
 * promises made in its header comment rather than the numbers themselves.
 */
describe('the baked catalog keeps its own rules', () => {
  it('gives every model an ISO verification date and a source to check', () => {
    for (const m of MODEL_CATALOG) {
      expect(m.verifiedOn, m.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(m.sourceUrl, m.id).toMatch(/^https:\/\//);
    }
  });

  it('uses null, never 0, for "no published price" — free and unknown differ', () => {
    const anti = modelById('gemini-antigravity');
    expect(anti.inputPerMTok).toBeNull();
    expect(pricedModels().every((m) => typeof m.inputPerMTok === 'number')).toBe(true);
    expect(pricedModels()).not.toContain(anti);
  });

  it('never claims to be fresher than its stalest row', () => {
    const oldest = oldestVerifiedOn();
    for (const m of MODEL_CATALOG) expect(m.verifiedOn >= oldest).toBe(true);
  });

  it('keeps model ids unique, since they key UI state', () => {
    expect(new Set(MODEL_CATALOG.map((m) => m.id)).size).toBe(MODEL_CATALOG.length);
  });

  it('marks a row whose sources disagreed as less than primary', () => {
    // Inkling: five hosted providers vs a conflicting vendor-page reading.
    expect(modelById('inkling').confidence).not.toBe('primary');
    expect(modelById('inkling').notes).toMatch(/disagree/i);
  });
});

describe('fmtPerToken — the per-token column', () => {
  it('does not collapse a real per-token price to $0.00', () => {
    expect(fmtPerToken(0.75)).toBe('$0.00000075'); // Gemini 3.8 Flash
    expect(fmtPerToken(4)).toBe('$0.000004'); // Opus 5.5
    expect(fmtPerToken(50)).toBe('$0.00005'); // Fable 5.1 output
    expect(fmtPerToken(0.15)).toBe('$0.00000015'); // GLM-5.3 Flash
  });

  it('returns $0 for zero and for anything unusable', () => {
    expect(fmtPerToken(0)).toBe('$0');
    expect(fmtPerToken(Number.NaN)).toBe('$0');
    expect(fmtPerToken(-1)).toBe('$0');
  });
});

describe('formatting', () => {
  it('fmtTokens compacts to K/M', () => {
    expect(fmtTokens(57_000)).toBe('57K');
    expect(fmtTokens(1_500_000)).toBe('1.5M');
    expect(fmtTokens(940)).toBe('940');
  });

  it('fmtUsd keeps sub-cent precision so tiny per-task costs are legible', () => {
    expect(fmtUsd(0)).toBe('$0');
    expect(fmtUsd(0.0017)).toBe('$0.0017');
    expect(fmtUsd(0.171)).toBe('$0.171');
    expect(fmtUsd(4.5)).toBe('$4.50');
    expect(fmtUsd(1234)).toBe('$1,234');
  });

  it('fmtRatio and fmtPct frame the win', () => {
    expect(fmtRatio(26.3)).toBe('26×');
    expect(fmtRatio(2.4)).toBe('2.4×');
    expect(fmtRatio(0)).toBe('—');
    expect(fmtPct(0.962)).toBe('96%');
  });
});
