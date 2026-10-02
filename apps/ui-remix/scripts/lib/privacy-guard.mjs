/**
 * The privacy guard's patterns (check-bundle-size.mjs): what a public sink of
 * the static build must never contain. inject-data.mjs scrubs every sink with
 * @factstack/spec's shareableDataset; these prove it on the built bytes.
 *
 * Pure: patterns in, RegExps out. Unit-tested from the repo-root test/ suite.
 */

/** [pattern, what it is] — a match anywhere in a sink fails the build. */
export const LEAKS = [
  [/[A-Za-z]:[\\/]+Users[\\/]+[^\\/"<\s]+/i, 'a Windows home-directory path'],
  // Git Bash (MSYS), Cygwin and WSL spell the same home `/c/Users/<name>`,
  // and a Windows account name may hold a space. "Users" stays case-sensitive,
  // as Windows writes it, so a `/a/users/<x>` URL path is not a match.
  [/\/[A-Za-z]\/Users\/[^\\/"<\s]+/, 'a Git Bash (MSYS) home-directory path'],
  // Case-SENSITIVE on purpose: macOS homes are `/Users/`, and a lowercase
  // `/users/<name>/` is usually a URL (api.github.com/users/octocat/…).
  [/\/(?:home|Users)\/[A-Za-z0-9._-]+\//, 'a POSIX home-directory path'],
  [/"requests":\[\{/, 'agent session prompts (git.worktrees[].requests)'],
  [/"source":"request"/, 'a request-derived feature (an agent prompt)'],
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One RegExp per local path (the checkout a build ran in, and its parent), in
 * every spelling a sink could carry — any separator run (`/`, `\\`, JSON- or
 * pack-escaped `\\\\`), any case, and for a drive path its Git Bash (MSYS)
 * form too (`D:\dev\x` is `/d/dev/x` there). The home-directory patterns
 * cannot see a repo that lives outside a home dir, so match the actual paths,
 * the same way @factstack/spec's scrub does. A bare drive or root is skipped.
 */
export function localRootPatterns(paths) {
  return paths
    .map((p) => p.split(/[\\/]+/).filter(Boolean))
    .filter((segs) => segs.length >= 2)
    .map((segs) => {
      const [first, ...rest] = segs.map(escapeRe);
      const lead = /^[A-Za-z]:$/.test(segs[0]) ? `(?:${first}|[\\\\/]+${segs[0][0]})` : first;
      return new RegExp([lead, ...rest].join('[\\\\/]+') + '(?![A-Za-z0-9_-])', 'i');
    });
}
