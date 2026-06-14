import { describe, expect, it } from 'vitest';
import { walk } from '../src/index.js';
import { memoryFS } from '@factstack/fs-memory';
import type { FactsFS } from '@factstack/spec';

/** A memoryFS whose readText fails the first `failures` times for one
 *  path — models an editor mid-save / AV lock / mtime race. */
function flakyReadFS(files: Record<string, string>, failPath: string, failures: number): FactsFS {
  const base = memoryFS(files);
  let remaining = failures;
  return {
    readFile: (p) => base.readFile(p),
    readText: async (p) => {
      if (base.normalize(p) === failPath && remaining > 0) {
        remaining--;
        throw new Error('EBUSY: resource busy or locked');
      }
      return base.readText(p);
    },
    readDir: (p) => base.readDir(p),
    stat: (p) => base.stat(p),
    readlink: (p) => base.readlink(p),
    normalize: (p) => base.normalize(p),
    join: (...s) => base.join(...s),
  };
}

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
    const fs = memoryFS({ 'image.bin': 'hello\0world' }); // dense NUL in a tiny head
    const out: Array<{ path: string; skippedReason: string | null; text: string | null }> = [];
    for await (const f of walk(fs)) out.push(f);
    const file = out.find((f) => f.path === 'image.bin');
    expect(file?.skippedReason).toBe('binary');
    expect(file?.text).toBeNull();
  });

  it('flags NUL-heavy content (UTF-16-style) as binary', async () => {
    // UTF-16 LE ASCII decoded as UTF-8 puts a NUL after every char.
    const utf16ish = 'c\0o\0n\0s\0t\0 \0x\0'.repeat(100);
    const fs = memoryFS({ 'weird.ts': utf16ish });
    const out: Array<{ path: string; skippedReason: string | null }> = [];
    for await (const f of walk(fs)) out.push(f);
    expect(out.find((f) => f.path === 'weird.ts')?.skippedReason).toBe('binary');
  });

  it('does NOT flag a normal source file containing a single embedded NUL (facts+ engine.ts regression)', async () => {
    // Real-world case: a 338-line TS file used a literal `\0` as a cache-key
    // separator inside a template string and got packed as loc 0 / "ok".
    const source = 'export function cacheKey(files: string[]): string {\n' +
      '  return files.map((f) => `${f}\0suffix`).join("|");\n' +
      '}\n' + '// padding line\n'.repeat(300);
    const fs = memoryFS({ 'src/engine.ts': source });
    const out: Array<{ path: string; skippedReason: string | null; loc: number }> = [];
    for await (const f of walk(fs)) out.push(f);
    const file = out.find((f) => f.path === 'src/engine.ts');
    expect(file?.skippedReason).toBeNull();
    expect(file?.loc).toBeGreaterThan(300);
  });

  it('flags too-large files with skippedReason="too_large"', async () => {
    const fs = memoryFS({ 'big.txt': 'x'.repeat(2 * 1024 * 1024) });
    const out: Array<{ path: string; skippedReason: string | null }> = [];
    for await (const f of walk(fs, '.', { maxFileSize: 1024 * 1024 })) out.push(f);
    const file = out.find((f) => f.path === 'big.txt');
    expect(file?.skippedReason).toBe('too_large');
  });
});

describe('walk — read errors', () => {
  it('retries a transient read failure and yields the file with content', async () => {
    const fs = flakyReadFS({ 'src/engine.ts': 'export const x = 1;\n' }, 'src/engine.ts', 1);
    const out: Array<{ path: string; text: string | null; loc: number; skippedReason: string | null }> = [];
    for await (const f of walk(fs)) out.push(f);
    const file = out.find((f) => f.path === 'src/engine.ts');
    expect(file?.skippedReason).toBeNull();
    expect(file?.text).toBe('export const x = 1;\n');
    expect(file?.loc).toBeGreaterThan(0);
  });

  it('yields skippedReason="read_error" with null text when the read keeps failing', async () => {
    const fs = flakyReadFS({ 'src/engine.ts': 'export const x = 1;\n' }, 'src/engine.ts', Infinity);
    const out: Array<{ path: string; text: string | null; loc: number; skippedReason: string | null }> = [];
    for await (const f of walk(fs)) out.push(f);
    const file = out.find((f) => f.path === 'src/engine.ts');
    expect(file?.skippedReason).toBe('read_error');
    expect(file?.text).toBeNull();
    expect(file?.loc).toBe(0);
  });
});
