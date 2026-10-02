/**
 * The build's privacy guard patterns (apps/ui-remix/scripts/lib/privacy-guard.mjs,
 * used by check-bundle-size.mjs on every public sink of the static build).
 *
 * Regression: the guard knew home directories as `X:\Users\…` and
 * `/home|Users/<name>/`, and the checkout only in its drive spelling, so a
 * Git Bash (MSYS) path — `/c/Users/<First Last>/…` or the repo root as
 * `/d/…` — passed the build.
 */
import { describe, expect, it } from 'vitest';
import { LEAKS, localRootPatterns } from '../apps/ui-remix/scripts/lib/privacy-guard.mjs';

const leaks = (text) => LEAKS.filter(([re]) => re.test(text)).map(([, what]) => what);

describe('privacy guard: home directories', () => {
  it('catches a Git Bash home, a space in the account name included', () => {
    expect(leaks('see /c/Users/Jane Doe/notes.md')).toEqual([
      'a Git Bash (MSYS) home-directory path',
    ]);
    expect(leaks('"cwd":"/c/Users/jdoe/proj"')).toContain('a Git Bash (MSYS) home-directory path');
    expect(leaks('C:\\\\Users\\\\Jane Doe\\\\x')).toEqual(['a Windows home-directory path']);
  });

  it('leaves placeholders and URL paths alone', () => {
    expect(leaks('Git Bash prints /c/Users/<name>/ for a home')).toEqual([]);
    expect(leaks('https://api.github.com/users/octocat/repos and /a/users/x')).toEqual([]);
  });
});

describe('privacy guard: this checkout and its parent', () => {
  const [root, parent] = localRootPatterns(['Q:\\fake\\parent\\repo', 'Q:\\fake\\parent']);
  const hit = (text) => [root, parent].some((re) => re.test(text));

  it('matches every spelling of a drive path, the Git Bash one too', () => {
    for (const s of [
      'Q:/fake/parent/repo/src',
      'q:\\\\fake\\\\parent\\\\repo',
      '/q/fake/parent/repo/src',
      'cd /Q/Fake/Parent && ls',
    ])
      expect(hit(s), s).toBe(true);
  });

  it('stops at a name boundary and skips a bare drive', () => {
    expect(hit('/q/fake/parentx and Q:/fake/parent-2')).toBe(false);
    expect(localRootPatterns(['Q:\\', '/'])).toEqual([]);
  });
});
