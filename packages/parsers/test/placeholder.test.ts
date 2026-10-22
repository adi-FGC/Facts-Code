/**
 * The package is a stated placeholder (F6). This pins the two facts other
 * code may read, so the day a grammar registry lands the notice cannot stay
 * behind by accident.
 */
import { describe, expect, it } from 'vitest';
import { PARSERS_IMPLEMENTED, PLANNED_GRAMMARS } from '../src/index.js';

describe('@factstack/parsers placeholder', () => {
  it('says plainly that no grammar registry exists yet', () => {
    expect(PARSERS_IMPLEMENTED).toBe(false);
  });

  it('lists the planned grammars once each, lower-case', () => {
    expect(new Set(PLANNED_GRAMMARS).size).toBe(PLANNED_GRAMMARS.length);
    for (const g of PLANNED_GRAMMARS) expect(g).toMatch(/^[a-z]+$/);
  });
});
