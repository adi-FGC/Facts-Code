/**
 * fetchGitHubToMemory — what the browser can actually fetch, and what a
 * partial download reports.
 *
 * The fake below behaves like the real hosts where it matters:
 *   - raw.githubusercontent.com answers every CORS preflight with 403, so a
 *     request carrying `Authorization` fails in the browser with a TypeError
 *     (verified live 2026-09-24). The fake throws that TypeError.
 *   - api.github.com serves `/commits/{ref}` (sha media type),
 *     `/git/matching-refs/{heads|tags}/{prefix}`, the recursive tree, and
 *     `/git/blobs/{sha}` (raw media type) with CORS; a hidden repo 404s.
 *
 * Each block pins one confirmed defect: a PAT emptied every scan (UI-01),
 * throttled/failed fetches were dropped silently (UI-02), >1 MB and
 * single-NUL files vanished (FSB-2/3), a kept BOM broke package.json
 * (BFS-R1), contents came from a cached branch tip (FSB-9), symlinks were
 * read as files (FSB-10), slash branches resolved to their first segment
 * or to a same-named tag (UI-14/FSB-6/BFS-R3), a lockfile must reach core
 * whenever core would parse it (CVE parity), and stat() re-encoded a whole
 * file only to discard the count (BFS2-3).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryFS } from '@factstack/fs-memory';
import { LOCKFILE_NAMES, NEVER_TEXT_EXTENSIONS, SECRET_SCAN_MAX_BYTES } from '@factstack/spec';
import {
  fetchGitHubToMemory,
  GH_LOCKFILE_NAMES,
  GH_TRUNCATED_WARNING,
  parseRepoSpec,
  type FetchProgress,
} from '../src/github.js';

const SHA = 'a'.repeat(40);
/** The commit every tag points at — distinct, so a test sees which ref won. */
const TAG_SHA = 'b'.repeat(40);

interface FakeNode {
  path: string;
  /** ArrayBuffer-backed, so it is a valid `Response` body under lib.dom. */
  body?: string | Uint8Array<ArrayBuffer>;
  /** Tree-reported size; defaults to the body's byte length. */
  size?: number;
  mode?: string;
  type?: string;
}

interface FakeOpts {
  nodes: FakeNode[];
  /** Branch names that exist besides `main` (all resolve to SHA). */
  refs?: string[];
  /** Tag names (all resolve to TAG_SHA). */
  tags?: string[];
  truncated?: boolean;
  /** A private repo: the raw host answers 404 for everything. */
  private?: boolean;
  /** Invisible to the caller (missing, or private without a PAT): every
   *  host answers 404. */
  hidden?: boolean;
  /** Per-request override for blob fetches (raw or API): return a status. */
  blobStatus?: (path: string, n: number) => number | undefined;
}

interface Seen {
  url: string;
  headers: Record<string, string>;
}

function bytesOf(b: string | Uint8Array<ArrayBuffer> | undefined): Uint8Array<ArrayBuffer> {
  if (b === undefined) return new Uint8Array();
  return typeof b === 'string' ? new TextEncoder().encode(b) : b;
}

function headersOf(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => (out[k.toLowerCase()] = v));
  return out;
}

function fakeGitHub(opts: FakeOpts): { seen: Seen[] } {
  const seen: Seen[] = [];
  const branches = new Set(['main', ...(opts.refs ?? [])]);
  const tags = new Set(opts.tags ?? []);
  const shaOf = (ref: string): string | null =>
    ref === 'HEAD' || ref === SHA || branches.has(ref)
      ? SHA
      : ref === TAG_SHA || tags.has(ref)
        ? TAG_SHA
        : null;
  const byPath = new Map(opts.nodes.map((n) => [n.path, n]));
  const bySha = new Map(opts.nodes.map((n, i) => [`blob${i}`, n]));
  let blobCalls = 0;
  const blobReply = (node: FakeNode): Response => {
    const n = blobCalls++;
    const status = opts.blobStatus?.(node.path, n);
    if (status !== undefined) return new Response('nope', { status });
    return new Response(bytesOf(node.body), { status: 200 });
  };

  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const headers = headersOf(init);
    seen.push({ url, headers });
    const u = new URL(url);

    if (u.hostname === 'raw.githubusercontent.com') {
      // The raw host rejects every preflight: an Authorization header can
      // never reach it from a browser.
      if (headers.authorization) throw new TypeError('Failed to fetch');
      if (opts.private || opts.hidden) return new Response('404', { status: 404 });
      const [, , , ref, ...rest] = u.pathname.split('/');
      if (!shaOf(decodeURIComponent(ref!))) return new Response('404', { status: 404 });
      const node = byPath.get(rest.map(decodeURIComponent).join('/'));
      return node ? blobReply(node) : new Response('404', { status: 404 });
    }

    if (opts.hidden)
      return new Response('{"message":"Not Found"}', { status: 404, statusText: 'Not Found' });
    const p = u.pathname;
    let m = /^\/repos\/o\/r\/commits\/(.+)$/.exec(p);
    if (m) {
      const sha = shaOf(decodeURIComponent(m[1]!));
      if (!sha) return new Response('{"message":"No commit found"}', { status: 422 });
      return new Response(sha, { status: 200 });
    }
    m = /^\/repos\/o\/r\/git\/matching-refs\/(heads|tags)\/(.+)$/.exec(p);
    if (m) {
      const ns = m[1]!;
      const prefix = decodeURIComponent(m[2]!);
      return Response.json(
        [...(ns === 'heads' ? branches : tags)]
          .filter((r) => r.startsWith(prefix))
          .map((r) => ({
            ref: `refs/${ns}/${r}`,
            object: { sha: ns === 'heads' ? SHA : TAG_SHA, type: 'commit' },
          })),
      );
    }
    m = /^\/repos\/o\/r\/git\/trees\/(.+)$/.exec(p);
    if (m) {
      const ref = decodeURIComponent(m[1]!);
      if (!shaOf(ref)) return new Response('{"message":"Not Found"}', { status: 404 });
      return Response.json({
        sha: 'tree',
        truncated: !!opts.truncated,
        tree: opts.nodes.map((n, i) => ({
          path: n.path,
          type: n.type ?? 'blob',
          mode: n.mode ?? '100644',
          size: n.size ?? bytesOf(n.body).byteLength,
          sha: `blob${i}`,
        })),
      });
    }
    m = /^\/repos\/o\/r\/git\/blobs\/(.+)$/.exec(p);
    if (m) {
      const node = bySha.get(m[1]!);
      return node ? blobReply(node) : new Response('404', { status: 404 });
    }
    if (p === '/repos/o/r') return Response.json({ default_branch: 'main' });
    return new Response('unexpected', { status: 500 });
  }) as typeof globalThis.fetch);
  return { seen };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Ref lookups a scan spent against the API budget. */
const lookups = (seen: Seen[]): number =>
  seen.filter((s) => /\/commits\/|\/matching-refs\//.test(s.url)).length;

describe('UI-01 / correctness#21 — a PAT must not empty the scan', () => {
  const nodes = [
    { path: 'src/a.ts', body: 'export const a = 1;\n' },
    { path: 'README.md', body: '# hi\n' },
  ];
  const noTokenOnRaw = (seen: Seen[]): void => {
    for (const s of seen) {
      if (s.url.includes('raw.githubusercontent.com'))
        expect(s.headers.authorization).toBeUndefined();
    }
  };

  it('public repo + token: every file fetched, the token never sent to the raw host', async () => {
    const { seen } = fakeGitHub({ nodes });
    const fs = await fetchGitHubToMemory({ owner: 'o', repo: 'r', token: 'ghp_test' });
    expect(await fs.readText('src/a.ts')).toContain('export const a');
    expect(await fs.readText('README.md')).toContain('# hi');
    noTokenOnRaw(seen);
    // Public blobs spend no API quota.
    expect(seen.some((s) => s.url.includes('/git/blobs/'))).toBe(false);
  });

  it('private repo + token: blobs come from the CORS-enabled blobs API', async () => {
    const { seen } = fakeGitHub({ nodes, private: true });
    const fs = await fetchGitHubToMemory({ owner: 'o', repo: 'r', token: 'ghp_test' });
    expect(await fs.readText('src/a.ts')).toContain('export const a');
    expect(await fs.readText('README.md')).toContain('# hi');
    noTokenOnRaw(seen);
    const blob = seen.find((s) => s.url.includes('/git/blobs/'));
    expect(blob?.headers.authorization).toBe('Bearer ghp_test');
    expect(blob?.headers.accept).toBe('application/vnd.github.raw+json');
  });

  it('rejects instead of returning an empty repo when no file could be fetched', async () => {
    fakeGitHub({
      nodes: [{ path: 'a.ts', body: 'x' }],
      blobStatus: () => 500,
    });
    await expect(fetchGitHubToMemory({ owner: 'o', repo: 'r' })).rejects.toThrow(
      /Downloaded 0 of 1 files/,
    );
  });
});

describe('UI-02 — throttled, failed and truncated fetches are surfaced', () => {
  const many = Array.from({ length: 21 }, (_, i) => ({ path: `f${i}.ts`, body: `// ${i}\n` }));

  it('aborts with a rate-limit error once GitHub starts answering 429', async () => {
    fakeGitHub({ nodes: many, blobStatus: (_p, n) => (n >= 5 ? 429 : undefined) });
    await expect(fetchGitHubToMemory({ owner: 'o', repo: 'r' })).rejects.toThrow(/rate limit/i);
  });

  it('reports a few failed files and a truncated tree on the result', async () => {
    const progress: FetchProgress[] = [];
    fakeGitHub({
      nodes: many,
      truncated: true,
      blobStatus: (p) => (p === 'f3.ts' ? 404 : undefined),
    });
    const fs = await fetchGitHubToMemory({ owner: 'o', repo: 'r' }, (p) => progress.push(p));
    expect(fs.report.failed).toEqual([{ path: 'f3.ts', status: 404 }]);
    expect(fs.report.truncated).toBe(true);
    expect(fs.report.warnings.join('\n')).toMatch(/1 of 21 files could not be downloaded/);
    expect(fs.report.warnings.join('\n')).toMatch(/truncated/i);
    // Progress always reaches the total, failures included.
    expect(progress.at(-1)).toMatchObject({ phase: 'reading', current: 21, total: 21 });
  });

  it('records only the path-free truncated-tree caveat for the artifacts', async () => {
    /* report.scanWarnings becomes agent.project.scanWarnings: plain
       sentences, never a path. The failed-download line names a file (and
       the file is already a per-file read-error risk), so it stays UI-only. */
    fakeGitHub({
      nodes: many,
      truncated: true,
      blobStatus: (p) => (p === 'f3.ts' ? 404 : undefined),
    });
    const cut = await fetchGitHubToMemory({ owner: 'o', repo: 'r' });
    expect(cut.report.scanWarnings).toEqual([GH_TRUNCATED_WARNING]);
    expect(cut.report.warnings).toContain(GH_TRUNCATED_WARNING);
    expect(cut.report.scanWarnings.join('\n')).not.toMatch(/f3\.ts|could not be downloaded/);

    vi.unstubAllGlobals();
    fakeGitHub({ nodes: many, blobStatus: (p) => (p === 'f3.ts' ? 404 : undefined) });
    const partial = await fetchGitHubToMemory({ owner: 'o', repo: 'r' });
    expect(partial.report.warnings).toHaveLength(1); // the failed-download line
    expect(partial.report.scanWarnings).toEqual([]);
  });

  it('keeps a failed file in the tree as unreadable, so the artifacts record the gap', async () => {
    /* Listed at its real size, but every read throws: the walker marks it
       read_error and core adds a read-error risk, exactly as for a file the
       CLI cannot read — so a saved agent.json never passes for complete. */
    fakeGitHub({ nodes: many, blobStatus: (p) => (p === 'f3.ts' ? 500 : undefined) });
    const fs = await fetchGitHubToMemory({ owner: 'o', repo: 'r' });
    const listed: string[] = [];
    for await (const e of fs.readDir('.')) listed.push(e.name);
    expect(listed).toContain('f3.ts');
    expect((await fs.stat('f3.ts')).size).toBe(bytesOf('// 3\n').byteLength);
    await expect(fs.readText('f3.ts')).rejects.toThrow(/could not be downloaded/);
    await expect(fs.readFile('f3.ts')).rejects.toThrow(/could not be downloaded/);
    expect(await fs.readText('f4.ts')).toBe('// 4\n');
  });

  it('refuses to present a mostly-failed download as a scan', async () => {
    fakeGitHub({ nodes: many, blobStatus: (_p, n) => (n % 2 === 0 ? 500 : undefined) });
    await expect(fetchGitHubToMemory({ owner: 'o', repo: 'r' })).rejects.toThrow(
      /Downloaded \d+ of 21 files/,
    );
  });
});

describe('FSB-2 / FSB-3 — the walker, not the fetcher, decides what is too large or binary', () => {
  it('keeps a >1 MB file so the analyzer can secret-scan it, with its real size', async () => {
    // Built from pieces: the repo never commits a literal token shape.
    const big = 'x'.repeat(1_100_000) + '\nconst k = "' + 'AKIA' + 'IOSFODNN7EXAMPLE' + '";\n';
    fakeGitHub({ nodes: [{ path: 'public/bundle.min.js', body: big }] });
    const fs = await fetchGitHubToMemory({ owner: 'o', repo: 'r' });
    expect((await fs.stat('public/bundle.min.js')).size).toBe(bytesOf(big).byteLength);
    expect(await fs.readText('public/bundle.min.js')).toContain('AKIA');
  });

  it('lists a file above the secret-scan ceiling with its real size without downloading it', async () => {
    const { seen } = fakeGitHub({ nodes: [{ path: 'dump.sql', body: '', size: 20_000_000 }] });
    const fs = await fetchGitHubToMemory({ owner: 'o', repo: 'r' });
    expect((await fs.stat('dump.sql')).size).toBe(20_000_000);
    expect(seen.some((s) => s.url.endsWith('/dump.sql'))).toBe(false);
  });

  it('the ceiling IS core’s SECRET_SCAN_MAX_BYTES from @factstack/spec (BFS2-2)', async () => {
    const { seen } = fakeGitHub({
      nodes: [
        { path: 'at.sql', body: 'select 1;\n', size: SECRET_SCAN_MAX_BYTES },
        { path: 'over.sql', body: 'select 2;\n', size: SECRET_SCAN_MAX_BYTES + 1 },
      ],
    });
    const fs = await fetchGitHubToMemory({ owner: 'o', repo: 'r' });
    expect(await fs.readText('at.sql')).toBe('select 1;\n');
    expect(fs.report.notDownloaded).toEqual(['over.sql']);
    expect(seen.some((s) => s.url.endsWith('/over.sql'))).toBe(false);
  });

  it('keeps a source file with a single NUL byte', async () => {
    const body = 'export const SEP = "\u0000";\n' + 'export const x = 1;\n'.repeat(40);
    fakeGitHub({ nodes: [{ path: 'src/util.ts', body }] });
    const fs = await fetchGitHubToMemory({ owner: 'o', repo: 'r' });
    expect(await fs.readText('src/util.ts')).toBe(body);
  });

  it('keeps a UTF-16 source file (the walker flags it binary-source) at its byte size', async () => {
    const utf16 = new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x3d, 0x00, 0x31, 0x00, 0x0a, 0x00]);
    fakeGitHub({ nodes: [{ path: 'src/wide.ts', body: utf16 }] });
    const fs = await fetchGitHubToMemory({ owner: 'o', repo: 'r' });
    expect((await fs.stat('src/wide.ts')).size).toBe(utf16.byteLength);
    expect((await fs.readText('src/wide.ts')).split('\u0000').length - 1).toBe(4);
  });
});

/* CVE decision 2026-09-24: the CVE scan grades the versions a lockfile
   installs. A GitHub scan that drops the lockfile falls back to declared
   ranges, so the same repo would grade differently than on the CLI (INV7).
   Core parses a lockfile only up to SECRET_SCAN_MAX_BYTES (on both hosts), so
   that is the download ceiling for lockfiles too (BFS2-1). */
describe('lockfiles are always fetched (CVE parity)', () => {
  /* One list, owned by spec: scanners parses LOCKFILE_NAMES and the GitHub
     fetch downloads exactly those, in the same order (BFS3-R1). */
  it("is spec's LOCKFILE_NAMES — the four lockfiles core parses", () => {
    expect([...GH_LOCKFILE_NAMES]).toEqual([...LOCKFILE_NAMES]);
    expect([...GH_LOCKFILE_NAMES]).toEqual([
      'pnpm-lock.yaml',
      'package-lock.json',
      'npm-shrinkwrap.json',
      'yarn.lock',
    ]);
  });

  it('fetches every lockfile at any depth, but not one inside an excluded dir', async () => {
    const { seen } = fakeGitHub({
      nodes: [
        { path: 'pnpm-lock.yaml', body: "lockfileVersion: '9.0'\n" },
        { path: 'apps/web/package-lock.json', body: '{"lockfileVersion":3}' },
        { path: 'tools/npm-shrinkwrap.json', body: '{"lockfileVersion":1}' },
        { path: 'site/yarn.lock', body: 'lodash@^4.17.0:\n  version "4.17.21"\n' },
        { path: 'node_modules/x/package-lock.json', body: '{}' },
      ],
    });
    const fs = await fetchGitHubToMemory({ owner: 'o', repo: 'r' });
    expect(await fs.readText('pnpm-lock.yaml')).toContain('9.0');
    expect(await fs.readText('apps/web/package-lock.json')).toContain('3');
    expect(await fs.readText('tools/npm-shrinkwrap.json')).toContain('1');
    expect(await fs.readText('site/yarn.lock')).toContain('4.17.21');
    expect(fs.report.totalFiles).toBe(4);
    expect(seen.some((s) => s.url.includes('node_modules'))).toBe(false);
  });

  it('fetches a lockfile up to the ceiling core parses to, and only lists a bigger one', async () => {
    const lock = "lockfileVersion: '9.0'\n";
    const { seen } = fakeGitHub({
      nodes: [
        { path: 'pnpm-lock.yaml', body: lock, size: SECRET_SCAN_MAX_BYTES },
        { path: 'huge/package-lock.json', body: '{}', size: SECRET_SCAN_MAX_BYTES + 1 },
      ],
    });
    const fs = await fetchGitHubToMemory({ owner: 'o', repo: 'r' });
    expect(await fs.readText('pnpm-lock.yaml')).toBe(lock);
    /* Core would not parse it (nor secret-scan it) on the CLI either: listed
       at its real size, never downloaded — so it cannot fail, cost memory, or
       count toward the failed-share refusal. */
    expect(fs.report.notDownloaded).toEqual(['huge/package-lock.json']);
    expect((await fs.stat('huge/package-lock.json')).size).toBe(SECRET_SCAN_MAX_BYTES + 1);
    expect(seen.some((s) => s.url.endsWith('/package-lock.json'))).toBe(false);
    expect(fs.report.failed).toEqual([]);
    expect(fs.report.warnings).toEqual([]);
  });

  it('fetches yarn.lock even if `.lock` were ever listed as never-text', async () => {
    /* spec's shared set: add only for this test, and never delete an entry
       spec itself has (BFS2-4). */
    const never = NEVER_TEXT_EXTENSIONS as Set<string>;
    const had = never.has('.lock');
    never.add('.lock');
    try {
      fakeGitHub({
        nodes: [
          { path: 'yarn.lock', body: 'lodash@^4.17.0:\n  version "4.17.21"\n' },
          { path: 'other.lock', body: 'x' },
        ],
      });
      const fs = await fetchGitHubToMemory({ owner: 'o', repo: 'r' });
      expect(await fs.readText('yarn.lock')).toContain('4.17.21');
      await expect(fs.readText('other.lock')).rejects.toThrow(); // filtered as usual
    } finally {
      if (!had) never.delete('.lock');
    }
  });
});

describe('BFS2-3 — stat() of a downloaded file does not re-encode it', () => {
  it('answers from the byte-size map, with the base class’s mtime', async () => {
    fakeGitHub({ nodes: [{ path: 'src/a.ts', body: 'export const a = 1;\n' }] });
    const fs = await fetchGitHubToMemory({ owner: 'o', repo: 'r' });
    const base = vi.spyOn(MemoryFS.prototype, 'stat');
    const s = await fs.stat('src/a.ts');
    expect(base).not.toHaveBeenCalled();
    expect(s).toMatchObject({ size: 20, isFile: true, isDirectory: false, isSymlink: false });

    // Directories and ENOENT still come from MemoryFS.
    expect((await fs.stat('src')).isDirectory).toBe(true);
    await expect(fs.stat('src/missing.ts')).rejects.toThrow(/ENOENT/);
    expect(base).toHaveBeenCalledTimes(2);
    base.mockRestore();
    // Same mtime the base class reports for that file.
    expect(s.mtimeMs).toBe((await MemoryFS.prototype.stat.call(fs, 'src/a.ts')).mtimeMs);
  });
});

describe('BFS-R1 — one leading BOM is not content, on every host', () => {
  const pkg = '{"dependencies":{"express":"^4.18.0"},"scripts":{"start":"node ."}}';
  const bom = [0xef, 0xbb, 0xbf];
  const pkgBytes = new Uint8Array([...bom, ...new TextEncoder().encode(pkg)]);
  const check = async (): Promise<void> => {
    fakeGitHub({
      nodes: [
        { path: 'package.json', body: pkgBytes },
        { path: 'twice.txt', body: new Uint8Array([...bom, ...bom, 0x61]) },
      ],
    });
    const fs = await fetchGitHubToMemory({ owner: 'o', repo: 'r' });
    expect(JSON.parse(await fs.readText('package.json')).scripts.start).toBe('node .');
    // Blob.text() / NodeFS strip exactly one: the second BOM is content.
    expect(await fs.readText('twice.txt')).toBe('﻿a');
    // Sizes and bytes stay raw.
    expect((await fs.stat('package.json')).size).toBe(pkgBytes.byteLength);
    expect(await fs.readFile('package.json')).toEqual(pkgBytes);
  };

  it('a BOM-saved package.json parses, and only the first BOM goes', check);

  it('does not rely on MemoryFS stripping it (fs-memory before 2026-09-24)', async () => {
    vi.spyOn(MemoryFS.prototype, 'readText').mockImplementation(async function (
      this: MemoryFS,
      p: string,
    ) {
      return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await this.readFile(p));
    });
    await check();
  });
});

describe('FSB-9 — every file comes from one immutable commit', () => {
  it('reads raw contents at the resolved commit SHA, not the branch name', async () => {
    const { seen } = fakeGitHub({ nodes: [{ path: 'a.ts', body: 'x' }] });
    const fs = await fetchGitHubToMemory({ owner: 'o', repo: 'r' });
    const raw = seen.filter((s) => s.url.includes('raw.githubusercontent.com'));
    expect(raw.map((s) => s.url)).toEqual([`https://raw.githubusercontent.com/o/r/${SHA}/a.ts`]);
    expect(fs.report.commit).toBe(SHA);
  });
});

describe('FSB-10 — symlinks are not files', () => {
  it('does not fetch a mode-120000 entry (the walker skips symlinks)', async () => {
    const { seen } = fakeGitHub({
      nodes: [
        { path: 'AGENTS.md', body: '# agents\n' },
        { path: 'CLAUDE.md', body: 'AGENTS.md', mode: '120000' },
      ],
    });
    const fs = await fetchGitHubToMemory({ owner: 'o', repo: 'r' });
    await expect(fs.readText('CLAUDE.md')).rejects.toThrow();
    expect(seen.some((s) => s.url.endsWith('/CLAUDE.md'))).toBe(false);
  });
});

describe('UI-14 / FSB-6 — branch names containing "/"', () => {
  it('parses every candidate ref from a /tree/ URL', () => {
    expect(parseRepoSpec('https://github.com/o/r/tree/feature/login-flow')).toEqual({
      owner: 'o',
      repo: 'r',
      ref: 'feature',
      refCandidates: ['feature', 'feature/login-flow'],
    });
  });

  it('never treats a /blob/ URL filename as part of the ref', () => {
    expect(
      parseRepoSpec('https://github.com/o/r/blob/release/v2.1/src/a.ts')?.refCandidates,
    ).toEqual(['release', 'release/v2.1', 'release/v2.1/src']);
    expect(parseRepoSpec('https://github.com/o/r/blob/main/a.ts')).toEqual({
      owner: 'o',
      repo: 'r',
      ref: 'main',
    });
  });

  it('scans the branch the URL names', async () => {
    const { seen } = fakeGitHub({
      nodes: [{ path: 'a.ts', body: 'x' }],
      refs: ['feature/login-flow'],
    });
    const spec = parseRepoSpec('https://github.com/o/r/tree/feature/login-flow')!;
    const fs = await fetchGitHubToMemory(spec);
    expect(await fs.readText('a.ts')).toBe('x');
    expect(fs.report.ref).toBe('feature/login-flow');
    // Listed by the resolved SHA, never by the first segment.
    expect(seen.some((s) => s.url.includes(`/git/trees/${SHA}?recursive=1`))).toBe(true);
    expect(seen.some((s) => s.url.includes('/git/trees/feature?'))).toBe(false);
  });

  it('a /tree/<branch>/<path> link costs one lookup', async () => {
    const { seen } = fakeGitHub({ nodes: [{ path: 'a.ts', body: 'x' }] });
    const fs = await fetchGitHubToMemory(
      parseRepoSpec('https://github.com/o/r/tree/main/src/lib')!,
    );
    expect(fs.report.ref).toBe('main');
    expect(lookups(seen)).toBe(1);
  });

  /* BFS-R3: git's D/F rule holds only within one namespace, so a tag
     `release` and a branch `release/v2` can coexist — and /commits/release
     resolves the tag. */
  it('a tag named like the first segment does not shadow a slash branch', async () => {
    fakeGitHub({ nodes: [{ path: 'a.ts', body: 'x' }], refs: ['release/v2'], tags: ['release'] });
    const fs = await fetchGitHubToMemory(parseRepoSpec('https://github.com/o/r/tree/release/v2')!);
    expect(fs.report.ref).toBe('release/v2');
    expect(fs.report.commit).toBe(SHA);
  });

  it('falls back to a tag when no candidate is a branch', async () => {
    fakeGitHub({ nodes: [{ path: 'a.ts', body: 'x' }], tags: ['v1.0'] });
    const fs = await fetchGitHubToMemory(parseRepoSpec('https://github.com/o/r/tree/v1.0/src')!);
    expect(fs.report.ref).toBe('v1.0');
    expect(fs.report.commit).toBe(TAG_SHA);
  });

  it('a permalink (/blob/<sha>/…) needs no lookup', async () => {
    const { seen } = fakeGitHub({ nodes: [{ path: 'src/a.ts', body: 'x' }] });
    const fs = await fetchGitHubToMemory(
      parseRepoSpec(`https://github.com/o/r/blob/${SHA}/src/a.ts`)!,
    );
    expect(fs.report.commit).toBe(SHA);
    expect(lookups(seen)).toBe(0);
  });

  it('a hidden repo fails after one lookup, without blaming a ref', async () => {
    const { seen } = fakeGitHub({ nodes: [{ path: 'src/a.ts', body: 'x' }], hidden: true });
    const err = await fetchGitHubToMemory(
      parseRepoSpec('https://github.com/o/r/blob/main/src/deep/a.ts')!,
    ).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/not found or private/);
    expect((err as Error).message).not.toMatch(/main\/src/);
    expect(lookups(seen)).toBe(1);
  });

  it('names the missing ref instead of only suggesting a PAT', async () => {
    fakeGitHub({ nodes: [{ path: 'a.ts', body: 'x' }] });
    const spec = parseRepoSpec('https://github.com/o/r/tree/nope/deeper')!;
    const err = (await fetchGitHubToMemory(spec).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/"nope\/deeper".*owner\/repo@branch/);
    // The repo answered, so it is not private: no PAT red herring.
    expect(err.message).not.toMatch(/private|PAT/);
  });
});
