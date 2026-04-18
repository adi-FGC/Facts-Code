/**
 * In-memory FactsFS for tests and fixture-driven CI. Purely isomorphic —
 * doesn't import Node built-ins.
 *
 * Usage:
 *   const fs = new MemoryFS({
 *     'src/foo.ts': 'export const x = 1',
 *     'src/bar/baz.py': 'print("hi")',
 *   });
 */

import type { Dirent, FactsFS, Stats } from '@factstack/spec';

type Entry = { kind: 'file'; text: string; mtime: number } | { kind: 'dir' };

export class MemoryFS implements FactsFS {
  private readonly entries = new Map<string, Entry>();

  constructor(files: Record<string, string> = {}, now: number = Date.now()) {
    for (const [rawPath, text] of Object.entries(files)) {
      const p = this.normalize(rawPath);
      this.entries.set(p, { kind: 'file', text, mtime: now });
      // Ensure every parent directory is registered
      const parts = p.split('/').filter(Boolean);
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/');
        if (!this.entries.has(dir)) this.entries.set(dir, { kind: 'dir' });
      }
    }
    this.entries.set('.', { kind: 'dir' });
  }

  private encode(s: string): Uint8Array {
    return new TextEncoder().encode(s);
  }

  async readFile(p: string): Promise<Uint8Array> {
    const e = this.entries.get(this.normalize(p));
    if (!e || e.kind !== 'file') throw new Error(`ENOENT: ${p}`);
    return this.encode(e.text);
  }

  async readText(p: string): Promise<string> {
    const e = this.entries.get(this.normalize(p));
    if (!e || e.kind !== 'file') throw new Error(`ENOENT: ${p}`);
    return e.text;
  }

  async *readDir(p: string): AsyncIterable<Dirent> {
    const normP = this.normalize(p);
    const prefix = normP === '.' ? '' : normP + '/';
    const yielded = new Set<string>();
    for (const [entryPath, entry] of this.entries) {
      if (!entryPath.startsWith(prefix) || entryPath === normP) continue;
      const rest = entryPath.slice(prefix.length);
      const next = rest.split('/')[0];
      if (!next || yielded.has(next)) continue;
      yielded.add(next);
      const childPath = prefix + next;
      const childEntry = this.entries.get(childPath);
      const isDir = childEntry?.kind === 'dir' || rest.includes('/');
      yield {
        name: next,
        path: childPath,
        isFile: !isDir,
        isDirectory: isDir,
        isSymlink: false,
      };
    }
  }

  async stat(p: string): Promise<Stats> {
    const e = this.entries.get(this.normalize(p));
    if (!e) throw new Error(`ENOENT: ${p}`);
    if (e.kind === 'file') {
      const bytes = this.encode(e.text).byteLength;
      return {
        size: bytes,
        mtimeMs: e.mtime,
        ctimeMs: e.mtime,
        isFile: true,
        isDirectory: false,
        isSymlink: false,
      };
    }
    return { size: 0, mtimeMs: 0, ctimeMs: 0, isFile: false, isDirectory: true, isSymlink: false };
  }

  async readlink(): Promise<string | null> {
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

export function memoryFS(files: Record<string, string>): FactsFS {
  return new MemoryFS(files);
}
