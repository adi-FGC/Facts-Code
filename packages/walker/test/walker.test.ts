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

describe('walk — other checkouts inside the tree', () => {
  it('does not descend into a linked worktree (a directory with a .git FILE)', async () => {
    const fs = memoryFS({
      'src/a.ts': 'x',
      '.claude/worktrees/feature-x/.git': 'gitdir: ../../../.git/worktrees/feature-x',
      '.claude/worktrees/feature-x/src/a.ts': 'copy — must not be counted twice',
      '.claude/worktrees/feature-x/test/secrets.test.ts': 'AKIA_FIXTURE',
    });
    const paths = await collect(walk(fs));
    expect(paths).toEqual(['src/a.ts']);
  });

  it('does not descend into a nested clone (a directory with a .git DIR)', async () => {
    const fs = memoryFS({
      'src/a.ts': 'x',
      'examples/sample/.git/HEAD': 'ref: refs/heads/main',
      'examples/sample/index.ts': 'y',
      'examples/plain/index.ts': 'z',
    });
    const paths = await collect(walk(fs));
    expect(paths).toEqual(['examples/plain/index.ts', 'src/a.ts']);
  });

  it("still walks the root itself, whose .git is the project's own", async () => {
    const fs = memoryFS({ '.git/HEAD': 'ref', 'src/a.ts': 'x' });
    expect(await collect(walk(fs))).toEqual(['src/a.ts']);
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

  it('hard-excludes the .facts output dir (F8 cache.db must not self-analyze)', async () => {
    // FACTS's own output dir is excluded WITHOUT relying on a .gitignore entry,
    // so a re-analyze is correct even before that entry is written and the
    // F8 cache.db (+ its sqlite -wal/-shm sidecars) never pollute the file set.
    const fs = memoryFS({
      'src/a.ts': 'x',
      '.facts/agent.json': '{}',
      '.facts/cache.db': 'sqlitebytes',
      '.facts/cache.db-wal': 'wal',
      '.facts/snapshots/2026.json': '{}',
    });
    const paths = await collect(walk(fs));
    expect(paths).toEqual(['src/a.ts']);
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

  it('anchors a nested .gitignore rule that contains a slash to its own directory', async () => {
    // create-next-app writes '/out/' + '/build' into apps/web/.gitignore; git
    // anchors them at apps/web, not at the repo root.
    const fs = memoryFS({
      'packages/a/.gitignore': '/gen\nsrc/out/\nlib/gen.ts\n/.env\n',
      'packages/a/gen/x.ts': 'x',
      'packages/a/src/out/y.ts': 'y',
      'packages/a/src/keep.ts': 'k',
      'packages/a/lib/gen.ts': 'g',
      'packages/a/lib/ok.ts': 'o',
      'packages/a/.env': 'KEY=1',
      'packages/a/sub/gen/z.ts': 'anchored /gen does not match deeper',
      'gen/root.ts': 'a nested /gen must not hide the root gen/',
    });
    const paths = (await collect(walk(fs))).sort();
    expect(paths).toEqual([
      'gen/root.ts',
      'packages/a/lib/ok.ts',
      'packages/a/src/keep.ts',
      'packages/a/sub/gen/z.ts',
    ]);
  });

  it('lets a nested "!" re-include what a parent ignored, and a deeper file override a parent', async () => {
    const fs = memoryFS({
      '.gitignore': '*.log\n!important.txt\n',
      'pkg/.gitignore': '!keep.log\nimportant.txt\n',
      'pkg/keep.log': 'k',
      'pkg/drop.log': 'd',
      'pkg/important.txt': 'deeper file wins',
      'important.txt': 'root keeps it',
    });
    const paths = (await collect(walk(fs))).sort();
    expect(paths).toEqual(['important.txt', 'pkg/keep.log']);
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

  it('decodes NUL-heavy UTF-16-style content as text rather than flagging it binary (F-03)', async () => {
    // UTF-16 LE ASCII decoded as UTF-8 puts a NUL after every char. Those
    // bytes ARE a UTF-16 file, so the walker decodes them for real now.
    const utf16ish = 'c\0o\0n\0s\0t\0 \0x\0'.repeat(100);
    const fs = memoryFS({ 'weird.ts': utf16ish });
    const out: Array<{ path: string; skippedReason: string | null; text: string | null }> = [];
    for await (const f of walk(fs)) out.push(f);
    const weird = out.find((f) => f.path === 'weird.ts')!;
    expect(weird.skippedReason).toBeNull();
    expect(weird.text).toBe('const x'.repeat(100));
  });

  it('flags NUL-heavy content that is not UTF-16 as binary', async () => {
    // NUL runs at both byte parities: a length-prefixed binary, not wide text.
    const blob = '\0\0\0\0const\0\0\0\0 x = 1;\0\0\0\0\n'.repeat(50);
    const fs = memoryFS({ 'weird.bin': blob });
    const out: Array<{ path: string; skippedReason: string | null }> = [];
    for await (const f of walk(fs)) out.push(f);
    expect(out.find((f) => f.path === 'weird.bin')?.skippedReason).toBe('binary');
  });

  it('does NOT flag a normal source file containing a single embedded NUL (facts+ engine.ts regression)', async () => {
    // Real-world case: a 338-line TS file used a literal `\0` as a cache-key
    // separator inside a template string and got packed as loc 0 / "ok".
    const source =
      'export function cacheKey(files: string[]): string {\n' +
      '  return files.map((f) => `${f}\0suffix`).join("|");\n' +
      '}\n' +
      '// padding line\n'.repeat(300);
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
    const out: Array<{
      path: string;
      text: string | null;
      loc: number;
      skippedReason: string | null;
    }> = [];
    for await (const f of walk(fs)) out.push(f);
    const file = out.find((f) => f.path === 'src/engine.ts');
    expect(file?.skippedReason).toBeNull();
    expect(file?.text).toBe('export const x = 1;\n');
    expect(file?.loc).toBeGreaterThan(0);
  });

  it('yields skippedReason="read_error" with null text when the read keeps failing', async () => {
    const fs = flakyReadFS({ 'src/engine.ts': 'export const x = 1;\n' }, 'src/engine.ts', Infinity);
    const out: Array<{
      path: string;
      text: string | null;
      loc: number;
      skippedReason: string | null;
    }> = [];
    for await (const f of walk(fs)) out.push(f);
    const file = out.find((f) => f.path === 'src/engine.ts');
    expect(file?.skippedReason).toBe('read_error');
    expect(file?.text).toBeNull();
    expect(file?.loc).toBe(0);
  });
});

describe('walk — what is NOT an ignore rule', () => {
  const paths = async (fsx: FactsFS) => {
    const out: string[] = [];
    for await (const f of walk(fsx)) out.push(f.path);
    return out.sort();
  };

  it('does not read .dockerignore: a Docker allowlist must not empty the scan', async () => {
    // `*` + `!src` is the idiomatic .dockerignore; as gitignore it hides everything.
    const fs = memoryFS({
      '.dockerignore': '*\n!src\n',
      'src/app.ts': 'export const a = 1;\n',
      'package.json': '{"name":"x"}\n',
      'README.md': '# x\n',
    });
    expect(await paths(fs)).toEqual(['.dockerignore', 'README.md', 'package.json', 'src/app.ts']);
  });

  it('still applies .gitignore next to it', async () => {
    const fs = memoryFS({
      '.dockerignore': '*\n',
      '.gitignore': 'generated/\n',
      'generated/out.ts': 'export {};\n',
      'src/app.ts': 'export const a = 1;\n',
    });
    expect(await paths(fs)).toEqual(['.dockerignore', 'src/app.ts']);
  });

  it('drops directories named like build output, never files with those names', async () => {
    const fs = memoryFS({
      'bin/build': '#!/bin/sh\necho build\n', // a buildpack script
      vendor: 'not a directory\n',
      'build/out.js': 'module.exports = 1;\n', // a real build directory
      'src/app.ts': 'export const a = 1;\n',
    });
    expect(await paths(fs)).toEqual(['bin/build', 'src/app.ts', 'vendor']);
  });
});

describe('walk — line counts', () => {
  it('counts lines the way wc -l and editors do', async () => {
    const fs = memoryFS({
      'two.ts': 'a\nb\n', // trailing newline ends line 2, it is not line 3
      'two-no-eol.ts': 'a\nb',
      'one.ts': 'a',
      'empty.ts': '',
    });
    const loc = new Map<string, number>();
    for await (const f of walk(fs)) loc.set(f.path, f.loc);
    expect(loc.get('two.ts')).toBe(2);
    expect(loc.get('two-no-eol.ts')).toBe(2);
    expect(loc.get('one.ts')).toBe(1);
    expect(loc.get('empty.ts')).toBe(0);
  });
});

/* ───────── v0.3.12 — files git ignores from OUTSIDE the repo ───────── */

describe('personal, untracked agent files and injected ignore rules', () => {
  const paths = async (fsx: FactsFS, opts?: Parameters<typeof walk>[2]) => {
    const out: string[] = [];
    for await (const f of walk(fsx, '.', opts)) out.push(f.path);
    return out;
  };

  it("never analyzes an agent's per-developer settings or memory", async () => {
    const fsx = memoryFS({
      'src/a.ts': 'export const a = 1;\n',
      '.claude/settings.local.json':
        '{"hooks":{"PostToolUse":[{"command":"C:/Users/someone/x.mjs"}]}}\n',
      '.claude/settings.json': '{"shared":true}\n',
      'CLAUDE.local.md': 'my private notes\n',
      'CLAUDE.md': 'shared instructions\n',
    });
    const out = await paths(fsx);
    expect(out).toContain('src/a.ts');
    // Shared, tracked siblings stay: only the personal variants are dropped.
    expect(out).toContain('.claude/settings.json');
    expect(out).toContain('CLAUDE.md');
    expect(out).not.toContain('.claude/settings.local.json');
    expect(out).not.toContain('CLAUDE.local.md');
  });

  it('applies injected rules (git global excludes) relative to the root', async () => {
    const fsx = memoryFS({
      'src/a.ts': 'export const a = 1;\n',
      'notes.private.md': 'personal\n',
      'src/scratch/tmp.ts': 'export const t = 1;\n',
      'keep.md': 'shared\n',
    });
    const out = await paths(fsx, {
      extraIgnore: [
        '# a user global excludes file, comments and blanks included',
        '',
        '*.private.md',
        'scratch/',
      ],
    });
    expect(out).toContain('src/a.ts');
    expect(out).toContain('keep.md');
    expect(out).not.toContain('notes.private.md');
    expect(out).not.toContain('src/scratch/tmp.ts');
  });

  it('is unchanged when no rules are injected', async () => {
    const files = { 'src/a.ts': 'export const a = 1;\n', 'notes.private.md': 'personal\n' };
    expect(await paths(memoryFS(files), {})).toEqual(await paths(memoryFS(files)));
    expect(await paths(memoryFS(files), { extraIgnore: [] })).toContain('notes.private.md');
  });

  it('drops a personal file at any depth, not just at the root', async () => {
    const fsx = memoryFS({
      'src/a.ts': 'export const a = 1;\n',
      '.claude/settings.local.json': '{"hooks":{}}\n',
      'packages/foo/.claude/settings.local.json': '{"hooks":{}}\n',
      'packages/foo/CLAUDE.local.md': 'private\n',
      'packages/foo/.cursor/rules/mine.local.mdc': 'private\n',
    });
    expect(await paths(fsx)).toEqual(['src/a.ts']);
  });

  it('cannot be re-admitted by an injected negation: host rules never un-hide a personal file', async () => {
    // A stray `!` line in someone's global excludes must not put an agent's
    // per-developer settings back into an artifact that gets published.
    const files = {
      'src/a.ts': 'export const a = 1;\n',
      '.claude/settings.local.json': '{"hooks":{}}\n',
      'CLAUDE.local.md': 'private\n',
    };
    for (const rule of ['!', '!*', '!.claude/settings.local.json', '!CLAUDE.local.md']) {
      const out = await paths(memoryFS(files), { extraIgnore: [rule] });
      expect(out, rule).not.toContain('.claude/settings.local.json');
      expect(out, rule).not.toContain('CLAUDE.local.md');
      expect(out, rule).toContain('src/a.ts');
    }
  });

  it('lets the REPOSITORY re-include a personal path it deliberately tracks', async () => {
    // The escape hatch stays with the repo's own ignore files, which are
    // applied after both the injected rules and the built-in list.
    const fsx = memoryFS({
      '.gitignore': '!.claude/settings.local.json\n',
      'src/a.ts': 'export const a = 1;\n',
      '.claude/settings.local.json': '{"hooks":{}}\n',
    });
    expect(await paths(fsx)).toContain('.claude/settings.local.json');
  });

  it('keeps a repo .gitignore working alongside injected rules', async () => {
    const fsx = memoryFS({
      '.gitignore': 'build/\n',
      'src/a.ts': 'export const a = 1;\n',
      'build/out.js': 'x\n',
      'local.env.md': 'secret\n',
    });
    const out = await paths(fsx, { extraIgnore: ['local.env.md'] });
    expect(out).toEqual(['src/a.ts']);
  });
});

/* F-03 — a UTF-16 save (PowerShell 5's default) is text, not binary. Decoded
   as UTF-8 it is one NUL per character, which the NUL sniff read as binary:
   a secret in such a file was never scanned, and the file was recorded as
   `ok` with loc 0. */
describe('walk — UTF-16 text is text', () => {
  const source = 'const key = "value";\nexport {};\n';
  const utf16le = (s: string, bom: boolean): Uint8Array => {
    const out = new Uint8Array((s.length + (bom ? 1 : 0)) * 2);
    let j = 0;
    if (bom) {
      out[j++] = 0xff;
      out[j++] = 0xfe;
    }
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      out[j++] = c & 0xff;
      out[j++] = c >> 8;
    }
    return out;
  };
  /** A FactsFS whose `src/wide.ts` holds `bytes`: readText gives the UTF-8
   *  reading every host hands the walker (one NUL per character for UTF-16),
   *  readFile the bytes themselves. */
  const fsWith = (bytes: Uint8Array): FactsFS => {
    const fs = memoryFS({ 'src/wide.ts': '', 'src/plain.ts': source });
    const readFile = fs.readFile.bind(fs);
    const readText = fs.readText.bind(fs);
    fs.readFile = (p) => (p.endsWith('wide.ts') ? Promise.resolve(bytes) : readFile(p));
    fs.readText = (p) =>
      p.endsWith('wide.ts') ? Promise.resolve(new TextDecoder('utf-8').decode(bytes)) : readText(p);
    return fs;
  };
  const wide = async (bytes: Uint8Array) => {
    const files: Array<{
      path: string;
      text: string | null;
      loc: number;
      skippedReason: string | null;
    }> = [];
    for await (const f of walk(fsWith(bytes))) files.push(f);
    return files.find((f) => f.path === 'src/wide.ts')!;
  };

  it('decodes UTF-16LE with a BOM to the same text as its UTF-8 twin', async () => {
    const f = await wide(utf16le(source, true));
    expect(f.skippedReason).toBeNull();
    expect(f.text).toBe(source);
    expect(f.loc).toBe(2);
  });

  it('decodes UTF-16LE without a BOM by its NUL signature', async () => {
    const f = await wide(utf16le(source, false));
    expect(f.text).toBe(source);
  });

  it('still records a real binary as binary', async () => {
    const png = new Uint8Array(64);
    png.set([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    const f = await wide(png);
    expect(f.skippedReason).toBe('binary');
    expect(f.text).toBeNull();
  });
});
