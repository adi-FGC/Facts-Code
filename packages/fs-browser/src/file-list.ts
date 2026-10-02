/**
 * `FileListFS` — FactsFS over the `File` objects an
 * `<input type="file" webkitdirectory>` pick yields.
 *
 * The folder-input path used to read every picked file up front with
 * `file.text()` into a MemoryFS. Two parity bugs followed (INV7):
 *   - stat() reported the re-encoded length of the DECODED string, so every
 *     invalid UTF-8 byte of a binary became a 3-byte U+FFFD — a 600 KB PNG
 *     "grew" past the walker's 1 MB cap and picked up a false
 *     `file-size-cap` risk, and every size/treemap total was wrong.
 *   - node_modules, .git and every other excluded tree was read into memory
 *     before the walker could skip it.
 * This adapter is lazy like FsaBrowserFS: stat() is the File's real byte
 * size, and bytes are read only when the walker (or core's secret pass)
 * asks for them — exactly the reads NodeFS would do.
 *
 * Decoding is `Blob.text()`, as in FsaBrowserFS: UTF-8 with replacement
 * characters and ONE leading BOM stripped — what NodeFS and MemoryFS return
 * too, so a BOM-saved package.json still parses (INV7).
 *
 * Constraint C1 (isomorphic): DOM types only, never node:*.
 */

import type { Dirent, FactsFS, Stats } from '@factstack/spec';

export interface FileListEntry {
  /** Path relative to the picked folder, forward slashes. */
  path: string;
  file: File;
}

export class FileListFS implements FactsFS {
  private readonly files = new Map<string, File>();
  /** Directory path → child names, built once from the flat file list. */
  private readonly dirs = new Map<string, Set<string>>([['.', new Set()]]);

  constructor(entries: Iterable<FileListEntry>) {
    for (const { path, file } of entries) {
      const p = this.normalize(path);
      if (p === '.') continue;
      this.files.set(p, file);
      const parts = p.split('/');
      let parent = '.';
      for (let i = 0; i < parts.length; i++) {
        this.dirs.get(parent)!.add(parts[i]!);
        if (i === parts.length - 1) break;
        const dir = parts.slice(0, i + 1).join('/');
        if (!this.dirs.has(dir)) this.dirs.set(dir, new Set());
        parent = dir;
      }
    }
  }

  private file(p: string): File {
    const f = this.files.get(this.normalize(p));
    if (!f) throw new Error(`ENOENT: ${p}`);
    return f;
  }

  async readFile(p: string): Promise<Uint8Array> {
    return new Uint8Array(await this.file(p).arrayBuffer());
  }

  async readText(p: string): Promise<string> {
    return this.file(p).text();
  }

  async *readDir(p: string): AsyncIterable<Dirent> {
    const dir = this.normalize(p);
    const children = this.dirs.get(dir);
    if (!children) throw new Error(`ENOTDIR: ${p}`);
    for (const name of children) {
      const path = dir === '.' ? name : `${dir}/${name}`;
      const isDirectory = this.dirs.has(path);
      yield { name, path, isFile: !isDirectory, isDirectory, isSymlink: false };
    }
  }

  async stat(p: string): Promise<Stats> {
    const n = this.normalize(p);
    const f = this.files.get(n);
    if (f) {
      return {
        size: f.size,
        mtimeMs: f.lastModified,
        ctimeMs: f.lastModified,
        isFile: true,
        isDirectory: false,
        isSymlink: false,
      };
    }
    if (this.dirs.has(n)) {
      return {
        size: 0,
        mtimeMs: 0,
        ctimeMs: 0,
        isFile: false,
        isDirectory: true,
        isSymlink: false,
      };
    }
    throw new Error(`ENOENT: ${p}`);
  }

  async readlink(): Promise<string | null> {
    /* A file input exposes no symlinks (the browser resolves them). */
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
