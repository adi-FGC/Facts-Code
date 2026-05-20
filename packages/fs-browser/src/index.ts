/**
 * @factstack/fs-browser — browser implementations of FactsFS.
 *
 * Two paths:
 *   - `FsaBrowserFS` wraps a `FileSystemDirectoryHandle` from the
 *     File System Access API for local-directory scans.
 *   - `fetchGitHubToMemory` (in ./github.ts) pulls a public GitHub
 *     repo via the Trees API + raw.githubusercontent.com and packs
 *     it into a MemoryFS the analyzer can read.
 *
 * Why two implementations:
 *   - FSA is a real handle to disk, lazy-read per file, supports
 *     write-back via FileSystemWritableFileStream.
 *   - GitHub fetch returns bytes from the network; MemoryFS is the
 *     simplest place to materialize them once + walk recursively.
 *
 * Constraint C1 (isomorphic): this package imports DOM types but
 * NEVER node:* anything. Safe to bundle into browser + Worker.
 */

import type { Dirent, FactsFS, Stats } from '@factstack/spec';

export class FsaBrowserFS implements FactsFS {
  /**
   * Cache of "directory path → handle" so we don't re-walk from the
   * root for every file read. Built lazily as `readDir` traverses.
   * Files cache the resolved handle too so consecutive `stat` +
   * `readText` against the same path don't pay double traversal.
   */
  private readonly dirCache = new Map<string, FileSystemDirectoryHandle>();
  private readonly fileCache = new Map<string, FileSystemFileHandle>();

  constructor(private readonly root: FileSystemDirectoryHandle) {
    /* The root path is canonically '.' in FactsFS terms — every
       in-project path is relative to it. */
    this.dirCache.set('.', root);
  }

  /**
   * Walk the FSA handle tree from the root to a given path and
   * return either a directory or file handle. Throws if the path
   * doesn't exist. Caches as it goes.
   */
  private async resolve(rawPath: string): Promise<{ kind: 'dir' | 'file'; handle: FileSystemHandle }> {
    const p = this.normalize(rawPath);
    if (p === '.') return { kind: 'dir', handle: this.root };

    const cachedFile = this.fileCache.get(p);
    if (cachedFile) return { kind: 'file', handle: cachedFile };
    const cachedDir = this.dirCache.get(p);
    if (cachedDir) return { kind: 'dir', handle: cachedDir };

    /* Walk segment-by-segment. The FSA API only lets us ask the
       parent directory for a child; there's no `getHandleByPath`
       primitive. Use the longest cached prefix as a starting point
       to avoid re-walking the whole chain on hot paths. */
    const parts = p.split('/');
    let prefix = '';
    let cursor: FileSystemDirectoryHandle = this.root;
    /* Find the deepest cached ancestor. */
    for (let i = parts.length - 1; i > 0; i--) {
      const candidate = parts.slice(0, i).join('/');
      const cached = this.dirCache.get(candidate);
      if (cached) { cursor = cached; prefix = candidate; break; }
    }
    const remaining = prefix ? parts.slice(prefix.split('/').length) : parts;

    for (let i = 0; i < remaining.length; i++) {
      const seg = remaining[i]!;
      const isLast = i === remaining.length - 1;
      let next: FileSystemHandle;
      try {
        if (isLast) {
          /* On the last segment we don't know whether it's a file
             or a directory. Try directory first (cheap), fall back
             to file. The two getXHandle calls throw NotFoundError
             with distinct kinds so we discriminate cleanly. */
          try {
            next = await cursor.getDirectoryHandle(seg);
          } catch {
            next = await cursor.getFileHandle(seg);
          }
        } else {
          next = await cursor.getDirectoryHandle(seg);
        }
      } catch (err) {
        const e = new Error(`ENOENT: ${p}`);
        (e as { cause?: unknown }).cause = err;
        throw e;
      }
      const segPath = prefix ? `${prefix}/${seg}` : seg;
      if (next.kind === 'directory') {
        this.dirCache.set(segPath, next as FileSystemDirectoryHandle);
        cursor = next as FileSystemDirectoryHandle;
      } else {
        this.fileCache.set(segPath, next as FileSystemFileHandle);
        return { kind: 'file', handle: next };
      }
      prefix = segPath;
    }
    return { kind: 'dir', handle: cursor };
  }

  async readFile(p: string): Promise<Uint8Array> {
    const { kind, handle } = await this.resolve(p);
    if (kind !== 'file') throw new Error(`EISDIR: ${p}`);
    const file = await (handle as FileSystemFileHandle).getFile();
    const buf = await file.arrayBuffer();
    return new Uint8Array(buf);
  }

  async readText(p: string): Promise<string> {
    const { kind, handle } = await this.resolve(p);
    if (kind !== 'file') throw new Error(`EISDIR: ${p}`);
    const file = await (handle as FileSystemFileHandle).getFile();
    return file.text();
  }

  async *readDir(p: string): AsyncIterable<Dirent> {
    const { kind, handle } = await this.resolve(p);
    if (kind !== 'dir') throw new Error(`ENOTDIR: ${p}`);
    const dir = handle as FileSystemDirectoryHandle;
    const normP = this.normalize(p);
    /* `entries()` is the asynchronous iterator that walks immediate
       children. Each yields `[name, FileSystemHandle]`. Cache as we
       go so subsequent resolve() calls have less work. */
    for await (const [name, child] of (dir as unknown as { entries: () => AsyncIterableIterator<[string, FileSystemHandle]> }).entries()) {
      const childPath = normP === '.' ? name : `${normP}/${name}`;
      if (child.kind === 'directory') {
        this.dirCache.set(childPath, child as FileSystemDirectoryHandle);
      } else {
        this.fileCache.set(childPath, child as FileSystemFileHandle);
      }
      yield {
        name,
        path: childPath,
        isFile: child.kind === 'file',
        isDirectory: child.kind === 'directory',
        isSymlink: false, // FSA exposes no symlink distinction
      };
    }
  }

  async stat(p: string): Promise<Stats> {
    const { kind, handle } = await this.resolve(p);
    if (kind === 'file') {
      const file = await (handle as FileSystemFileHandle).getFile();
      return {
        size: file.size,
        mtimeMs: file.lastModified,
        /* FSA doesn't expose ctime; mirror mtime so consumers that
           read either field get sensible values. */
        ctimeMs: file.lastModified,
        isFile: true,
        isDirectory: false,
        isSymlink: false,
      };
    }
    return {
      size: 0,
      mtimeMs: 0,
      ctimeMs: 0,
      isFile: false,
      isDirectory: true,
      isSymlink: false,
    };
  }

  async readlink(): Promise<string | null> {
    /* FSA has no symlink concept. Always null — the walker treats
       null as "not a symlink" and proceeds without loop detection
       on the FSA path. Loops aren't possible anyway because FSA
       doesn't surface symlinks. */
    return null;
  }

  normalize(p: string): string {
    const n = p.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\.\//, '');
    return n === '' ? '.' : n;
  }

  join(...segments: string[]): string {
    return segments
      .filter(Boolean)
      .map((s) => s.replace(/\\/g, '/'))
      .join('/')
      .replace(/\/+/g, '/');
  }
}

/** Convenience factory mirroring `nodeFS()` / `memoryFS()`. */
export function fsaBrowserFS(handle: FileSystemDirectoryHandle): FactsFS {
  return new FsaBrowserFS(handle);
}

/* Re-export the GitHub-fetch entry so callers can grab both surfaces
 * from one import line. */
export {
  fetchGitHubToMemory,
  parseRepoSpec,
  ghFriendlyError,
  GH_TEXT_EXTS,
  GH_EXCLUDE_DIRS,
  GH_FETCH_CONCURRENCY,
  type GitHubFetchSpec,
  type FetchProgress,
} from './github.js';
