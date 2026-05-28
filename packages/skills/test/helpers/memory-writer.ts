/**
 * Test-only in-memory `FileWriter` implementation.
 *
 * KNOWN DUPLICATION: byte-identical to `packages/emit/test/helpers/memory-writer.ts`.
 * The "one adapter ⇒ hypothetical seam, two adapters ⇒ real seam"
 * principle in CONTEXT.md says we should extract now. We're DEFERRING
 * that extraction deliberately for one reason:
 *
 *   - Both copies are test-only (~30 LOC); the cross-package test
 *     dependency makes `pnpm -F` workflows noisier than the dedup
 *     saves in maintenance cost. A bug fix here doesn't silently
 *     break consumers — it breaks one test file we own.
 *
 * Promotion trigger: as soon as a THIRD consumer needs this writer
 * (likely candidates: @factstack/factspack, a future @factstack/mcp
 * integration test surface), extract to `@factstack/file-writer-memory`
 * — same pattern as `@factstack/fs-memory` did at the read tier.
 * Until then, keep them in sync by hand on the rare occasion one
 * changes.
 */

import type { FileWriter } from '@factstack/spec';

export class MemoryFileWriter implements FileWriter {
  readonly files = new Map<string, string>();

  async writeText(p: string, body: string): Promise<number> {
    this.files.set(this.normalize(p), body);
    return new TextEncoder().encode(body).byteLength;
  }

  async listKeys(dir: string): Promise<string[]> {
    const normDir = this.normalize(dir);
    const prefix = normDir === '' ? '' : `${normDir}/`;
    const out: string[] = [];
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest.includes('/')) continue;
      out.push(rest);
    }
    return out;
  }

  async removeEntry(dir: string, name: string): Promise<void> {
    this.files.delete(this.normalize(`${dir}/${name}`));
  }

  /* Test conveniences. */
  has(p: string): boolean {
    return this.files.has(this.normalize(p));
  }
  get(p: string): string | undefined {
    return this.files.get(this.normalize(p));
  }

  private normalize(p: string): string {
    return p.replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/+$/, '');
  }
}
