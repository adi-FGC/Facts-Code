import { describe, expect, it } from 'vitest';
import { secretClass, splitSecrets } from './secretClass.ts';

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
