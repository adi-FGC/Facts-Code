import { describe, expect, it } from 'vitest';
import { generatedAtFromEnv } from '../src/clock.js';

describe('generatedAtFromEnv', () => {
  const fixed = () => new Date('2026-10-22T10:00:00.000Z');

  it('honours SOURCE_DATE_EPOCH, the reproducible-builds convention', () => {
    expect(generatedAtFromEnv({ SOURCE_DATE_EPOCH: '1700000000' }, fixed)).toBe(
      '2023-11-14T22:13:20.000Z',
    );
    expect(generatedAtFromEnv({ SOURCE_DATE_EPOCH: ' 1700000000 ' }, fixed)).toBe(
      '2023-11-14T22:13:20.000Z',
    );
  });

  it('ignores a malformed value and uses the injected clock', () => {
    for (const bad of ['', 'yesterday', '-5', '1.5', '17000000000000'])
      expect(generatedAtFromEnv({ SOURCE_DATE_EPOCH: bad }, fixed)).toBe(
        '2026-10-22T10:00:00.000Z',
      );
  });

  it('uses the clock when the variable is unset', () => {
    expect(generatedAtFromEnv({}, fixed)).toBe('2026-10-22T10:00:00.000Z');
  });
});
