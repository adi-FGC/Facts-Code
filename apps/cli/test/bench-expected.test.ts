/**
 * `factstack bench --check` byte-compares the committed bench/expected.json
 * against JSON.stringify(report, null, 2) + '\n'. A formatter that re-wraps
 * the file (oxfmt did, in e69d230) turns the CI determinism gate red with
 * every number unchanged — so pin the serialization itself, not just the
 * numbers.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('bench/expected.json', () => {
  it('is in the exact serialization bench --check emits', () => {
    const raw = readFileSync(new URL('../../../bench/expected.json', import.meta.url), 'utf8');
    expect(raw).toBe(JSON.stringify(JSON.parse(raw), null, 2) + '\n');
  });
});
