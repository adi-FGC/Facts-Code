import { describe, expect, it } from 'vitest';
import { walk } from '../src/index.js';
import { memoryFS } from '@factstack/fs-memory';

/**
 * Tests for the gitignore-aware walker. Critical because the walker's
 * exclusions feed every downstream pass — false positives there
 * become noise EVERYWHERE in the artifact.
 */

async function collect(it: AsyncIterable<{ path: string }>): Promise<string[]> {
  const out: string[] = [];
  for await (const f of it) out.push(f.path);
  return out;
}

describe('walk — basic enumeration', () => {
  it('walks a flat tree', async () => {
    const fs = memoryFS({ 'a.ts': 'x', 'b.ts': 'y' });
    const paths = (await collect(walk(fs))).sort();
    expect(paths).toEqual(['a.ts', 'b.ts']);
  });

  it('walks a nested tree', async () => {
    const fs = memoryFS({
      'src/a.ts': 'x',
      'src/sub/b.ts': 'y',
      'README.md': '#',
    });
    const paths = (await collect(walk(fs))).sort();
    expect(paths).toEqual(['README.md', 'src/a.ts', 'src/sub/b.ts']);
  });
});

describe('walk — always-exclude folders', () => {
  it('skips node_modules', async () => {
    const fs = memoryFS({
      'src/a.ts': 'x',
      'node_modules/react/index.js': 'y',
    });
    const paths = await collect(walk(fs));
    expect(paths).toContain('src/a.ts');
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
  });

  it('skips dist + build + .git + .turbo + .cache + coverage', async () => {
    const fs = memoryFS({
      'src/a.ts': 'x',
      'dist/bundle.js': 'y',
      'build/out.js': 'y',
      '.git/HEAD': 'y',
      '.turbo/cache.json': 'y',
      '.cache/x': 'y',
      'coverage/lcov.info': 'y',
    });
    const paths = await collect(walk(fs));
    expect(paths).toEqual(['src/a.ts']);
  });

  it('skips Python venv + caches', async () => {
    const fs = memoryFS({
      'app.py': 'print(1)',
      '__pycache__/x.pyc': 'b',
      '.venv/lib/python3/x.py': 'p',
    });
    const paths = await collect(walk(fs));
    expect(paths).toEqual(['app.py']);
  });

  it('skips tsbuildinfo files (suffix-based)', async () => {
    const fs = memoryFS({
      'src/a.ts': 'x',
      'tsconfig.tsbuildinfo': 'cache',
      'apps/cli/tsconfig.tsbuildinfo': 'cache',
    });
    const paths = await collect(walk(fs));
    expect(paths.some((p) => p.endsWith('.tsbuildinfo'))).toBe(false);
  });
});

describe('walk — gitignore', () => {
  it('respects a root .gitignore', async () => {
    const fs = memoryFS({
      'src/a.ts': 'x',
      'secret.env': 'KEY=abc',
      '.gitignore': '*.env\n',
    });
    const paths = await collect(walk(fs));
    expect(paths).toContain('src/a.ts');
    expect(paths).not.toContain('secret.env');
  });

  it('honors nested .gitignore (additive)', async () => {
    const fs = memoryFS({
      'src/a.ts': 'x',
      'src/b.log': 'log',
      'src/.gitignore': '*.log\n',
    });
    const paths = await collect(walk(fs));
    expect(paths).toContain('src/a.ts');
    expect(paths).not.toContain('src/b.log');
  });

  it('reads .factsignore on top of .gitignore', async () => {
    const fs = memoryFS({
      'src/a.ts': 'x',
      'src/generated.ts': 'y',
      '.factsignore': 'src/generated.ts\n',
    });
    const paths = await collect(walk(fs));
    expect(paths).toContain('src/a.ts');
    expect(paths).not.toContain('src/generated.ts');
  });
});

describe('walk — file size cap + binary detection', () => {
  it('flags binary files with skippedReason="binary"', async () => {
    const fs = memoryFS({ 'image.bin': 'hello\0world' }); // contains null byte
    const out: Array<{ path: string; skippedReason: string | null; text: string | null }> = [];
    for await (const f of walk(fs)) out.push(f);
    const file = out.find((f) => f.path === 'image.bin');
    expect(file?.skippedReason).toBe('binary');
    expect(file?.text).toBeNull();
  });

  it('flags too-large files with skippedReason="too_large"', async () => {
    const fs = memoryFS({ 'big.txt': 'x'.repeat(2 * 1024 * 1024) });
    const out: Array<{ path: string; skippedReason: string | null }> = [];
    for await (const f of walk(fs, '.', { maxFileSize: 1024 * 1024 })) out.push(f);
    const file = out.find((f) => f.path === 'big.txt');
    expect(file?.skippedReason).toBe('too_large');
  });
});
