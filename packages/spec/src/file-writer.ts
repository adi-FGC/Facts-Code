/**
 * `FileWriter` — pure interface for "where artifacts land."
 *
 * Mirrors `FactsFS` (the read interface at `./fs.ts`). Together the
 * two interfaces form the spec tier's I/O contract: anything that
 * reads project files implements `FactsFS`; anything that writes
 * artifact files implements `FileWriter`.
 *
 * Adapter scope: each implementation scopes itself to one output
 * root. For FACTS today that's the `.facts/` directory inside a
 * project. The adapter prepends its root internally; orchestrators
 * pass pure relative paths (`agent.json`, `snapshots/X.json`) with no
 * awareness of where they actually land.
 *
 * Auto-mkdirp: `writeText` ensures parent directories exist. The
 * orchestrator never calls `mkdir` — both `node:fs/promises.mkdir`
 * (with `recursive: true`) and FSA's `getDirectoryHandle({create:
 * true})` make this trivially supported on both tiers.
 *
 * Two known implementations:
 *   - `NodeFileWriter` (`packages/emit/src/node-writer.ts`) — wraps
 *     `node:fs/promises`. Used by the CLI.
 *   - `FsaFileWriter` (`packages/emit-browser/src/fsa-writer.ts`) —
 *     wraps File System Access API. Used by the in-browser scanner.
 *
 * One test implementation:
 *   - `MemoryFileWriter` (`packages/emit/test/helpers/memory-writer.ts`)
 *     — in-memory adapter for orchestrator unit tests. No disk, no
 *     FSA permission grants, microseconds per test.
 *
 * Isomorphic constraint (per app_spec.md C1): this file imports
 * nothing. It defines an interface and that's all.
 */

export interface FileWriter {
  /**
   * Write a text file. Creates parent directories as needed
   * (mkdirp semantics). Returns the byte count of the written body
   * so callers can sum a running total.
   *
   * Overwrites existing files atomically — callers always get
   * truncate-then-write semantics, never an append.
   *
   * Paths use forward slashes regardless of host platform; adapters
   * convert internally if needed.
   */
  writeText(path: string, body: string): Promise<number>;

  /**
   * List immediate child names of a directory. Order is unspecified
   * (callers sort if order matters).
   *
   * Returns an empty array when the directory doesn't exist —
   * callers checking for "has this been written?" don't need to
   * catch errors.
   */
  listKeys(dir: string): Promise<string[]>;

  /**
   * Delete a single file. Silent no-op if the file is missing —
   * idempotent. Used today by snapshot retention (prune oldest).
   *
   * Doesn't recurse into directories. Adapters don't have to
   * implement directory deletion; the orchestrator never needs it.
   */
  removeEntry(dir: string, name: string): Promise<void>;
}
