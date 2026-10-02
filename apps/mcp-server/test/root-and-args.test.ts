/**
 * Root resolution (ux#8), argv parsing, path spelling (MCP-12) and the
 * since / query_learnings argument checks (MCP-13). Pure helpers.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAX_GLOB_LENGTH, QueryGraphInputSchema, withRootArg } from '@factstack/spec';
import { normalizeRelPath, parseServerArgs, resolveProjectRoot } from '../src/paths.js';
import {
  GLOB_MAX_CHARS,
  globArgIssues,
  isIsoTimestamp,
  queryLearningsArgIssues,
  sinceArgIssues,
} from '../src/args.js';
import { MCP_PACKAGE_VERSION, usageText } from '../src/about.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'facts-root-'));

describe('resolveProjectRoot', () => {
  it('an explicit --root or FACTS_ROOT wins as given', () => {
    const cwd = tmp();
    expect(resolveProjectRoot({ argRoot: 'proj', cwd, home: '/h' })).toEqual({
      root: path.resolve(cwd, 'proj'),
    });
    expect(resolveProjectRoot({ envRoot: cwd, cwd: '/', home: '/h' })).toEqual({ root: cwd });
  });

  it('walks up from a nested cwd to the repo (.git), not the nearer package.json', () => {
    const repo = tmp();
    mkdirSync(path.join(repo, '.git'));
    const pkg = path.join(repo, 'packages', 'a');
    mkdirSync(path.join(pkg, 'src'), { recursive: true });
    writeFileSync(path.join(pkg, 'package.json'), '{}');
    const r = resolveProjectRoot({ cwd: path.join(pkg, 'src'), home: '/nowhere' });
    expect(r).toEqual({ root: repo });
  });

  it('falls back to the nearest package.json outside git', () => {
    const proj = tmp();
    writeFileSync(path.join(proj, 'package.json'), '{}');
    mkdirSync(path.join(proj, 'src'));
    expect(resolveProjectRoot({ cwd: path.join(proj, 'src'), home: '/nowhere' }).root).toBe(proj);
  });

  it('refuses when nothing marks a project (the old "." fallback wrote into cwd)', () => {
    const cwd = tmp();
    const r = resolveProjectRoot({ cwd, home: '/nowhere' });
    // A temp dir's ancestors may hold a stray package.json; either way it must
    // not silently become the project unless it IS one.
    if (r.root === path.resolve(cwd)) expect(r.error).toMatch(/--root/);
  });

  it('refuses an inferred home directory', () => {
    const home = tmp();
    mkdirSync(path.join(home, '.git')); // a dotfiles repo in $HOME
    mkdirSync(path.join(home, 'Downloads'));
    const r = resolveProjectRoot({ cwd: path.join(home, 'Downloads'), home });
    expect(r.root).toBe(home);
    expect(r.error).toMatch(/home directory/);
  });

  it('refuses home even when cwd and home spell it differently (8.3 short names, MCP-R6)', () => {
    // On Windows tmpdir() is often short-form (C:\PROGRA~1\...); the
    // long form is what a client's cwd usually carries. Elsewhere both match.
    const home = tmp();
    const long = realpathSync.native(home);
    mkdirSync(path.join(home, '.git'));
    mkdirSync(path.join(home, 'Downloads'));
    for (const [cwdBase, homeSpelling] of [
      [long, home],
      [home, long],
    ]) {
      const r = resolveProjectRoot({ cwd: path.join(cwdBase!, 'Downloads'), home: homeSpelling! });
      expect(r.error, `${cwdBase} vs ${homeSpelling}`).toMatch(/home directory/);
    }
  });
});

describe('parseServerArgs', () => {
  it('reads --root / -r / --root= and the login sub-command', () => {
    expect(parseServerArgs(['--root', '/p'])).toEqual({ login: false, root: '/p' });
    expect(parseServerArgs(['-r', '/p'])).toEqual({ login: false, root: '/p' });
    expect(parseServerArgs(['--root=/p'])).toEqual({ login: false, root: '/p' });
    expect(parseServerArgs(['login'])).toEqual({ login: true });
    expect(parseServerArgs([])).toEqual({ login: false });
  });

  it('a project folder named "login" is a root, not the sub-command', () => {
    expect(parseServerArgs(['--root', 'login'])).toEqual({ login: false, root: 'login' });
  });

  it('reads --help / -h and --version / -v (print and exit, never serve)', () => {
    expect(parseServerArgs(['--help'])).toEqual({ login: false, help: true });
    expect(parseServerArgs(['-h'])).toEqual({ login: false, help: true });
    expect(parseServerArgs(['--version'])).toEqual({ login: false, version: true });
    expect(parseServerArgs(['-v'])).toEqual({ login: false, version: true });
    // A root folder named like a flag is still the root.
    expect(parseServerArgs(['--root', '--help'])).toEqual({ login: false, root: '--help' });
  });

  it('the last root wins; an empty or valueless one names none (mcp-1)', () => {
    expect(parseServerArgs(['--root', 'a', '--root=b', 'login'])).toEqual({
      login: true,
      root: 'b',
    });
    expect(parseServerArgs(['--root', '/x', '--root='])).toEqual({ login: false });
    expect(parseServerArgs(['login', '--root'])).toEqual({ login: true });
    expect(parseServerArgs(['-r', '-v'])).toEqual({ login: false, root: '-v' });
    expect(parseServerArgs(['-h', '--root=/p', '-v'])).toEqual({
      login: false,
      root: '/p',
      help: true,
      version: true,
    });
  });

  it('always reads the root an installer pins with withRootArg, whatever else argv holds', () => {
    const tokens = ['--root', '-r', '--root=', '--root=/a', '/b', 'login', '-h', '-v'];
    const lists: string[][] = [[]];
    for (const a of tokens) for (const b of tokens) for (const c of tokens) lists.push([a, b, c]);
    for (const args of lists) {
      expect(parseServerArgs(withRootArg(args, '/pinned')).root, JSON.stringify(args)).toBe(
        '/pinned',
      );
    }
  });
});

describe('usage text', () => {
  it('names the published bin, every mode and every env var the bin reads', () => {
    const u = usageText();
    expect(u.split('\n')[0]).toBe(
      `factstack-mcp ${MCP_PACKAGE_VERSION}: the FACTS Model Context Protocol server (stdio)`,
    );
    for (const s of [
      '--root <dir>',
      ' login ',
      '--version',
      '--help',
      'FACTS_ROOT',
      'FACTS_HOME',
    ]) {
      expect(u).toContain(s);
    }
  });
});

describe('graph-tool glob cap', () => {
  it('flags filter / query.start.glob / query.where.pathGlob over 256 characters', () => {
    const long = 'x'.repeat(GLOB_MAX_CHARS + 1);
    expect(globArgIssues({ filter: 'x'.repeat(GLOB_MAX_CHARS) })).toEqual([]);
    expect(globArgIssues({ filter: long }).map((i) => i.field)).toEqual(['filter']);
    expect(
      globArgIssues({ query: { start: { glob: long }, where: { pathGlob: long } } }).map(
        (i) => i.field,
      ),
    ).toEqual(['query.start.glob', 'query.where.pathGlob']);
    // Shapes the Zod schema rejects anyway are left to it.
    expect(globArgIssues({ query: 'nope', filter: 42 })).toEqual([]);
  });

  it("is spec's MAX_GLOB_LENGTH, the cap the CLI query's schema carries (INV7)", () => {
    expect(GLOB_MAX_CHARS).toBe(MAX_GLOB_LENGTH);
    const at = (n: number) =>
      QueryGraphInputSchema.safeParse({ verb: 'callers', path: 'a.ts', filter: 'x'.repeat(n) })
        .success;
    // The MCP pre-check and the shared schema draw the line at the same length.
    expect(at(GLOB_MAX_CHARS)).toBe(true);
    expect(at(GLOB_MAX_CHARS + 1)).toBe(false);
  });
});

describe('normalizeRelPath', () => {
  const root = path.resolve(tmp());
  it.each([
    ['src/b.ts', 'src/b.ts'],
    ['src\\b.ts', 'src/b.ts'],
    ['./src/b.ts', 'src/b.ts'],
    ['.\\src\\b.ts', 'src/b.ts'],
    ['/src/b.ts', 'src/b.ts'],
    [path.join(root, 'src', 'b.ts'), 'src/b.ts'],
    ['src/b.ts#b@1', 'src/b.ts#b@1'],
  ])('%s → %s', (input, want) => {
    expect(normalizeRelPath(root, input)).toBe(want);
  });

  it('keeps ../ so the live-read guard still rejects it', () => {
    expect(normalizeRelPath(root, '../x.ts')).toBe('../x.ts');
  });

  it('keeps an existing absolute path outside the root absolute (MCP-R5)', () => {
    // A real file outside `root`, spelled `/…` (drive-less on win32, as agents
    // write it): it must not turn into the root-relative `…` it was mistaken for.
    const own = fileURLToPath(import.meta.url)
      .replace(/^[A-Za-z]:/, '')
      .replace(/\\/g, '/');
    expect(normalizeRelPath(root, own)).toBe(own);
  });
});

describe('since / query_learnings argument checks', () => {
  it('accepts ISO 8601 dates and date-times only', () => {
    for (const ok of ['2026-04-30', '2026-04-30T00:00:00Z', '2026-04-30T10:20:30.123+05:30']) {
      expect(isIsoTimestamp(ok)).toBe(true);
    }
    for (const bad of ['yesterday', 'garbage', '', '2026', 42, null]) {
      expect(isIsoTimestamp(bad)).toBe(false);
    }
  });

  it('since: timestamp is required and must be ISO 8601', () => {
    expect(sinceArgIssues({})).toHaveLength(1);
    expect(sinceArgIssues({ timestamp: 'yesterday' })[0]!.field).toBe('timestamp');
    expect(sinceArgIssues({ timestamp: '2026-04-30T00:00:00Z' })).toEqual([]);
  });

  it('query_learnings: since/until ISO, limit an integer in 1..5000', () => {
    expect(queryLearningsArgIssues({ since: 'garbage' })[0]!.field).toBe('since');
    expect(queryLearningsArgIssues({ until: 'x' })[0]!.field).toBe('until');
    for (const bad of [-1, 0, 2.5, 5001, '10']) {
      expect(queryLearningsArgIssues({ limit: bad })[0]!.field).toBe('limit');
    }
    expect(queryLearningsArgIssues({ limit: 200, since: '2026-01-01' })).toEqual([]);
  });
});
