/**
 * FileListFS — the folder-input (<input webkitdirectory>) scan path.
 *
 * correctness#35: the worker used to decode every picked File with
 * `file.text()` into a MemoryFS, whose stat() then reported the UTF-8
 * length of the DECODED string. Every invalid byte of a binary became a
 * 3-byte U+FFFD, so a 614,400-byte PNG reported ~1.08 MB, crossed the
 * walker's 1 MB cap and picked up a false `file-size-cap` risk.
 *
 * Also pins browserRepoName (FSB-11): a linked worktree reports its main
 * checkout's name, as the CLI's repoDisplayName does.
 */
import { describe, expect, it } from 'vitest';
import { MemoryFS } from '@factstack/fs-memory';
import { FileListFS } from '../src/file-list.js';
import { browserRepoName } from '../src/repo-name.js';

/** PNG-like bytes: a real header followed by high bytes that are invalid UTF-8. */
function fakePng(size: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
  for (let i = 12; i < size; i++) b[i] = 0x80 + (i % 0x7f);
  return b;
}

async function readAll(fs: FileListFS, dir = '.'): Promise<string[]> {
  const out: string[] = [];
  for await (const e of fs.readDir(dir)) {
    if (e.isDirectory) out.push(...(await readAll(fs, e.path)));
    else out.push(e.path);
  }
  return out.sort();
}

describe('FileListFS (correctness#35)', () => {
  it('reports the real byte size of a binary, where the old decode-first path inflated it', async () => {
    const bytes = fakePng(614_400);
    const file = new File([bytes], 'logo.png');

    // The old path: decode, store the string, stat the re-encoded length.
    const old = new MemoryFS({ 'logo.png': await file.text() });
    expect((await old.stat('logo.png')).size).toBeGreaterThan(1024 * 1024);

    const fs = new FileListFS([{ path: 'assets/logo.png', file }]);
    expect((await fs.stat('assets/logo.png')).size).toBe(614_400);
    const read = await fs.readFile('assets/logo.png');
    expect(read.byteLength).toBe(bytes.byteLength);
    // Byte-for-byte without toEqual's per-element deep walk, which took
    // seconds for 600 KB on a loaded CI runner: no index differs.
    expect(read.findIndex((b, i) => b !== bytes[i])).toBe(-1);
  });

  it('reads nothing until asked (excluded trees are never loaded)', async () => {
    const poisoned = new File(['x'], 'index.js');
    for (const read of ['arrayBuffer', 'text']) {
      Object.defineProperty(poisoned, read, {
        value: () => Promise.reject(new Error('read too early')),
      });
    }
    const fs = new FileListFS([
      { path: 'node_modules/pkg/index.js', file: poisoned },
      { path: 'src/a.ts', file: new File(['export const a = 1;\n'], 'a.ts') },
    ]);
    expect(await readAll(fs)).toEqual(['node_modules/pkg/index.js', 'src/a.ts']);
    expect((await fs.stat('node_modules/pkg/index.js')).size).toBe(1);
    expect(await fs.readText('src/a.ts')).toBe('export const a = 1;\n');
  });

  /* BFS-R1: every host (Blob.text, NodeFS, MemoryFS) strips ONE leading
     BOM. Keeping it made JSON.parse of a BOM-saved package.json throw on
     the folder-input path only, dropping its deps and scripts (INV7). */
  it('decodes like every other host: one leading BOM stripped, invalid bytes replaced', async () => {
    const bom = new File([new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0xff, 0x62])], 'a.txt');
    const twice = new File([new Uint8Array([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x61])], 'b.txt');
    const fs = new FileListFS([
      { path: 'a.txt', file: bom },
      { path: 'b.txt', file: twice },
    ]);
    expect(await fs.readText('a.txt')).toBe('a\ufffdb');
    expect(await fs.readText('a.txt')).toBe(await bom.text());
    expect(await fs.readText('b.txt')).toBe('\ufeffa'); // only the first BOM is not content
    expect((await fs.stat('a.txt')).size).toBe(6); // stat stays the raw byte count
  });

  it('a BOM-saved package.json parses, so its deps and scripts reach analyze', async () => {
    const pkg = '{"dependencies":{"express":"^4.18.0"},"scripts":{"start":"node ."}}';
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(pkg)]);
    const fs = new FileListFS([{ path: 'package.json', file: new File([bytes], 'package.json') }]);
    const parsed = JSON.parse(await fs.readText('package.json'));
    expect(parsed.dependencies.express).toBe('^4.18.0');
    expect(parsed.scripts.start).toBe('node .');
  });

  it('answers stat/readDir for directories and ENOENT for missing paths', async () => {
    const fs = new FileListFS([{ path: 'a/b/c.ts', file: new File(['c'], 'c.ts') }]);
    expect((await fs.stat('a/b')).isDirectory).toBe(true);
    expect((await fs.stat('.')).isDirectory).toBe(true);
    await expect(fs.stat('a/nope')).rejects.toThrow(/ENOENT/);
    await expect(fs.readText('a/b')).rejects.toThrow(/ENOENT/);
  });
});

describe('browserRepoName (FSB-11)', () => {
  it("names a linked worktree after its main checkout, like the CLI's repoDisplayName", async () => {
    const wt = new MemoryFS({
      '.git': 'gitdir: D:/work/my repos/factstack/.git/worktrees/feature-x\n',
      'src/a.ts': '',
    });
    expect(await browserRepoName(wt, 'feature-x')).toBe('factstack');
  });

  it('keeps the folder name for a main checkout, a submodule, a relative gitdir or no git', async () => {
    const main = new MemoryFS({ '.git/HEAD': 'ref: refs/heads/main\n' });
    expect(await browserRepoName(main, 'repo')).toBe('repo');
    const sub = new MemoryFS({ '.git': 'gitdir: ../.git/modules/sub\n' });
    expect(await browserRepoName(sub, 'sub')).toBe('sub');
    const rel = new MemoryFS({ '.git': 'gitdir: ../../.git/worktrees/wt\n' });
    expect(await browserRepoName(rel, 'wt')).toBe('wt');
    expect(await browserRepoName(new MemoryFS({ 'a.ts': '' }), 'plain')).toBe('plain');
  });
});
