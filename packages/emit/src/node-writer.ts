/**
 * `NodeFileWriter` — `FileWriter` implementation backed by `node:fs/promises`.
 *
 * Scopes itself to `<root>/.facts/` — all relative paths the
 * orchestrator passes (`agent.json`, `snapshots/X.json`) land inside
 * that directory. Auto-mkdirp's parent dirs on every write.
 *
 * Used by the CLI via the `writeArtifacts` Node shim
 * (`packages/emit/src/write.ts`). Not exported from the top-level
 * package surface today — callers go through the shim — but available
 * to anyone who wants the orchestrator with Node FS semantics directly.
 *
 * The Node-only `node:*` import is the reason this file lives in the
 * (non-pure) `packages/emit/src/`. Browser callers use `FsaFileWriter`
 * from `@factstack/emit-browser` instead; both implement the same
 * `FileWriter` interface from `@factstack/spec`.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileWriter } from '@factstack/spec';

export class NodeFileWriter implements FileWriter {
  /** Absolute path of the artifact root (typically `<project>/.facts/`). */
  private readonly root: string;

  /**
   * @param projectRoot Project root directory.
   * @param subdir Optional subdirectory under `projectRoot` to scope
   *   the writer to. Defaults to `.facts` — every existing caller
   *   relies on that. Pass `''` to write directly at the project root
   *   (used by `factstack export-skills`, which lands files like
   *   `.cursorrules`, `.claude/skills/...`, `.github/...` next to
   *   `package.json`, not under `.facts/`).
   */
  constructor(projectRoot: string, subdir: string = '.facts') {
    this.root = subdir === '' ? projectRoot : path.join(projectRoot, subdir);
  }

  /** Resolve a writer-relative path to an absolute filesystem path.
   *
   *  Defends against path escape: a renderer-supplied path containing
   *  `..` segments could otherwise resolve outside `this.root` (e.g.
   *  `../../etc/passwd`). The three currently-shipping skill renderers
   *  emit only hardcoded safe paths, but the orchestrator's registry
   *  is open-ended — future renderers shouldn't be able to silently
   *  escape the project root. Throw early instead. */
  private resolve(p: string): string {
    /* Normalize forward slashes from the orchestrator to host
       separators. node:path.join does this automatically + collapses
       `..` segments before we check containment. */
    const abs = path.join(this.root, ...p.split('/'));
    /* Containment check: the resolved path must be `this.root` itself
       or a descendant of it. `path.relative` returning an empty string
       means same path; otherwise it must not start with `..` and must
       not be absolute (which on Windows means a different drive). */
    const rel = path.relative(this.root, abs);
    if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) {
      throw new Error(
        `NodeFileWriter: path escape detected: "${p}" resolves outside the writer root.`,
      );
    }
    return abs;
  }

  async writeText(p: string, body: string): Promise<number> {
    const full = this.resolve(p);
    /* Auto-mkdirp parent. fs.mkdir with recursive:true is a no-op
       when the directory already exists, so we don't pay anything
       extra after the first write per directory. */
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body);
    /* Buffer.byteLength gives UTF-8 length, matching what writeFile
       actually wrote. We compute here rather than statting the file
       to avoid a second syscall per write. */
    return Buffer.byteLength(body);
  }

  async listKeys(dir: string): Promise<string[]> {
    const full = this.resolve(dir);
    try {
      return await fs.readdir(full);
    } catch (err) {
      /* "Directory doesn't exist yet" is the only expected error
         here — the orchestrator calls listKeys('snapshots') on a
         fresh project before any snapshot has been written. Other
         errors (permission denied, I/O error) are still real bugs
         and should propagate. */
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      throw err;
    }
  }

  async removeEntry(dir: string, name: string): Promise<void> {
    const full = this.resolve(`${dir}/${name}`);
    try {
      await fs.unlink(full);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      /* removeEntry is contractually idempotent — missing file is
         a no-op, not an error. The orchestrator's retention prune
         races with parallel runs in theory; missing entries are
         normal. */
      if (code === 'ENOENT') return;
      throw err;
    }
  }

  /** Expose the scoped root for callers (like the Node shim) that
   *  need to resolve names returned by the orchestrator into
   *  absolute paths for their summary output. */
  get artifactRoot(): string {
    return this.root;
  }
}

