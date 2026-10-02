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
 *   v2: Trees API for the recursive listing (1 request, has CORS) then
 *   fetch each blob from raw.githubusercontent.com (which sets
 *   `Access-Control-Allow-Origin: *` on every response). Trade-off: N+1
 *   requests instead of 1, so we cap concurrency and pre-filter to
 *   text-ish extensions to avoid burning rate limit on PNGs / lockfiles.
 *   PAT raises rate from 60 → 5000/hr.
 *
 *   v3 (2026-09-24, current): the raw host answers every CORS preflight
 *   with 403, and an `Authorization` header forces one — so with a PAT
 *   every blob fetch failed and the scan came back empty and "clean".
 *   The token now never goes to the raw host; a private repo's blobs come
 *   from `api.github.com/…/git/blobs/{sha}` (raw media type, CORS-enabled)
 *   instead. Every blob is read at ONE commit: the ref is resolved to a SHA
 *   first, so a 5-minute raw-host cache can never mix revisions. Failures
 *   are counted and surfaced (report + error) instead of silently dropped.
 *   Lockfiles are always fetched whatever the text filter says, up to the
 *   same ceiling as every file — the one core parses them to on both hosts
 *   (SECRET_SCAN_MAX_BYTES) — so the CVE scan grades installed versions as
 *   it does on the CLI.
 *
 * Why this returns a MemoryFS instead of a synthesized handle:
 *   The legacy prototype mimicked `FileSystemDirectoryHandle` so the
 *   FSA scanner would walk it without modification. With the FactsFS
 *   abstraction in place (constraint C1), we already have an isomorphic
 *   in-memory implementation — no shim needed.
 *
 * Decoding boundary:
 *   GitHub returns bytes. MemoryFS stores strings. We decode UTF-8 here
 *   verbatim (BOM and all, so readFile stays byte-faithful) and keep EVERY
 *   fetched file: the walker's own isBinary / size cap then classifies it
 *   exactly as on the CLI (INV7). readText strips ONE leading BOM itself
 *   with spec's stripLeadingBom, as every host does (Blob.text, NodeFS,
 *   MemoryFS) — not relying on the base class. stat() reports the real
 *   byte size, not the re-encoded length of the decoded string.
 */

import { MemoryFS } from '@factstack/fs-memory';
import {
  LOCKFILE_NAMES,
  NEVER_TEXT_EXTENSIONS,
  SECRET_SCAN_MAX_BYTES,
  stripLeadingBom,
  type Stats,
} from '@factstack/spec';

/** Common source/text extensions. Informational only since 2026-09-23 — the
 *  fetch filter is now a binary DENYlist (see ghIsTextish), because the
 *  analyzer secret-scans every text file and an allowlist made a GitHub scan
 *  miss keys the CLI finds (id_rsa, .npmrc, .tfvars, Jenkinsfile…). */
export const GH_TEXT_EXTS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.php',
  '.sh',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.md',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.txt',
  /* 2026-09-23 — the analyzer secret-scans EVERY text file, so a GitHub
     scan must fetch the formats keys actually get committed in, or the
     same repo gets a different security verdict in the browser than from
     the CLI (INV7). Components, config, infra and scripts: */
  '.vue',
  '.svelte',
  '.astro',
  '.mdx',
  '.xml',
  '.ini',
  '.cfg',
  '.conf',
  '.properties',
  '.env',
  '.tf',
  '.hcl',
  '.sql',
  '.ps1',
  '.bash',
  '.zsh',
  '.pem',
  '.key',
  '.cs',
  '.c',
  '.h',
  '.cpp',
  '.dart',
  '.scala',
  '.gradle',
  '.kts',
]);

/** Mirrors the in-memory ALWAYS_EXCLUDE set the local-folder scanner uses,
 *  so a GitHub scan and a local scan of the same repo produce the same
 *  file set. */
export const GH_EXCLUDE_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
  '__pycache__',
  '.venv',
  '.git',
  'vendor',
  'target',
  'coverage',
  '.pnpm-store',
  '.vscode',
  '.idea',
]);

/** Files above this are listed (real size) but not downloaded. It IS core's
 *  SECRET_SCAN_MAX_BYTES (one constant in @factstack/spec): the walker marks
 *  anything over 1 MB `too_large`, and core still secret-scans it — and
 *  parses it if it is a lockfile — up to this size and never above it, so
 *  the browser fetches exactly what the CLI reads (INV7). */
const GH_MAX_FILE_BYTES = SECRET_SCAN_MAX_BYTES;

/** Lockfile basenames — this IS spec's LOCKFILE_NAMES, the one list
 *  @factstack/scanners parses too (not a mirror). A GitHub scan downloads
 *  these whatever the text filter says: the CVE scan grades the versions a
 *  lockfile INSTALLS, and without it falls back to a manifest's declared
 *  range — so a browser scan of the same repo would grade differently from
 *  the CLI (INV7). Same size ceiling as every file: core never parses a
 *  bigger lockfile on either host, so downloading one would change no result
 *  and only cost memory. */
export const GH_LOCKFILE_NAMES: ReadonlySet<string> = new Set(LOCKFILE_NAMES);

/** The caveat a truncated tree listing leaves on a scan: shown in the UI
 *  (report.warnings) and recorded in the artifacts (report.scanWarnings), so
 *  it names no path. */
export const GH_TRUNCATED_WARNING =
  'GitHub truncated the file listing (the repository tree is too large for one request) — ' +
  'files past the cut-off are missing from this scan.';

/** Consecutive 403/429 blob answers before the scan stops: GitHub is
 *  throttling, and every further request only digs the hole deeper. */
const GH_RATE_LIMIT_ABORT = 5;

/** Above this share of failed downloads the result is refused outright — a
 *  partial repo graded "clean" is worse than an error. */
const GH_MAX_FAILED_SHARE = 0.2;

/** Concurrent raw-blob fetches. 10 keeps per-host connection budgets happy
 *  on Chromium (max 6 per origin) without serializing. raw.githubusercontent.com
 *  is treated as a separate origin from api.github.com. */
export const GH_FETCH_CONCURRENCY = 10;

export interface GitHubFetchSpec {
  owner: string;
  repo: string;
  /** Branch, tag, or commit SHA. Empty = resolve repo's default_branch. */
  ref?: string;
  /** Every possible ref when a pasted /tree/ or /blob/ URL makes the branch
   *  ambiguous (`feature/login-flow` vs `feature` + a path). Set by
   *  parseRepoSpec, shortest first, each extending the previous by a path
   *  segment; `ref` is the first entry. */
  refCandidates?: string[];
  /** Personal access token. Held in localStorage by callers; never leaves
   *  the browser, never lands in any artifact. */
  token?: string;
}

/** What the download actually covered — attached to the returned FS so
 *  the UI can say "N files missing" instead of showing a partial repo as
 *  complete. */
export interface GitHubFetchReport {
  /** Commit every file was read at (null only if GitHub would not resolve
   *  the ref to a SHA; the ref name was used instead). */
  commit: string | null;
  /** The ref that resolved ('' = the default branch). */
  ref: string;
  /** Files selected for download. */
  totalFiles: number;
  fetched: number;
  /** Downloads that failed; status 0 = network/CORS error. */
  failed: Array<{ path: string; status: number }>;
  /** GitHub cut the recursive listing short. */
  truncated: boolean;
  /** Listed with their real size but not downloaded (over the ceiling). */
  notDownloaded: string[];
  /** Human-readable notes for the UI. Empty on a complete scan. */
  warnings: string[];
  /** The whole-scan caveats for the saved artifacts: the scanner passes them
   *  to core's `analyze({ scanWarnings })`, which records them on
   *  `agent.project.scanWarnings` (UI-02). Plain sentences, never a path or
   *  file content — so not `warnings`, whose failed-download line names a
   *  file. Only a truncated tree lands here: each failed download already
   *  stays in the tree unreadable and becomes a per-file read-error risk.
   *  Empty on a complete listing. */
  scanWarnings: string[];
}

/** A MemoryFS whose stat() reports each file's real byte size (the decoded
 *  string's re-encoded length drifts for BOMs and invalid UTF-8) and which
 *  carries the download report. A file whose download failed stays in the
 *  tree at its real size but cannot be read — the walker marks it
 *  `read_error` and core adds a read-error risk, as for a file the CLI
 *  cannot read, so the saved artifacts record the gap (UI-02). */
export class GitHubMemoryFS extends MemoryFS {
  readonly report: GitHubFetchReport;
  private readonly texts: Readonly<Record<string, string>>;
  private readonly sizes: ReadonlyMap<string, number>;
  private readonly unreadable: ReadonlySet<string>;
  /** The mtime MemoryFS gave every file — so a stat() answered from `sizes`
   *  matches one answered by the base class. */
  private readonly mtime: number;

  constructor(
    files: Record<string, string>,
    sizes: ReadonlyMap<string, number>,
    report: GitHubFetchReport,
    unreadable: ReadonlySet<string> = new Set(),
  ) {
    const now = Date.now();
    super(files, now);
    this.mtime = now;
    this.texts = files;
    this.sizes = sizes;
    this.report = report;
    this.unreadable = unreadable;
  }

  private assertReadable(p: string): void {
    if (this.unreadable.has(this.normalize(p))) {
      throw new Error(`EIO: ${p} could not be downloaded from GitHub`);
    }
  }

  override async readFile(p: string): Promise<Uint8Array> {
    this.assertReadable(p);
    return super.readFile(p);
  }

  override async readText(p: string): Promise<string> {
    this.assertReadable(p);
    const t = this.texts[this.normalize(p)];
    if (t === undefined) return super.readText(p); // ENOENT / directory
    return stripLeadingBom(t);
  }

  /** A file with a known size is answered from `sizes` alone: MemoryFS.stat
   *  re-encodes the whole string to count its bytes (a 16 MB copy per stat of
   *  a big file), only for that count to be replaced here. Directories,
   *  ENOENT and a file without a size fall through to the base class. */
  override async stat(p: string): Promise<Stats> {
    const n = this.normalize(p);
    const size = typeof this.texts[n] === 'string' ? this.sizes.get(n) : undefined;
    if (size === undefined) return super.stat(p);
    return {
      size,
      mtimeMs: this.mtime,
      ctimeMs: this.mtime,
      isFile: true,
      isDirectory: false,
      isSymlink: false,
    };
  }
}

export interface FetchProgress {
  phase: 'walking' | 'reading';
  current: number;
  total: number;
  label: string;
}

/** Fetch everything that could be text — the same files a CLI walk reads —
 *  and skip only formats that never are. Extensionless files (id_rsa,
 *  Dockerfile, Jenkinsfile) and dotfiles (.npmrc, .env.local) are text; a
 *  binary that slips through is classified by the walker's own NUL sniff. */
function ghIsTextish(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return true;
  return !NEVER_TEXT_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

function ghIsLockfile(path: string): boolean {
  return GH_LOCKFILE_NAMES.has(path.slice(path.lastIndexOf('/') + 1));
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
 * A branch name may itself contain `/` (`feature/login-flow`), and a URL
 * does not say where the ref ends and the path begins — so for multi-
 * segment URLs every prefix is returned in `refCandidates` (a /blob/ URL's
 * last segment is always the file), shortest first. The fetcher decides
 * which one is the ref — branches before tags, see resolveCandidates.
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
      const parts = u.pathname
        .replace(/^\//, '')
        .split('/')
        .filter(Boolean)
        .map(decodeURIComponent);
      const [owner, repo, kind, ...rest] = parts;
      if (!owner || !repo) return null;
      if ((kind === 'tree' || kind === 'blob') && rest.length) {
        const max = kind === 'blob' ? Math.max(1, rest.length - 1) : rest.length;
        const refCandidates: string[] = [];
        for (let n = 1; n <= max; n++) refCandidates.push(rest.slice(0, n).join('/'));
        ref = refCandidates[0]!;
        if (refCandidates.length > 1) return { owner, repo, ref, refCandidates };
      }
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
  /** Git file mode; '120000' is a symlink (its "content" is the target path). */
  mode?: string;
  size?: number;
  sha?: string;
}

interface TreeResponse {
  tree?: TreeNode[];
  truncated?: boolean;
}

const SHA_RE = /^[0-9a-f]{40}$/i;

/** One line on why a download failed, for the error / warning text. */
function describeFailure(status: number): string {
  if (status === 0) return 'the browser blocked or lost the requests (network or CORS error)';
  if (status === 401) return 'HTTP 401 — the token was rejected';
  if (status === 403 || status === 429) return `HTTP ${status} — rate limited`;
  return `HTTP ${status}`;
}

/**
 * Fetch a public GitHub repo and return it as a `MemoryFS`.
 *
 * Two-phase:
 *   1. Resolve the ref to a commit SHA (`/commits/{ref}`, sha media type)
 *      CONCURRENTLY with the recursive Trees API call. Both go through
 *      api.github.com, both have CORS, both count against the same rate
 *      limit (60/hr unauth, 5000/hr with PAT). A multi-segment URL ref is
 *      resolved first, trying each candidate, then listed by SHA.
 *   2. Concurrent blob fetches, capped at GH_FETCH_CONCURRENCY workers,
 *      from the raw host at the resolved commit (immutable URL, so its
 *      5-minute cache cannot serve an older revision) and never with the
 *      token; a private repo (raw 404 with a token) switches to
 *      `api.github.com/…/git/blobs/{sha}` with it. Every blob is kept; the
 *      walker classifies.
 *
 * Throws when GitHub throttles the scan, when nothing could be downloaded,
 * or when more than GH_MAX_FAILED_SHARE of the files failed; smaller gaps
 * and a truncated tree are listed in `report.warnings`, and each failed file
 * stays in the tree as unreadable (a read-error risk in the artifacts).
 *
 * `onProgress` is called throttled at ~120 ms intervals so the UI stays
 * responsive without flooding the event loop.
 */
export async function fetchGitHubToMemory(
  spec: GitHubFetchSpec,
  onProgress?: (p: FetchProgress) => void,
): Promise<GitHubMemoryFS> {
  const { owner, repo, ref = '', token = '' } = spec;
  const display = `${owner}/${repo}${ref ? '@' + ref : ''}`;
  onProgress?.({ phase: 'walking', current: 0, total: 0, label: `Contacting GitHub… ${display}` });

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const api = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const slashHint = 'For a branch name containing "/", paste owner/repo@branch.';
  const refNotFound = (r: string): Error =>
    new Error(
      `GitHub returned 404: branch or tag "${r}" was not found in ${owner}/${repo}, or the repo is ` +
        `private (add a PAT). ${slashHint}`,
    );

  /** The commit a ref names ('' = default branch). null = GitHub knows no
   *  such ref. A full SHA is already immutable — no request. */
  const resolveCommit = async (r: string): Promise<string | null> => {
    if (SHA_RE.test(r)) return r.toLowerCase();
    const res = await fetch(`${api}/commits/${encodeURIComponent(r || 'HEAD')}`, {
      headers: { ...headers, Accept: 'application/vnd.github.sha' },
    });
    if (res.status === 404 || res.status === 422) return null;
    if (!res.ok) throw ghFriendlyError(res);
    const sha = (await res.text()).trim();
    return SHA_RE.test(sha) ? sha.toLowerCase() : null;
  };

  /** Which prefix of a multi-segment /tree/ or /blob/ ref is the ref.
   *  Branches first: git's D/F rule holds only WITHIN one namespace, so at
   *  most one candidate is a branch — but a tag `release` and a branch
   *  `release/v2` can coexist, and /commits/release would pick the tag. One
   *  matching-refs call lists every branch a candidate could name (they all
   *  start with the first segment), and its 404 means the repo itself is
   *  hidden: the scan stops there instead of spending a request per path
   *  segment. Only then tags and abbreviated SHAs, via /commits. */
  const resolveCandidates = async (cands: string[]): Promise<{ ref: string; sha: string }> => {
    const first = cands[0]!;
    if (SHA_RE.test(first)) return { ref: first, sha: first.toLowerCase() }; // a permalink
    const res = await fetch(`${api}/git/matching-refs/heads/${encodeURIComponent(first)}`, {
      headers,
    });
    if (!res.ok) throw ghFriendlyError(res); // 404: not found, or private without a PAT
    const listed: unknown = await res.json();
    const branches = new Map<string, string>();
    for (const r of Array.isArray(listed) ? listed : []) {
      const { ref: name, object } = (r ?? {}) as { ref?: unknown; object?: { sha?: unknown } };
      if (typeof name === 'string' && typeof object?.sha === 'string') {
        branches.set(name, object.sha);
      }
    }
    for (const c of cands) {
      const sha = branches.get(`refs/heads/${c}`);
      if (sha && SHA_RE.test(sha)) return { ref: c, sha: sha.toLowerCase() };
    }
    for (const c of cands) {
      const sha = await resolveCommit(c);
      if (sha) return { ref: c, sha };
    }
    // The repo answered, so it is not a visibility problem: name everything
    // the user pasted after /tree/, not just its first segment.
    const pasted = cands[cands.length - 1]!;
    throw new Error(
      `No branch, tag or commit "${pasted}" (nor any shorter prefix of it) in ${owner}/${repo}. ${slashHint}`,
    );
  };

  // 1 + 2. The commit and the file list.
  //
  //   With one possible ref, both requests run CONCURRENTLY: the tree is
  //   listed by name while the SHA resolves, so the scan pays one round trip
  //   of wall time, not two (measured ~0.5 s of a 1.3 s scan when these ran
  //   back to back). A pasted URL whose ref may contain '/' is resolved
  //   first — only then is it known which prefix is the branch — and its
  //   tree is listed by the SHA itself.
  const candidates = spec.refCandidates?.length ? spec.refCandidates : [ref];
  let resolvedRef = candidates[0] ?? '';
  let commitPromise: Promise<string | null>;
  if (candidates.length > 1) {
    onProgress?.({
      phase: 'walking',
      current: 0,
      total: 0,
      label: `Resolving ${candidates[candidates.length - 1]}…`,
    });
    const found = await resolveCandidates(candidates);
    resolvedRef = found.ref;
    commitPromise = Promise.resolve(found.sha);
  } else {
    commitPromise = resolveCommit(resolvedRef);
    /* Awaited after the tree lands; a no-op handler meanwhile keeps an
       early rejection (a 403 here) from surfacing as an unhandled one. */
    commitPromise.catch(() => {});
  }
  onProgress?.({
    phase: 'walking',
    current: 0,
    total: 0,
    label: `Listing files at ${resolvedRef || 'HEAD'}…`,
  });
  const treeRef = candidates.length > 1 ? await commitPromise : resolvedRef || 'HEAD';
  const treeRes = await fetch(
    `${api}/git/trees/${encodeURIComponent(treeRef ?? 'HEAD')}?recursive=1`,
    { headers },
  );
  if (!treeRes.ok) {
    /* Surface the tree failure (the parallel commit request is already
       guarded above, so it cannot log a second, confusing error). */
    if (treeRes.status === 404 && ref) throw refNotFound(ref);
    throw ghFriendlyError(treeRes);
  }
  const treeData = (await treeRes.json()) as TreeResponse;
  const tree = Array.isArray(treeData.tree) ? treeData.tree : [];
  const truncated = !!treeData.truncated;

  /* Raw-host revision: the resolved commit. null only if GitHub listed a
     tree for a ref it would not resolve — fall back to the name. */
  const commit = await commitPromise;
  const rawRef = encodeURIComponent(commit ?? (resolvedRef || 'HEAD'));

  // 3. Filter at the network boundary — see preamble.
  const files: Record<string, string> = Object.create(null);
  const sizes = new Map<string, number>();
  const notDownloaded: string[] = [];
  const interesting: TreeNode[] = [];
  for (const node of tree) {
    if (!node || node.type !== 'blob' || typeof node.path !== 'string') continue;
    /* A symlink blob's content is its target path. The walker never
       follows symlinks (followSymlinks=false), so neither do we. */
    if (node.mode === '120000') continue;
    if (ghIsExcluded(node.path)) continue;
    /* A lockfile is fetched whatever the text filter says (yarn.lock's
       `.lock` must never become a "binary" extension). */
    if (!ghIsLockfile(node.path) && !ghIsTextish(node.path)) continue;
    if (typeof node.size === 'number' && node.size > GH_MAX_FILE_BYTES) {
      /* Too big to secret-scan (or parse as a lockfile) even on the CLI.
         List it at its real size without downloading: the walker marks it
         too_large and core reports it as "not scanned for secrets", as it
         would from disk. */
      files[node.path] = '';
      sizes.set(node.path, node.size);
      notDownloaded.push(node.path);
      continue;
    }
    interesting.push(node);
  }
  if (interesting.length === 0 && truncated) {
    throw new Error(
      'GitHub tree was truncated (>100k entries) and no source files matched the filter — try a smaller subdir or a ref.',
    );
  }
  const totalFiles = interesting.length;
  onProgress?.({
    phase: 'walking',
    current: 0,
    total: totalFiles,
    label: `Found ${totalFiles} source files…`,
  });

  // 4. Concurrent blob fetches.
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
  const failed: GitHubFetchReport['failed'] = [];
  const unreadable = new Set<string>();
  let cursor = 0;
  let done = 0;
  let fetched = 0;
  let lastTick = 0;
  let throttled = 0;
  let abort: Error | null = null;
  /* The token NEVER goes to the raw host: an Authorization header forces a
     CORS preflight it answers with 403, which failed every blob. Public
     blobs come from the raw host without it (no API quota spent — a big
     repo would otherwise burn the whole 5000/hr). The first raw 404 with a
     token means a private repo: from then on blobs come from the
     CORS-enabled blobs API, with the token, addressed by blob SHA (so still
     pinned to the listed tree). */
  const blobHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.raw+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  let viaApi = false;
  const fetchBlob = async (node: TreeNode): Promise<Response> => {
    if (!viaApi) {
      // Encode each segment (handles unicode filenames); keep the slashes.
      const path = node.path!.split('/').map(encodeURIComponent).join('/');
      const r = await fetch(
        `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${rawRef}/${path}`,
      );
      if (r.status !== 404 || !token || !node.sha) return r;
      viaApi = true; // private repo: invisible to the raw host
    }
    return fetch(`${api}/git/blobs/${encodeURIComponent(node.sha!)}`, { headers: blobHeaders });
  };

  async function worker(): Promise<void> {
    while (!abort) {
      const i = cursor++;
      if (i >= totalFiles) return;
      const node = interesting[i]!;
      const path = node.path!;
      try {
        let status = 0;
        try {
          const r = await fetchBlob(node);
          status = r.status;
          if (r.ok) {
            const buf = new Uint8Array(await r.arrayBuffer());
            files[path] = decoder.decode(buf);
            sizes.set(path, buf.byteLength);
            fetched++;
            throttled = 0;
            continue;
          }
        } catch {
          status = 0; // network / CORS failure, or the body stream broke
        }
        failed.push({ path, status });
        /* Listed, never read: the walker records it as read_error. */
        files[path] = '';
        if (typeof node.size === 'number') sizes.set(path, node.size);
        unreadable.add(path);
        if (status === 403 || status === 429) {
          if (++throttled >= GH_RATE_LIMIT_ABORT && !abort) {
            abort = new Error(
              `GitHub stopped serving files after ${fetched} of ${totalFiles} (HTTP ${status}: rate limit) — ` +
                (token
                  ? 'wait for the limit to reset, then retry.'
                  : 'add a PAT to raise the limit to 5000/hr, or retry later.'),
            );
          }
        } else {
          throttled = 0;
        }
      } finally {
        /* Count every file, failed or not, so progress reaches the total. */
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
  }

  const workerCount = Math.min(GH_FETCH_CONCURRENCY, Math.max(1, totalFiles));
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) workers.push(worker());
  await Promise.all(workers);

  /* A partial download must never pass for a complete (and "clean") repo. */
  if (abort) throw abort;
  if (totalFiles > 0 && fetched === 0) {
    throw new Error(
      `Downloaded 0 of ${totalFiles} files from GitHub — ${describeFailure(failed[0]?.status ?? 0)}.`,
    );
  }
  if (failed.length > totalFiles * GH_MAX_FAILED_SHARE) {
    throw new Error(
      `Downloaded ${fetched} of ${totalFiles} files from GitHub (${failed.length} failed, e.g. ` +
        `${failed[0]!.path}: ${describeFailure(failed[0]!.status)}) — refusing to report a partial ` +
        `repository as a complete scan. Retry${token ? '' : ', or add a PAT'}.`,
    );
  }
  const warnings: string[] = [];
  if (failed.length) {
    warnings.push(
      `${failed.length} of ${totalFiles} files could not be downloaded from GitHub ` +
        `(e.g. ${failed[0]!.path}: ${describeFailure(failed[0]!.status)}) — this scan lists them as unreadable.`,
    );
  }
  /* Path-free, so it may reach the saved artifacts (see scanWarnings). */
  const scanWarnings = truncated ? [GH_TRUNCATED_WARNING] : [];
  warnings.push(...scanWarnings);

  return new GitHubMemoryFS(
    files,
    sizes,
    {
      commit,
      ref: resolvedRef,
      totalFiles,
      fetched,
      failed,
      truncated,
      notDownloaded,
      warnings,
      scanWarnings,
    },
    unreadable,
  );
}
