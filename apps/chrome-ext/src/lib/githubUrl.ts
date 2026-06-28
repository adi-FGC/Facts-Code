/**
 * Parse a GitHub repo reference from a tab URL or a typed "owner/repo" string.
 * Pure + dependency-free so it's trivially testable.
 */
export interface RepoRef {
  owner: string;
  repo: string;
  ref?: string;
}

/* Top-level github.com paths that are NOT repos — don't offer to "analyze" them. */
const RESERVED_OWNERS = new Set([
  'orgs', 'marketplace', 'sponsors', 'settings', 'notifications', 'explore',
  'topics', 'collections', 'features', 'about', 'pricing', 'login', 'join',
  'new', 'apps', 'organizations', 'account', 'dashboard', 'search', 'codespaces',
]);

/** Parse a full github.com URL. Returns null for non-repo pages. */
export function parseGitHubUrl(url: string): RepoRef | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0]!;
  if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;
  const repo = parts[1]!.replace(/\.git$/u, '');
  if (!repo) return null;
  // /tree/<ref> or /blob/<ref> carries a branch/tag/sha.
  if ((parts[2] === 'tree' || parts[2] === 'blob') && parts[3]) {
    return { owner, repo, ref: parts[3] };
  }
  return { owner, repo };
}

/** Parse either a full URL or an "owner/repo[@ref]" / "owner/repo[#ref]" shorthand. */
export function parseRepoInput(raw: string): RepoRef | null {
  const text = raw.trim();
  if (!text) return null;
  if (/^https?:\/\//iu.test(text)) return parseGitHubUrl(text);
  // shorthand: owner/repo, optionally @ref or /tree/ref
  const at = text.split(/[@#]/u);
  const ref = at[1]?.trim();
  const slug = (at[0] ?? '').trim().replace(/^\/+|\/+$/gu, '');
  const segs = slug.split('/').filter(Boolean);
  if (segs.length < 2) return null;
  const owner = segs[0]!;
  if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;
  const repo = segs[1]!.replace(/\.git$/u, '');
  if (!repo) return null;
  // owner/repo/tree/ref shorthand
  const inlineRef = (segs[2] === 'tree' || segs[2] === 'blob') && segs[3] ? segs[3] : ref;
  return inlineRef ? { owner, repo, ref: inlineRef } : { owner, repo };
}

export function repoLabel(r: RepoRef): string {
  return `${r.owner}/${r.repo}${r.ref ? '@' + r.ref : ''}`;
}
