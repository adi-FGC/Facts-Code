import { describe, expect, it } from 'vitest';
import { viewForPath } from '../ui/SubViewTabs.tsx';

/* UI-06 — SubViewTabs re-reads the URL on every in-app nav; this is the
   mapping it uses (the listener itself is covered in e2e/subview-url). */
describe('viewForPath', () => {
  const views = [
    { key: 'files', path: '/files' },
    { key: 'packages', path: '/library' },
    { key: 'extra' },
  ];

  it('maps a view path to its key, whatever the query string', () => {
    expect(viewForPath(views, '/files')).toBe('files');
    expect(viewForPath(views, '/library')).toBe('packages');
  });

  it('returns undefined for the parent path or an unrelated path', () => {
    expect(viewForPath(views, '/security')).toBeUndefined();
    expect(viewForPath(views, '/')).toBeUndefined();
  });
});
