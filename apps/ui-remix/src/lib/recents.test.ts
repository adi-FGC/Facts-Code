import { describe, expect, it } from 'vitest';
import { agentRulesDefault, recentForScan } from './recents.ts';

/* UI-13 — the recent (and header chip) a finished scan becomes is decided by
   what the scan was launched from, never by regex-parsing the project name. */
describe('recentForScan', () => {
  it('a folder-input scan is never a recent (so the caller clears "current")', () => {
    /* Before the fix, a local-files scan fell into the GitHub branch; any
       name without a slash (the usual folder name) left the PREVIOUS source
       current, so the chip named the wrong project. */
    expect(recentForScan({ kind: 'local-files' }, 'my-app')).toBeNull();
    expect(recentForScan({ kind: 'local-files' }, 'vercel/next.js')).toBeNull();
  });

  it('an FSA scan becomes a local recent for its handle', () => {
    const handle = { name: 'my-app' } as FileSystemDirectoryHandle;
    expect(recentForScan({ kind: 'local-fsa', handle }, 'whatever')).toEqual({
      kind: 'local',
      name: 'my-app',
      handle,
    });
  });

  it('a GitHub scan takes the ref the worker resolved from the project name', () => {
    expect(
      recentForScan(
        { kind: 'github', owner: 'vercel', repo: 'next.js', ref: '' },
        'vercel/next.js@canary',
      ),
    ).toEqual({
      kind: 'github',
      name: 'vercel/next.js@canary',
      owner: 'vercel',
      repo: 'next.js',
      ref: 'canary',
    });
  });

  it('a GitHub scan falls back to the launch spec when the name is not owner/repo', () => {
    expect(
      recentForScan({ kind: 'github', owner: 'expressjs', repo: 'express', ref: 'v5' }, 'express'),
    ).toEqual({
      kind: 'github',
      name: 'expressjs/express@v5',
      owner: 'expressjs',
      repo: 'express',
      ref: 'v5',
    });
  });
});

/* FSB-7 — a GitHub scan's Save goes to a folder the user picks, so the rules
   files that describe the scanned repo are opt-in there. */
describe('agentRulesDefault', () => {
  it('writes agent rules by default for a local scan, not for a GitHub scan', () => {
    const handle = { name: 'my-app' } as FileSystemDirectoryHandle;
    expect(agentRulesDefault({ kind: 'local-fsa', handle })).toBe(true);
    expect(agentRulesDefault({ kind: 'local-files' })).toBe(true);
    expect(agentRulesDefault({ kind: 'github', owner: 'o', repo: 'r', ref: '' })).toBe(false);
  });
});
