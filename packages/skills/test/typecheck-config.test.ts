/**
 * tech-debt#3: the tests are type-checked too. `typecheck` runs the src
 * program, then tsconfig.test.json (src + test, no emit), so a test that
 * drifts from the real types fails the gate instead of piling up unseen.
 */
import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import testConfig from '../tsconfig.test.json' with { type: 'json' };

describe('typecheck covers the tests (tech-debt#3)', () => {
  it('runs tsconfig.test.json after the src check', () => {
    expect(pkg.scripts.typecheck).toBe('tsc --noEmit && tsc -p tsconfig.test.json');
  });

  it('tsconfig.test.json takes in src and test and emits nothing', () => {
    expect(testConfig.include.some((p) => p.startsWith('src/'))).toBe(true);
    expect(testConfig.include.some((p) => p.startsWith('test/'))).toBe(true);
    expect(testConfig.compilerOptions.noEmit).toBe(true);
  });

  it("keeps src's ES2022 lib: no DOM, so window/document fail the check, not the run", () => {
    // The few platform globals the tests use are declared in test/globals.d.ts.
    expect(testConfig.compilerOptions).not.toHaveProperty('lib');
  });
});
