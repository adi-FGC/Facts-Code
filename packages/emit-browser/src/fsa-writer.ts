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
    /* Encode once: we need the byte count three times (write payload,
       truncate target, verification expected-size) and the cost of
       re-encoding a JSON blob 3x is silly. */
    const bytes = new TextEncoder().encode(body);
    const byteLength = bytes.byteLength;

    const handle = await dir.getFileHandle(name, { create: true });
    /* Explicit `keepExistingData: false` — every writeText is a full
       replace, never a delta. The default is false, but being explicit
       clarifies intent and matches the FileWriter contract. */
    const writable = await handle.createWritable({ keepExistingData: false });
    try {
      /* Write as BufferSource (Uint8Array) instead of string. The FSA
         spec allows both, but WebKit's pre-17.x Safari and some FSA
         polyfills shipped with bugs where the string form silently
         wrote 0 bytes or partial bytes on macOS. BufferSource is the
         universally-tested path — Chrome, Firefox, Safari 17+, every
         FSA polyfill we've checked accepts it without quirks. */
      await writable.write(bytes);
      /* Explicit truncate to the expected byte length defends against
         a known WebKit/Safari bug where close() resolves before the
         data fully flushes when the file was opened in replace mode
         without an explicit truncate — leaving a 0-byte file on disk
         even though every promise resolved successfully. Forcing the
         size here makes the implementation commit. */
      await writable.truncate(byteLength);
    } finally {
      /* Always close — leaving a writable open holds the file lock
         and the next write attempt throws NoModificationAllowedError.
         The Node adapter doesn't have to think about this because
         fs.writeFile closes its own descriptor; FSA makes the
         lifecycle explicit. */
      await writable.close();
    }

    /* Post-write verification. The previous flow trusted that
       successful close() meant bytes hit disk, but three macOS-specific
       failure modes silently violate that assumption:
         1. iCloud Drive "Optimize Mac Storage" (offline-only) folders
            accept writes via FSA but never sync them locally — Finder
            shows no file even though the FSA layer reported success.
         2. Chrome 122+ on macOS sometimes returns `'granted'` from
            requestPermission but writes still no-op because the
            underlying macOS sandbox capability wasn't transferred.
         3. WebKit's close-without-truncate bug (pre-17.x Safari)
            occasionally left 0-byte files.
       Re-open the file and check the size. If it doesn't match, the
       write silently failed — throw a descriptive error pointing at
       the likely cause so the user can recover (try a different
       folder, exit iCloud sandbox, retry the permission). */
    let verifiedSize: number;
    try {
      const verifyHandle = await dir.getFileHandle(name);
      const file = await verifyHandle.getFile();
      verifiedSize = file.size;
    } catch (err) {
      throw new Error(
        `Write verification could not re-read "${p}": ${err instanceof Error ? err.message : String(err)}. ` +
        `The write may have silently failed. If the destination folder is inside iCloud Drive, ` +
        `try saving to a local folder (e.g., your home directory) instead.`,
      );
    }
    if (verifiedSize !== byteLength) {
      throw new Error(
        `Write verification failed for "${p}": expected ${byteLength} bytes on disk, ` +
        `found ${verifiedSize}. The destination directory may be inside iCloud Drive ` +
        `with offline-only sync, or the browser's File System Access write permission ` +
        `was silently denied. Try picking a folder under your home directory that's NOT ` +
        `in iCloud Drive, Documents, or Downloads.`,
      );
    }

    return byteLength;
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
