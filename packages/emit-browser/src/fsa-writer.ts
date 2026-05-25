/**
 * `FsaFileWriter` — `FileWriter` implementation backed by the
 * File System Access API.
 *
 * Scopes itself to `<userPickedDir>/.facts/` — the user picks the
 * outer directory via `showDirectoryPicker({ mode: 'readwrite' })`,
 * and the adapter creates + writes inside `.facts/` internally.
 *
 * Auto-mkdirp: every writeText resolves the path to a sequence of
 * `getDirectoryHandle({create:true})` calls. For `snapshots/X.json`
 * that's one extra handle lookup per write — negligible.
 *
 * Used by the in-browser scanner via the `writeBrowserArtifacts`
 * shim. Implements the same `FileWriter` interface as
 * `NodeFileWriter` so the isomorphic orchestrator in
 * `@factstack/emit/pure` works against either tier unchanged.
 *
 * Constraint C1 (isomorphic): this file imports DOM types but
 * NEVER `node:*`. Safe to bundle into browser + Worker.
 */

import type { FileWriter } from '@factstack/spec';

export class FsaFileWriter implements FileWriter {
  /**
   * Root handle for the artifact directory (the `.facts/` inside
   * whatever the user picked). Looked up lazily on first write so
   * the user gesture that constructed this writer doesn't have to
   * await anything.
   */
  private factsDirPromise: Promise<FileSystemDirectoryHandle> | null = null;

  /**
   * @param userRoot The directory the user picked via
   *   showDirectoryPicker. The writer creates `.facts/` inside it
   *   on first write.
   */
  constructor(private readonly userRoot: FileSystemDirectoryHandle) {}

  /** Lazy single-shot lookup of `.facts/` inside the user's pick. */
  private factsDir(): Promise<FileSystemDirectoryHandle> {
    if (!this.factsDirPromise) {
      this.factsDirPromise = this.userRoot.getDirectoryHandle('.facts', { create: true });
    }
    return this.factsDirPromise;
  }

  /**
   * Walk a writer-relative path to its parent directory handle,
   * creating intermediate dirs as needed (mkdirp semantics).
   * Returns the final directory + the leaf name.
   *
   *   resolveDirAndName('agent.json')        → ['.facts', 'agent.json']
   *   resolveDirAndName('snapshots/X.json')  → ['.facts/snapshots', 'X.json']
   */
  private async resolveDirAndName(p: string): Promise<[FileSystemDirectoryHandle, string]> {
    const parts = p.split('/');
    const leaf = parts.pop()!;
    let dir = await this.factsDir();
    for (const segment of parts) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }
    return [dir, leaf];
  }

  async writeText(p: string, body: string): Promise<number> {
    const [dir, name] = await this.resolveDirAndName(p);
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(body);
    } finally {
      /* Always close — leaving a writable open holds the file lock
         and the next write attempt throws NoModificationAllowedError.
         The Node adapter doesn't have to think about this because
         fs.writeFile closes its own descriptor; FSA makes the
         lifecycle explicit. */
      await writable.close();
    }
    return new TextEncoder().encode(body).byteLength;
  }

  async listKeys(dir: string): Promise<string[]> {
    let target: FileSystemDirectoryHandle;
    try {
      target = await this.walkToDir(dir, { create: false });
    } catch {
      /* "Directory doesn't exist yet" — orchestrator calls
         listKeys('snapshots') on a fresh project before any
         snapshot has been written. Same contract as NodeFileWriter:
         return empty rather than throw. */
      return [];
    }
    const out: string[] = [];
    /* FSA's async iteration over `.keys()` isn't on the standard
       FileSystemDirectoryHandle type yet — cast to a permissive
       shape rather than pulling in the wicg-file-system-access
       shim package. */
    const iter = (target as unknown as { keys: () => AsyncIterableIterator<string> }).keys();
    for await (const name of iter) out.push(name);
    return out;
  }

  async removeEntry(dir: string, name: string): Promise<void> {
    let target: FileSystemDirectoryHandle;
    try {
      target = await this.walkToDir(dir, { create: false });
    } catch {
      return; // idempotent: missing dir → nothing to remove
    }
    try {
      await target.removeEntry(name);
    } catch {
      /* Idempotent on missing entry. Other errors (permission
         denied) are swallowed too — retention pruning isn't
         load-bearing and a noisy failure here would mask the
         actually-important write that just completed. */
    }
  }

  /**
   * Internal: walk a relative dir path to a directory handle.
   * Used by listKeys + removeEntry (which want to traverse without
   * creating intermediate dirs).
   */
  private async walkToDir(
    p: string,
    opts: { create: boolean },
  ): Promise<FileSystemDirectoryHandle> {
    const parts = p.split('/').filter(Boolean);
    let cursor = await this.factsDir();
    for (const segment of parts) {
      cursor = await cursor.getDirectoryHandle(segment, { create: opts.create });
    }
    return cursor;
  }
}

/** Convenience factory mirroring `nodeFileWriter(...)` / `memoryFS(...)`. */
export function fsaFileWriter(userRoot: FileSystemDirectoryHandle): FsaFileWriter {
  return new FsaFileWriter(userRoot);
}
