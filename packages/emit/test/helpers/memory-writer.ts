/**
 * `MemoryFileWriter` — in-memory `FileWriter` implementation for
 * orchestrator unit tests.
 *
 * Mirrors `MemoryFS` (`packages/fs-memory/`) at the write tier.
 * Stores every writeText as a string-keyed entry; listKeys filters
 * to a directory prefix; removeEntry deletes by key.
 *
 * Why this lives in `packages/emit/test/helpers/` rather than a new
 * `packages/file-writer-memory/` package: today only the orchestrator
 * tests need it. When `@factstack/emit-browser` gains tests (likely
 * with the SequenceDiagram interactivity work), promoting to a
 * shared package is a 5-minute copy. YAGNI on the boundary today.
 *
 * Test ergonomics: every method returns a Promise to match the
 * `FileWriter` contract, but the underlying ops are sync. That makes
 * assertions like `expect(writer.files.get('agent.json')).toBe(...)`
 * trivial — no `await` needed for inspection.
 */

import type { FileWriter } from '@factstack/spec';

export class MemoryFileWriter implements FileWriter {
  /** path → body. Use a Map so insertion order survives for
   *  list-keys-style tests that care about write ordering. */
  readonly files = new Map<string, string>();

  async writeText(p: string, body: string): Promise<number> {
    /* Normalize: callers might pass `./agent.json` or `agent.json` —
       canonicalize so listKeys/removeEntry comparisons line up. */
    this.files.set(this.normalize(p), body);
    /* Use the same byte-count formula adapters do: UTF-8 byte length. */
    return new TextEncoder().encode(body).byteLength;
  }

  async listKeys(dir: string): Promise<string[]> {
    const normDir = this.normalize(dir);
    const prefix = normDir === '' ? '' : `${normDir}/`;
    const out: string[] = [];
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      /* Only IMMEDIATE children. `snapshots/X.json` IS a child of
         `snapshots`; `snapshots/sub/X.json` is not. */
      if (rest.includes('/')) continue;
      out.push(rest);
    }
    return out;
  }

  async removeEntry(dir: string, name: string): Promise<void> {
    const key = this.normalize(`${dir}/${name}`);
    /* Idempotent on missing — matches the NodeFileWriter +
       FsaFileWriter contracts. */
    this.files.delete(key);
  }

  /**
   * Strip leading `./`, collapse `//`, trim trailing slashes. Same
   * normalization Node/FSA adapters do implicitly via their resolve
   * methods — we mirror it so test assertions on `.files` keys are
   * predictable.
   */
  private normalize(p: string): string {
    return p.replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/+$/, '');
  }

  /* ─────────── test-only conveniences ─────────── */

  /** Check whether a file was written to this in-memory store. */
  has(p: string): boolean {
    return this.files.has(this.normalize(p));
  }

  /** Read back a written file (synchronously — no Promise wrapping). */
  get(p: string): string | undefined {
    return this.files.get(this.normalize(p));
  }

  /** Total bytes across every stored file, for parity with
   *  WriteArtifactsResult.bytesWritten when summed. */
  totalBytes(): number {
    let total = 0;
    for (const body of this.files.values()) {
      total += new TextEncoder().encode(body).byteLength;
    }
    return total;
  }
}
