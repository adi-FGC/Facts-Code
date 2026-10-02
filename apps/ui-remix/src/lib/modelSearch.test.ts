import { describe, expect, it } from 'vitest';
import { MODEL_CATALOG, modelById } from './modelCatalog.ts';
import {
  flatModels,
  modelDisplayText,
  modelPriceText,
  searchModels,
  stepId,
} from './modelSearch.ts';

const ids = (q: string) => flatModels(searchModels(MODEL_CATALOG, q)).map((m) => m.id);

describe('searchModels', () => {
  it('returns every model, grouped by vendor in catalog order, for an empty query', () => {
    const groups = searchModels(MODEL_CATALOG, '  ');
    expect(flatModels(groups)).toHaveLength(MODEL_CATALOG.length);
    expect(groups[0]!.vendor).toBe(MODEL_CATALOG[0]!.vendor);
    expect(new Set(groups.map((g) => g.vendor)).size).toBe(groups.length);
  });

  it('matches every term, case-insensitively, across label, vendor and API id', () => {
    expect(ids('GPT sol')).toEqual(['gpt-6-1-sol', 'gpt-6-sol']);
    expect(ids('anthropic')).toEqual(
      MODEL_CATALOG.filter((m) => m.vendor === 'Anthropic').map((m) => m.id),
    );
    expect(ids('qwen3.8')).toEqual(['qwen3-8-max']);
  });

  it('still finds the model when the shown text is edited rather than replaced', () => {
    const opus = modelById('claude-opus-5-5');
    expect(ids(modelDisplayText(opus).slice(0, -1))).toContain('claude-opus-5-5');
  });

  it('keeps a model with no price findable by name and by "no price"', () => {
    expect(ids('antigravity')).toEqual(['gemini-antigravity']);
    expect(ids('no price')).toContain('gemini-antigravity');
  });

  it('returns no groups when nothing matches', () => {
    expect(searchModels(MODEL_CATALOG, 'zzz-not-a-model')).toEqual([]);
  });
});

describe('modelPriceText', () => {
  it('prints the input rate, or says there is none', () => {
    expect(modelPriceText(modelById('claude-opus-5-5'))).toBe('$4/M');
    expect(modelPriceText(modelById('gemini-antigravity'))).toBe('no price');
  });
});

/* With live prices loaded the box kept printing the baked rate while
   the rate card beside it printed the live one. */
describe('priceOf: the rate in force', () => {
  const live = (m: { id: string; inputPerMTok: number | null }) =>
    m.id === 'claude-opus-5-5' ? 5 : m.inputPerMTok;

  it('is what the box prints, in place of the baked rate', () => {
    const opus = modelById('claude-opus-5-5');
    expect(modelPriceText(opus, live)).toBe('$5/M');
    expect(modelDisplayText(opus, live)).toBe('Opus 5.5 — $5/M');
    expect(modelDisplayText(opus)).toBe('Opus 5.5 — $4/M');
  });

  it('is what the search matches, so an edited shown text still finds its model', () => {
    const byLive = flatModels(searchModels(MODEL_CATALOG, 'opus $5/M', live)).map((m) => m.id);
    expect(byLive).toContain('claude-opus-5-5');
    expect(ids('opus $5/M')).not.toContain('claude-opus-5-5');
  });
});

describe('stepId', () => {
  const list = ['a', 'b', 'c'];
  it('moves and wraps at both ends', () => {
    expect(stepId(list, 'a', 1)).toBe('b');
    expect(stepId(list, 'c', 1)).toBe('a');
    expect(stepId(list, 'a', -1)).toBe('c');
  });

  it('enters a list from either side when nothing (or a filtered-out id) is active', () => {
    expect(stepId(list, null, 1)).toBe('a');
    expect(stepId(list, null, -1)).toBe('c');
    expect(stepId(list, 'gone', 1)).toBe('a');
  });

  it('has nowhere to go in an empty list', () => {
    expect(stepId([], 'a', 1)).toBeNull();
  });
});
