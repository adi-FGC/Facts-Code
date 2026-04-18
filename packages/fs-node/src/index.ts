/**
 * Node.js implementation of the FactsFS interface from @factstack/spec.
 *
 * This is the ONLY package (alongside @factstack/emit and apps/cli) that
 * is allowed to import node:fs. The ESLint boundary rule in the repo root
 * enforces that — packages/core and its isomorphic dependency tree get a
 * lint error if they reach for node:* modules.
 *
 * The surface area is deliberately small so a browser-backed FactsFS
 * (filesystem-access-api or github-rest) in v0.4 can ship as a peer.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Dirent, FactsFS, Stats } from '@factstack/spec';

export class NodeFS implements FactsFS {
  constructor(private readonly root: string) {}

  /** Resolve a FactsFS path (always POSIX) to an absolute OS path. */
  private abs(p: string): string {
    const normalised = p.replace(/\\/g, '/');
    return path.isAbsolute(normalised) ? normalised : path.join(this.root, normalised);
  }

  async readFile(p: string): Promise<Uint8Array> {
    return new Uint8Array(await fs.readFile(this.abs(p)));
  }

  async readText(p: string): Promise<string> {
    return fs.readFile(this.abs(p), 'utf8');
  }

  async *readDir(p: string): AsyncIterable<Dirent> {
    const entries = await fs.readdir(this.abs(p), { withFileTypes: true });
    for (const e of entries) {
      const relPath = path.posix.join(this.normalize(p), e.name);
      yield {
        name: e.name,
        path: relPath,
        isFile: e.isFile(),
        isDirectory: e.isDirectory(),
        isSymlink: e.isSymbolicLink(),
      };
    }
  }

  async stat(p: string): Promise<Stats> {
    const s = await fs.lstat(this.abs(p));
    return {
      size: s.size,
      mtimeMs: s.mtimeMs,
      ctimeMs: s.ctimeMs,
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      isSymlink: s.isSymbolicLink(),
    };
  }

  async readlink(p: string): Promise<string | null> {
    try {
      const target = await fs.readlink(this.abs(p));
      return target.replace(/\\/g, '/');
    } catch {
      return null;
    }
  }

  normalize(p: string): string {
    // POSIX form, no trailing slash, no `./` prefix.
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

export function nodeFS(root: string): FactsFS {
  // Tolerate file:// URLs for programmatic use
  const absolute = root.startsWith('file://') ? fileURLToPath(root) : path.resolve(root);
  return new NodeFS(absolute);
}

export { pathToFileURL };
