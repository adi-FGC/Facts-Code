/**
 * GitHub → MemoryFS fetcher.
 *
 * Pulls a public GitHub repo's source files via the Git Trees API +
 * raw.githubusercontent.com and packs the result into an isomorphic
 * `MemoryFS` the analyzer can consume unchanged.
 *
 * History (lifted from legacy/prototype/index.html ~line 5800):
 *   v1 used api.github.com/repos/{o}/{r}/zipball + JSZip. The 302 from
 *   api.github.com lands at codeload.github.com which sets
 *   `Access-Control-Allow-Origin: render.githubusercontent.com` (NOT *),
 *   so the browser blocks the response. Caught in QA on the deployed demo.
 *
 *   v2 (current): Trees API for the recursive listing (1 request, has CORS)
 *   then fetch each blob from raw.githubusercontent.com (which sets
 *   `Access-Control-Allow-Origin: *` on every response). Trade-off: N+1
 *   requests instead of 1, so we cap concurrency and pre-filter to
 *   text-ish extensions to avoid burning rate limit on PNGs / lockfiles.
 *   PAT raises rate from 60 → 5000/hr.
 *
 * Why this returns a MemoryFS instead of a synthesized handle:
 *   The legacy prototype mimicked `FileSystemDirectoryHandle` so the
 *   FSA scanner would walk it without modification. With the FactsFS
 *   abstraction in place (constraint C1), we already have an isomorphic
 *   in-memory implementation — no shim needed.
 *
 * Decoding boundary:
 *   GitHub returns bytes. MemoryFS stores strings. We decode UTF-8 here
 *   with a null-byte sniff and DROP binaries entirely (the legacy code
 *   stored '\0' as a sentinel string; that's clutter we don't need now
 *   that the analyzer can just not see the file).
 */

import { MemoryFS } from '@factstack/fs-memory';

/** Files we'll actually analyze. Filtering at the network layer keeps small
 *  repos under the 60-req unauth rate limit. */
export const GH_TEXT_EXTS: ReadonlySet<string> = new Set([
  '.ts', '.tsx', '.mts', '.cts',
  '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.php', '.sh',
  '.json', '.yaml', '.yml', '.toml',
  '.md', '.html', '.htm', '.css', '.scss', '.txt',
]);

/** Mirrors the in-memory ALWAYS_EXCLUDE set the local-folder scanner uses,
 *  so a GitHub scan and a local scan of the same repo produce the same
 *  file set. */
export const GH_EXCLUDE_DIRS: ReadonlySet<string> = new Set([
  'node_modules', 'dist', 'build', '.next', '.turbo', '.cache',
  '__pycache__', '.venv', '.git', 'vendor', 'target', 'coverage',
  '.pnpm-store', '.vscode', '.idea',
]);

const GH_MAX_FILE_BYTES = 1024 * 1024;

/** Concurrent raw-blob fetches. 10 keeps per-host connection budgets happy
 *  on Chromium (max 6 per origin) without serializing. raw.githubusercontent.com
 *  is treated as a separate origin from api.github.com. */
export const GH_FETCH_CONCURRENCY = 10;

export interface GitHubFetchSpec {
  owner: string;
  repo: string;
  /** Branch, tag, or commit SHA. Empty = resolve repo's default_branch. */
  ref?: string;
  /** Personal access token. Held in localStorage by callers; never leaves
   *  the browser, never lands in any artifact. */
  token?: string;
}

export interface FetchProgress {
  phase: 'walking' | 'reading';
  current: number;
  total: number;
  label: string;
}

function ghIsTextish(path: string): boolean {
  const i = path.lastIndexOf('.');
  if (i < 0) return false;
  return GH_TEXT_EXTS.has(path.slice(i).toLowerCase());
}

function ghIsExcluded(path: string): boolean {
  for (const seg of path.split('/')) {
    if (GH_EXCLUDE_DIRS.has(seg)) return true;
  }
  return false;
}

/** Translates the bare HTTP status into something a UI can show without
 *  the user having to know what 403 means in GitHub-rate-limit-land. */
export function ghFriendlyError(res: Response): Error {
  let hint = '';
  if (res.status === 404) hint = ' (repo not found or private — try adding a PAT)';
  else if (res.status === 403) hint = ' (rate limit exceeded — add a PAT to raise to 5000/hr)';
  else if (res.status === 401) hint = ' (token rejected — check it has not expired)';
  return new Error(`GitHub returned ${res.status} ${res.statusText}${hint}`);
}

/**
 * Parse the many shapes a user might paste into a "GitHub repo" input.
 * Accepts:
 *   - owner/repo
 *   - owner/repo@ref
 *   - https://github.com/owner/repo
 *   - https://github.com/owner/repo/tree/branch
 *   - https://github.com/owner/repo/blob/branch/path...
 *   - any of the above with a trailing `.git`
 *
 * Returns null on garbage so callers can show a parse error rather than
 * making a doomed fetch.
 */
export function parseRepoSpec(raw: string): GitHubFetchSpec | null {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim().replace(/\.git$/, '');
  let ref = '';
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (u.hostname !== 'github.com') return null;
      const parts = u.pathname.replace(/^\//, '').split('/').filter(Boolean);
      const [owner, repo, kind, ...rest] = parts;
      if (!owner || !repo) return null;
      if ((kind === 'tree' || kind === 'blob') && rest.length) ref = rest[0]!;
      return { owner, repo, ref };
    } catch {
      return null;
    }
  }
  // bare owner/repo[@ref]
  const at = s.indexOf('@');
  if (at >= 0) {
    ref = s.slice(at + 1);
    s = s.slice(0, at);
  }
  const slash = s.indexOf('/');
  if (slash <= 0 || slash === s.length - 1) return null;
  const owner = s.slice(0, slash);
  const repo = s.slice(slash + 1).split('/')[0];
  if (!owner || !repo) return null;
  return { owner, repo, ref };
}

interface TreeNode {
  path?: string;
  type?: string;
  size?: number;
  sha?: string;
}

interface TreeResponse {
  tree?: TreeNode[];
  truncated?: boolean;
}

interface RepoMeta {
  default_branch?: string;
}

/** Sniff the first 8 KB for null bytes — the same heuristic the local
 *  walker uses to skip binaries that slipped past the extension filter
 *  (rare, but woff/ico extensions occasionally appear without the dot
 *  segment we'd recognize). */
function isLikelyBinary(bytes: Uint8Array): boolean {
  const probe = bytes.subarray(0, Math.min(8192, bytes.length));
  for (let i = 0; i < probe.length; i++) {
    if (probe[i] === 0) return true;
  }
  return false;
}

/**
 * Fetch a public GitHub repo and return it as a `MemoryFS`.
 *
 * Two-phase:
 *   1. Resolve default branch (skipped if `ref` is given) + recursive Trees
 *      API call. Both go through api.github.com, both have CORS, both count
 *      against the same rate limit (60/hr unauth, 5000/hr with PAT).
 *   2. Concurrent raw-blob fetches against raw.githubusercontent.com,
 *      capped at GH_FETCH_CONCURRENCY workers. Each blob is decoded UTF-8;
 *      binaries are silently dropped (already filtered by extension, but
 *      the null-byte sniff catches mislabeled files).
 *
 * `onProgress` is called throttled at ~120 ms intervals so the UI stays
 * responsive without flooding the event loop.
 */
export async function fetchGitHubToMemory(
  spec: GitHubFetchSpec,
  onProgress?: (p: FetchProgress) => void,
): Promise<MemoryFS> {
  const { owner, repo, ref = '', token = '' } = spec;
  const display = `${owner}/${repo}${ref ? '@' + ref : ''}`;
  onProgress?.({ phase: 'walking', current: 0, total: 0, label: `Contacting GitHub… ${display}` });

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  // 1. Resolve default branch. raw.githubusercontent.com needs the actual
  //    branch name — not "HEAD" — so we have to ask if the caller didn't
  //    pin a ref.
  let branch = ref;
  if (!branch) {
    const r = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { headers },
    );
    if (!r.ok) throw ghFriendlyError(r);
    const meta = (await r.json()) as RepoMeta;
    branch = meta.default_branch || 'main';
  }

  // 2. Recursive tree (one request returns the whole repo manifest at this
  //    ref). truncated=true means >100k entries; we surface that as a
  //    pointed error rather than silently working with a partial tree.
  onProgress?.({ phase: 'walking', current: 0, total: 0, label: `Listing files at ${branch}…` });
  const treeRes = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    { headers },
  );
  if (!treeRes.ok) throw ghFriendlyError(treeRes);
  const treeData = (await treeRes.json()) as TreeResponse;
  const tree = Array.isArray(treeData.tree) ? treeData.tree : [];

  // 3. Filter at the network boundary — see preamble.
  const interesting: TreeNode[] = [];
  for (const node of tree) {
    if (!node || node.type !== 'blob' || typeof node.path !== 'string') continue;
    if (typeof node.size === 'number' && node.size > GH_MAX_FILE_BYTES) continue;
    if (ghIsExcluded(node.path)) continue;
    if (!ghIsTextish(node.path)) continue;
    interesting.push(node);
  }
  if (interesting.length === 0 && treeData.truncated) {
    throw new Error(
      'GitHub tree was truncated (>100k entries) and no source files matched the filter — try a smaller subdir or a ref.',
    );
  }
  const totalFiles = interesting.length;
  onProgress?.({ phase: 'walking', current: 0, total: totalFiles, label: `Found ${totalFiles} source files…` });

  // 4. Concurrent raw-blob fetches.
  const files: Record<string, string> = Object.create(null);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let cursor = 0;
  let done = 0;
  let lastTick = 0;
  const fetchOpts: RequestInit = token ? { headers: { Authorization: `Bearer ${token}` } } : {};

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= totalFiles) return;
      const node = interesting[i]!;
      try {
        // path is already URL-safe per GitHub conventions; do not
        // encodeURIComponent the slashes (encoding each segment is fine
        // and handles unicode filenames correctly).
        const path = node.path!;
        const url = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/${path
          .split('/')
          .map(encodeURIComponent)
          .join('/')}`;
        const r = await fetch(url, fetchOpts);
        if (!r.ok) continue; // skip files that 404 (e.g., LFS pointers)
        const buf = new Uint8Array(await r.arrayBuffer());
        if (isLikelyBinary(buf)) continue; // mislabeled binary — drop
        try {
          files[path] = decoder.decode(buf);
        } catch {
          /* undecodable — drop */
        }
      } catch {
        /* skip individual file failures so one bad blob doesn't kill the run */
      }
      done++;
      const t =
        typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : Date.now();
      if (t - lastTick > 120 || done === totalFiles) {
        onProgress?.({
          phase: 'reading',
          current: done,
          total: totalFiles,
          label: `Fetching files… ${done}/${totalFiles}`,
        });
        lastTick = t;
      }
    }
  }

  const workerCount = Math.min(GH_FETCH_CONCURRENCY, Math.max(1, totalFiles));
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) workers.push(worker());
  await Promise.all(workers);

  return new MemoryFS(files);
}
