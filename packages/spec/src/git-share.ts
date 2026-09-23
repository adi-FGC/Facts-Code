/**
 * The shareable view of a dataset — what may leave the machine.
 *
 * Local-only in an analysis:
 *   - the absolute path of every checkout (worktrees can live anywhere on
 *     disk, so a sibling checkout survives as a full `C:/Users/<name>/...`
 *     string), and the project root itself wherever text mentions it;
 *   - `git.worktrees[].requests[]`: the first prompt of every Claude Code /
 *     Codex session that ran there. Secret-redacted, but still private text;
 *   - contributor emails.
 *
 * One implementation, used by every sink that hands the data to someone else:
 * the published static site (ui-remix `inject-data.mjs`) and `factstack
 * export`. The Worktrees tab still works on the result: counts, verdicts,
 * gaps, commit features and dates survive; request-derived features are
 * dropped and `sessions` is kept so the page can still say how many matched.
 */

import type { GitTopology } from './git.js';

export interface ShareableGit {
  git: GitTopology;
  /** Absolute checkout path → its public label. Callers that scrub free text
   *  (e.g. a pack serialised as text) need this to catch paths the
   *  structured pass cannot see. */
  pathSubs: Map<string, string>;
}

/* Defensive `?? []` throughout: the static bake also accepts older or
   hand-made datasets, and a scrub that throws would fail the whole build
   rather than just this section. */
export function shareableGitTopology(input: GitTopology): ShareableGit {
  /* JSON round-trip, not structuredClone: spec builds against a plain ES lib
     (no DOM/Node globals), and a topology is JSON data by construction. */
  const git = JSON.parse(JSON.stringify(input)) as GitTopology;
  const worktrees = git.worktrees ?? [];
  const pathSubs = new Map<string, string>();
  worktrees.forEach((w, i) => {
    if (typeof w.path === 'string') pathSubs.set(w.path, w.relPath || `«checkout ${i + 1}»`);
  });
  const relabel = (p: string): string => pathSubs.get(p) ?? '«path»';
  const scrub = (s: string): string => replaceAll(s, [...pathSubs]);

  git.repoRoot = '.';
  git.currentPath = '.';
  for (const w of worktrees) {
    w.path = relabel(w.path);
    if (w.target) w.target = '«path»';
    w.requests = [];
    w.features = (w.features ?? []).filter((f) => f.source !== 'request');
    if (w.readiness) {
      w.readiness.commitReasons = (w.readiness.commitReasons ?? []).map(scrub);
      w.readiness.deployReasons = (w.readiness.deployReasons ?? []).map(scrub);
    }
  }
  for (const b of git.branches ?? []) {
    if (b.worktree) b.worktree = relabel(b.worktree);
    b.deleteBlockers = (b.deleteBlockers ?? []).map(scrub);
  }
  for (const r of git.remotes ?? []) r.url = null; // host + org are not needed to render
  return { git, pathSubs };
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const isAbsolutePath = (p: string): boolean => /^(?:[A-Za-z]:[\\/]|[\\/])/.test(p);

function replaceAll(s: string, subs: ReadonlyArray<readonly [string, string]>): string {
  let out = s;
  for (const [from, to] of subs) if (out.includes(from)) out = out.split(from).join(to);
  return out;
}

/** Root → '.', its parent → '..', in both slash styles. Longest first, so
 *  the root is rewritten before the parent it contains. Never a bare drive
 *  or '/', which would rewrite unrelated text. */
export function localPathSubs(repoRoot: string): Array<[string, string]> {
  const fwd = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const parent = fwd.replace(/\/[^/]*$/, '');
  const pairs: Array<[string, string]> = [
    [fwd, '.'],
    [fwd.replace(/\//g, '\\'), '.'],
    [parent, '..'],
    [parent.replace(/\//g, '\\'), '..'],
  ];
  return pairs.filter(([from]) => from.length > 3 && /[\\/]/.test(from.slice(1)));
}

/** Rewrite local paths and redact emails in one string. */
export function scrubSharedText(s: string, subs: ReadonlyArray<readonly [string, string]>): string {
  return replaceAll(s, subs).replace(EMAIL_RE, '‹email›');
}

export interface ShareableDataset<T> {
  data: T;
  /** Every substitution applied (checkout paths first, then root/parent).
   *  Reuse it for sinks serialised as text, such as the agent pack. */
  textSubs: Array<[string, string]>;
}

/**
 * Deep copy of `input` that is safe to hand to someone else: the git topology
 * goes through shareableGitTopology FIRST — while its paths are still
 * absolute, so its substitutions never key on a relative '..' that would
 * rewrite unrelated text — then every string has checkout paths, the root
 * and its parent rewritten and emails redacted, and every `email` field is
 * blanked.
 */
export function shareableDataset<T>(input: T, repoRoot: string): ShareableDataset<T> {
  const data = JSON.parse(JSON.stringify(input)) as T;
  let gitSubs: Array<[string, string]> = [];
  const rec = data as unknown as { git?: GitTopology | null };
  if (rec && typeof rec === 'object' && rec.git && typeof rec.git === 'object') {
    const shared = shareableGitTopology(rec.git);
    rec.git = shared.git;
    gitSubs = [...shared.pathSubs]
      .filter(([from]) => isAbsolutePath(from))
      .sort((a, b) => b[0].length - a[0].length);
  }
  const textSubs = [...gitSubs, ...localPathSubs(repoRoot)];
  const walk = (node: unknown): void => {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => {
        if (typeof v === 'string') node[i] = scrubSharedText(v, textSubs);
        else walk(v);
      });
      return;
    }
    const obj = node as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (k === 'email' && typeof v === 'string') obj[k] = '';
      else if (typeof v === 'string') obj[k] = scrubSharedText(v, textSubs);
      else walk(v);
    }
  };
  walk(data);
  return { data, textSubs };
}
