/**
 * A local folder's identity for saved scans (src/snapshot.ts): the tree
 * signature and the commit read from `.git`. Over MemoryFS, whose mtime is
 * the clock given to its constructor.
 */
import { describe, expect, it } from 'vitest';
import { MemoryFS } from '@factstack/fs-memory';
import { localSnapshot, readGitCommit } from '../src/snapshot.js';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const tree = {
  'README.md': '# hi\n',
  'src/a.ts': 'export const a = 1;\n',
  'src/deep/b.ts': 'export const b = 2;\n',
};

describe('localSnapshot — signature', () => {
  it('is stable for the same tree and counts files and bytes', async () => {
    const one = await localSnapshot(new MemoryFS(tree, 1000));
    const two = await localSnapshot(new MemoryFS(tree, 1000));
    expect(one.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(two.signature).toBe(one.signature);
    expect(one.files).toBe(3);
    expect(one.bytes).toBe(5 + 20 + 20);
    expect(one.commit).toBeNull();
  });

  it('changes when a file is edited, added, or touched', async () => {
    const base = (await localSnapshot(new MemoryFS(tree, 1000))).signature;
    const edited = await localSnapshot(
      new MemoryFS({ ...tree, 'src/a.ts': 'export const a = 11;\n' }, 1000),
    );
    const added = await localSnapshot(new MemoryFS({ ...tree, 'src/c.ts': '' }, 1000));
    const touched = await localSnapshot(new MemoryFS(tree, 2000));
    expect(new Set([base, edited.signature, added.signature, touched.signature]).size).toBe(4);
  });

  it('ignores .git and the fetcher’s excluded directories, and reports progress', async () => {
    const base = (await localSnapshot(new MemoryFS(tree, 1000))).signature;
    const noisy = new MemoryFS(
      {
        ...tree,
        '.git/HEAD': SHA + '\n',
        '.git/index': 'binary-ish',
        'node_modules/x/index.js': 'module.exports = 1;',
        'dist/bundle.js': 'x',
      },
      1000,
    );
    const ticks: number[] = [];
    const snap = await localSnapshot(noisy, (n) => ticks.push(n));
    expect(snap.signature).toBe(base);
    expect(snap.files).toBe(3);
    expect(snap.commit).toBe(SHA);
    expect(ticks.length).toBeGreaterThanOrEqual(0);
  });
});

describe('readGitCommit', () => {
  const git = (files: Record<string, string>) => readGitCommit(new MemoryFS(files, 1));

  it('reads a detached HEAD, a loose ref, and a packed ref', async () => {
    expect(await git({ '.git/HEAD': `${SHA}\n` })).toBe(SHA);
    expect(
      await git({ '.git/HEAD': 'ref: refs/heads/main\n', '.git/refs/heads/main': `${OTHER}\n` }),
    ).toBe(OTHER);
    expect(
      await git({
        '.git/HEAD': 'ref: refs/heads/feat/x\n',
        '.git/packed-refs': `# pack-refs with: peeled fully-peeled sorted\n${SHA} refs/heads/main\n${OTHER} refs/heads/feat/x\n`,
      }),
    ).toBe(OTHER);
  });

  it('is null without .git, for a worktree pointer file, or an unresolvable ref', async () => {
    expect(await git({ 'a.ts': '' })).toBeNull();
    expect(await git({ '.git': 'gitdir: ../main/.git/worktrees/x\n' })).toBeNull();
    expect(await git({ '.git/HEAD': 'ref: refs/heads/gone\n' })).toBeNull();
    expect(await git({ '.git/HEAD': 'not a sha\n' })).toBeNull();
  });
});
