import { describe, expect, it } from 'vitest';
import tsconfig from '../tsconfig.json';
import testTsconfig from '../tsconfig.test.json';
import pkg from '../package.json';

/**
 * tech-debt#3 — `typecheck` also covers test/, and it does so against the
 * same ES2022-only lib as src. Tests run under vitest's Node environment, so
 * lib DOM would let `window`/`document` type-check and then fail at runtime;
 * the one extra global they need (`performance`) is declared in globals.d.ts.
 */
describe('scanners tsconfigs', () => {
  it('type-checks src/ and, through the test config, test/', () => {
    expect(tsconfig.include).toEqual(['src/**/*']);
    expect(testTsconfig.include).toEqual(['src/**/*', 'test/**/*']);
    expect(pkg.scripts.typecheck).toBe('tsc --noEmit && tsc -p tsconfig.test.json');
  });

  it('does not widen the lib for tests (no DOM; both inherit the base ES2022)', () => {
    expect(tsconfig.compilerOptions).not.toHaveProperty('lib');
    expect(testTsconfig.compilerOptions).not.toHaveProperty('lib');
  });
});
