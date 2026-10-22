import { describe, expect, it } from 'vitest';
import { isRouteChange } from './navGuard.ts';

describe('isRouteChange', () => {
  it('ignores a popstate that only changed the fragment', () => {
    expect(isRouteChange('popstate', '/docs', '/docs')).toBe(false);
  });

  it('follows back/forward across routes and queries', () => {
    expect(isRouteChange('popstate', '/docs', '/files')).toBe(true);
    expect(isRouteChange('popstate', '/files?p=a.ts', '/files?p=b.ts')).toBe(true);
  });

  it('always follows the in-app navigation event', () => {
    expect(isRouteChange('factstack:nav', '/docs', '/docs')).toBe(true);
  });
});
