/* eslint-disable max-classes-per-file, require-await */

import { describe, expect, it } from 'vitest';
import type { AgentArtifact, HumanArtifact } from '@factstack/spec';
import { FsaFileWriter } from '../src/fsa-writer.js';
import { writeBrowserArtifacts } from '../src/write.js';

describe('FsaFileWriter — browser filesystem targets', () => {
  it('writes files under .facts and verifies bytes after close', async () => {
    const root = new MemoryFsaDirectory('');
    const writer = new FsaFileWriter(root.asHandle());

    const bytes = await writer.writeText('agent.json', '{"ok":true}\n');

    expect(bytes).toBe(new TextEncoder().encode('{"ok":true}\n').byteLength);
    expect(root.hasFile('.facts/agent.json')).toBe(true);
    expect(root.text('.facts/agent.json')).toBe('{"ok":true}\n');
    expect(root.hasFile('agent.json')).toBe(false);
  });

  it('creates nested directories, lists immediate keys, and prunes entries', async () => {
    const root = new MemoryFsaDirectory('');
    const writer = new FsaFileWriter(root.asHandle());

    expect(await writer.listKeys('snapshots')).toEqual([]);
    await writer.writeText('snapshots/a.json', '{}');
    await writer.writeText('snapshots/nested/b.json', '{}');

    expect((await writer.listKeys('snapshots')).toSorted()).toEqual(['a.json', 'nested']);

    await writer.removeEntry('snapshots', 'a.json');
    await writer.removeEntry('snapshots', 'a.json');

    expect(await writer.listKeys('snapshots')).toEqual(['nested']);
  });

  it('fails loudly when the browser reports success but the target size is wrong', async () => {
    const root = new MemoryFsaDirectory('');
    root.reportedSizeOverrides.set('.facts/agent.json', 0);
    const writer = new FsaFileWriter(root.asHandle());

    await expect(writer.writeText('agent.json', '{"ok":true}\n')).rejects.toThrow(
      /Write verification failed for "agent\.json"/u,
    );
  });

  /* The macOS write-defense layer (added 2026-05-25): three regression
   * guards that protect users from real silent-failure modes. Each
   * test asserts one independent guarantee — if one regresses, the
   * test that names it fails. Don't fold these together. */

  it('writes a BufferSource (Uint8Array), never a raw string — guards WebKit/Safari pre-17 quirk', async () => {
    /* Background: writable.write(string) silently produced 0-byte files
     * on some WebKit versions + FSA polyfills. We always pass
     * Uint8Array to dodge the codepath. If a future refactor drops
     * the encoding step and passes the string straight through, this
     * test fails on the type tag. */
    const root = new MemoryFsaDirectory('');
    const writer = new FsaFileWriter(root.asHandle());

    await writer.writeText('agent.json', '{"hello":"mac"}\n');

    const ops = root.lastWritableOps('.facts/agent.json');
    expect(ops).not.toBeNull();
    const writeOp = ops!.find((o) => o.kind === 'write');
    expect(writeOp).toBeDefined();
    expect(writeOp!.chunkType).toBe('Uint8Array');
    expect(writeOp!.chunkType).not.toBe('string');
  });

  it('calls truncate(byteLength) AFTER write — guards WebKit close-without-flush bug', async () => {
    /* Background: writable.close() could resolve before the buffer
     * actually flushed in pre-17.x Safari, leaving a 0-byte file even
     * though every promise resolved. An explicit truncate to the
     * expected size forces the implementation to commit. Order
     * matters: truncate must come after write so it sets the final
     * size; before-write the truncate would be size 0 then write
     * would extend, leaving the bug intact. */
    const root = new MemoryFsaDirectory('');
    const writer = new FsaFileWriter(root.asHandle());

    const body = '{"truncate":"order"}\n';
    const expectedBytes = new TextEncoder().encode(body).byteLength;

    await writer.writeText('agent.json', body);

    const ops = root.lastWritableOps('.facts/agent.json');
    expect(ops).not.toBeNull();
    /* Sequence must be: write → truncate → close. Asserting on the
     * indices is more robust than `arrayContaining` — order is the
     * invariant we're guarding. */
    expect(ops!.map((o) => o.kind)).toEqual(['write', 'truncate', 'close']);
    const truncateOp = ops!.find((o) => o.kind === 'truncate');
    expect(truncateOp!.size).toBe(expectedBytes);
  });

  it('wraps getFile errors during verification with an actionable message', async () => {
    /* Background: when the FSA layer accepts the write but the
     * underlying filesystem silently rejects (iCloud Drive offline-only
     * folders are the canonical case), getFile may throw on the
     * verification read. We wrap it so the user sees the iCloud hint
     * + path instead of a bare NotFoundError. */
    const root = new MemoryFsaDirectory('');
    root.failGetFileFor.add('.facts/agent.json');
    const writer = new FsaFileWriter(root.asHandle());

    await expect(writer.writeText('agent.json', '{"x":1}\n')).rejects.toThrow(
      /Write verification could not re-read "agent\.json"/u,
    );
    await expect(writer.writeText('agent.json', '{"x":1}\n')).rejects.toThrow(
      /iCloud Drive/u,
    );
  });

  it('verification error mentions iCloud Drive + Documents/Downloads in the actionable hint', async () => {
    /* Background: the user's recovery path depends on knowing WHY
     * the write silently failed. The error message names the three
     * most common culprits — iCloud Drive sync, sandbox protections
     * on Documents/Downloads, and silently-denied write permission —
     * so the user can pick a non-affected folder and retry without
     * playing 20 questions. */
    const root = new MemoryFsaDirectory('');
    root.reportedSizeOverrides.set('.facts/agent.json', 0);
    const writer = new FsaFileWriter(root.asHandle());

    let captured: unknown = null;
    try {
      await writer.writeText('agent.json', '{"x":1}\n');
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(Error);
    const message = (captured as Error).message;
    expect(message).toMatch(/iCloud Drive/u);
    expect(message).toMatch(/Documents/u);
    expect(message).toMatch(/Downloads/u);
    /* The actual sizes must appear so a developer reading the user's
     * bug report can tell if it's 0-byte (close-without-flush) vs
     * partial-write vs something else. */
    expect(message).toMatch(/expected \d+ bytes/u);
    expect(message).toMatch(/found 0/u);
  });

  it('explicitly passes keepExistingData: false to createWritable (replace, not append)', async () => {
    /* Background: the default for keepExistingData is false, but
     * being explicit is part of the contract — writeText() is a
     * full replace, never a delta. If a future refactor drops the
     * option entirely it'd still pass functionally, but losing the
     * intent in the diff is exactly the kind of slow drift this
     * test guards against. */
    const root = new MemoryFsaDirectory('');
    const writer = new FsaFileWriter(root.asHandle());

    await writer.writeText('agent.json', '{}');

    const opts = root.lastCreateWritableOpts('.facts/agent.json');
    expect(opts).toEqual({ keepExistingData: false });
  });
});

describe('writeBrowserArtifacts — complete artifact write', () => {
  it('writes the full browser artifact set to the picked directory', async () => {
    const root = new MemoryFsaDirectory('');

    const result = await writeBrowserArtifacts({
      root: root.asHandle(),
      agent: makeAgent(),
      human: makeHuman(),
      memoryBody: '# demo\n',
    });

    expect(result.agentName).toBe('agent.json');
    expect(result.humanName).toBe('human.json');
    expect(result.packName).toBe('agent.pack');
    expect(result.jsonlName).toBe('agent.jsonl');
    expect(result.memoryName).toBe('MEMORY.md');
    expect(result.snapshotName).not.toBeNull();

    expect(root.hasFile('.facts/agent.json')).toBe(true);
    expect(root.hasFile('.facts/human.json')).toBe(true);
    expect(root.hasFile('.facts/agent.pack')).toBe(true);
    expect(root.hasFile('.facts/agent.jsonl')).toBe(true);
    expect(root.hasFile('.facts/MEMORY.md')).toBe(true);
    expect((await new FsaFileWriter(root.asHandle()).listKeys('snapshots')).length).toBe(1);
  });

  it('TC-2: emits agent.diff.pack on a warm run (reads the prior agent.pack)', async () => {
    const root = new MemoryFsaDirectory('');
    // Cold run seeds .facts/agent.pack (the prior master).
    const cold = await writeBrowserArtifacts({ root: root.asHandle(), agent: makeAgent(), human: makeHuman(), memoryBody: '# d\n' });
    expect(cold.diffName).toBeNull(); // no prior master on a cold run
    expect(root.hasFile('.facts/agent.pack')).toBe(true);

    // Warm run with a CHANGED agent (one new risk) → the F8 diff sidecar.
    const changed = { ...makeAgent(), risks: [{ severity: 'low', category: 'large-file', rule: 'big-file', message: 'oversized', file: 'src/big.ts' }] } as AgentArtifact;
    const warm = await writeBrowserArtifacts({ root: root.asHandle(), agent: changed, human: makeHuman(), memoryBody: '# d\n' });
    expect(warm.diffName).toBe('agent.diff.pack');
    expect(root.hasFile('.facts/agent.diff.pack')).toBe(true);
  });
});

function makeAgent(): AgentArtifact {
  return {
    $schema: 'https://factstack.dev/schema/agent.v1.json',
    factsVersion: '0.1.0',
    generatedAt: '2026-05-25T00:00:00.000Z',
    project: { name: 'demo', root: '.', languages: [], frameworks: [], entryPoints: [], monorepo: null },
    files: [],
    graph: { nodes: [], edges: [], cycles: [] },
    routes: [],
    scripts: {},
    capabilities: [],
    risks: [],
    stats: { loc: 0, fileCount: 0, packageCount: 0, totalTokenCost: 0 },
  } as AgentArtifact;
}

function makeHuman(): HumanArtifact {
  return {
    $schema: 'https://factstack.dev/schema/human.v1.json',
    factsVersion: '0.1.0',
    generatedAt: '2026-05-25T00:00:00.000Z',
    summary: {
      oneLiner: 'demo',
      capabilities: [],
      entryPoints: [],
      health: { broken: 0, stale: 0, todos: 0, secrets: 0, headline: 'ok' },
    },
    stack: [],
    tree: {
      id: 'root',
      name: 'root',
      path: '.',
      kind: 'directory',
      language: null,
      loc: 0,
      tokenCost: 0,
      bundleSizeGzip: null,
      status: 'ok',
      children: [],
    },
    graph: { nodes: [], edges: [], cycles: [] },
    activity: [],
    risks: [],
  } as HumanArtifact;
}

/**
 * One entry in the per-file operation log captured by MemoryFsaWritable.
 * `write` rows carry the runtime type of the chunk passed in so tests
 * can guard "must be Uint8Array, not string" without inspecting bytes.
 * `truncate` rows carry the target size for ordering assertions.
 */
type WritableOp =
  | { kind: 'write'; chunkType: 'Uint8Array' | 'string' | 'ArrayBuffer' | 'other' }
  | { kind: 'truncate'; size: number }
  | { kind: 'close' };

class MemoryFsaDirectory {
  readonly dirs = new Map<string, MemoryFsaDirectory>();
  readonly files = new Map<string, Uint8Array>();
  readonly reportedSizeOverrides = new Map<string, number>();
  /** Paths (root-relative) whose getFile() should throw — simulates an
   *  iCloud-offline-only folder where verification can't read back. */
  readonly failGetFileFor = new Set<string>();
  /** path → ordered list of writable ops, last write wins. Inspected by
   *  the BufferSource/truncate-order guard tests. */
  readonly writableOpLogs = new Map<string, WritableOp[]>();
  /** path → the options passed to createWritable for that file's last
   *  write. Asserts the explicit keepExistingData: false contract. */
  readonly createWritableOpts = new Map<string, { keepExistingData?: boolean } | undefined>();
  readonly root: MemoryFsaDirectory;

  constructor(private readonly path: string, root?: MemoryFsaDirectory) {
    this.root = root ?? this;
  }

  /** Last op log captured for a given path. Returns null if no writes
   *  ever landed on that path (filename typo in the test, usually). */
  lastWritableOps(p: string): WritableOp[] | null {
    return this.root.writableOpLogs.get(p) ?? null;
  }

  /** Last createWritable() options captured for a given path. */
  lastCreateWritableOpts(p: string): { keepExistingData?: boolean } | undefined {
    return this.root.createWritableOpts.get(p);
  }

  asHandle(): FileSystemDirectoryHandle {
    return this as unknown as FileSystemDirectoryHandle;
  }

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FileSystemDirectoryHandle> {
    let dir = this.dirs.get(name);
    if (!dir) {
      if (!opts?.create) throw new Error(`Directory not found: ${name}`);
      dir = new MemoryFsaDirectory(this.childPath(name), this.root);
      this.dirs.set(name, dir);
    }
    return dir.asHandle();
  }

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileSystemFileHandle> {
    if (!this.files.has(name)) {
      if (!opts?.create) throw new Error(`File not found: ${name}`);
      this.files.set(name, new Uint8Array());
    }
    return new MemoryFsaFileHandle(this, name).asHandle();
  }

  async removeEntry(name: string): Promise<void> {
    if (this.files.delete(name)) return;
    if (this.dirs.delete(name)) return;
    throw new Error(`Entry not found: ${name}`);
  }

  async *keys(): AsyncIterableIterator<string> {
    for (const name of [...this.files.keys(), ...this.dirs.keys()].toSorted()) {
      yield name;
    }
  }

  hasFile(p: string): boolean {
    return this.fileBytes(p) !== null;
  }

  text(p: string): string | null {
    const bytes = this.fileBytes(p);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }

  private fileBytes(p: string): Uint8Array | null {
    const parts = p.split('/').filter(Boolean);
    const leaf = parts.at(-1);
    if (!leaf) return null;
    const dir = this.findDir(parts.slice(0, -1));
    return dir?.files.get(leaf) ?? null;
  }

  private findDir(parts: string[]): MemoryFsaDirectory | null {
    const [head, ...tail] = parts;
    if (!head) return this;
    return this.dirs.get(head)?.findDir(tail) ?? null;
  }

  private childPath(name: string): string {
    return this.path ? `${this.path}/${name}` : name;
  }
}

class MemoryFsaFileHandle {
  constructor(private readonly dir: MemoryFsaDirectory, private readonly name: string) {}

  asHandle(): FileSystemFileHandle {
    return this as unknown as FileSystemFileHandle;
  }

  async createWritable(opts?: { keepExistingData?: boolean }): Promise<FileSystemWritableFileStream> {
    const path = this.dir['path'] ? `${this.dir['path']}/${this.name}` : this.name;
    const root = this.dir['root'] as MemoryFsaDirectory;
    /* Capture for the keepExistingData-explicit-false guard test. */
    root.createWritableOpts.set(path, opts);
    /* Reset the op log for this path on every createWritable — each
     * call is a fresh write session, so tests assert on the latest
     * one without leftover state from earlier writes to the same file. */
    const opLog: WritableOp[] = [];
    root.writableOpLogs.set(path, opLog);
    const existing = opts?.keepExistingData ? this.dir.files.get(this.name) : undefined;
    return new MemoryFsaWritable(this.dir, this.name, existing, opLog).asStream();
  }

  async getFile(): Promise<File> {
    const path = this.dir['path'] ? `${this.dir['path']}/${this.name}` : this.name;
    const root = this.dir['root'] as MemoryFsaDirectory;
    if (root.failGetFileFor.has(path)) {
      /* Simulate an iCloud-offline or sandbox-redirect failure: the
       * file's metadata can't be read back even though createWritable
       * + write + close all succeeded. Real FSA throws DOMException
       * here; the contract we care about is "any throw triggers the
       * descriptive wrapper". */
      throw new Error('NotFoundError: file unavailable');
    }
    const bytes = this.dir.files.get(this.name) ?? new Uint8Array();
    const size = root.reportedSizeOverrides.get(path) ?? bytes.byteLength;
    // TC-2: real File exposes async text()/arrayBuffer(); the F8 warm-run path
    // (write.ts reads the prior agent.pack via getFile().text()) needs them.
    return {
      size,
      async text() { return new TextDecoder().decode(bytes); },
      async arrayBuffer() { return bytes.slice().buffer; },
    } as unknown as File;
  }
}

class MemoryFsaWritable {
  private bytes: Uint8Array;

  constructor(
    private readonly dir: MemoryFsaDirectory,
    private readonly name: string,
    existing: Uint8Array | undefined,
    private readonly opLog: WritableOp[],
  ) {
    this.bytes = existing ? new Uint8Array(existing) : new Uint8Array();
  }

  asStream(): FileSystemWritableFileStream {
    return this as unknown as FileSystemWritableFileStream;
  }

  async write(chunk: unknown): Promise<void> {
    /* Classify the chunk type first — order matters because `string`
     * is checked before object instanceof checks. Logging happens
     * regardless of whether the write would succeed, so type-tagging
     * assertions remain valid even when the test expects a throw. */
    let chunkType: 'Uint8Array' | 'string' | 'ArrayBuffer' | 'other';
    if (typeof chunk === 'string') chunkType = 'string';
    else if (chunk instanceof Uint8Array) chunkType = 'Uint8Array';
    else if (chunk instanceof ArrayBuffer) chunkType = 'ArrayBuffer';
    else chunkType = 'other';
    this.opLog.push({ kind: 'write', chunkType });

    if (typeof chunk === 'string') {
      this.bytes = new TextEncoder().encode(chunk);
      return;
    }
    if (chunk instanceof Uint8Array) {
      this.bytes = new Uint8Array(chunk);
      return;
    }
    if (chunk instanceof ArrayBuffer) {
      this.bytes = new Uint8Array(chunk);
      return;
    }
    throw new Error('Unsupported write chunk');
  }

  async truncate(size: number): Promise<void> {
    this.opLog.push({ kind: 'truncate', size });
    const next = new Uint8Array(size);
    next.set(this.bytes.slice(0, size));
    this.bytes = next;
  }

  async close(): Promise<void> {
    this.opLog.push({ kind: 'close' });
    this.dir.files.set(this.name, this.bytes);
  }
}
