import { describe, expect, it } from 'vitest';
import {
  CHARS_PER_TOKEN,
  computeTokenRoi,
  dollars,
  fmtPct,
  fmtRatio,
  fmtTokens,
  fmtUsd,
  MODEL_RATES,
  rateById,
} from './tokenEconomics.ts';

/**
 * The ROI numbers are a value claim FACTS makes on its own landing page,
 * so the arithmetic has to be right and conservative. These tests pin the
 * contract: savings never go negative, the estimate stays on the
 * conservative side, and the money math matches the rate card.
 */

describe('computeTokenRoi', () => {
  it('estimates artifact tokens at ~chars/4 and computes savings', () => {
    // 228 KB artifact, 1.5M-token codebase — the FACTS-on-FACTS ballpark.
    const roi = computeTokenRoi(1_500_000, 228_000);
    expect(roi.artifactTokens).toBe(Math.round(228_000 / CHARS_PER_TOKEN)); // 57_000
    expect(roi.fullTokens).toBe(1_500_000);
    expect(roi.savedTokens).toBe(1_500_000 - 57_000);
    expect(roi.savedFraction).toBeCloseTo(0.962, 3);
    expect(Math.round(roi.ratio)).toBe(26);
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
    const sonnet = rateById('sonnet');
    expect(sonnet.inputPerMTok).toBe(3);
    // 1.5M tokens at $3 / 1M = $4.50
    expect(dollars(1_500_000, sonnet)).toBeCloseTo(4.5, 6);
  });

  it('rateById falls back to the middle preset for unknown ids', () => {
    expect(rateById('nope').id).toBe('sonnet');
    expect(MODEL_RATES).toHaveLength(3);
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
