/**
 * End-to-end: the real `factstack` binary (src/cli.ts via tsx) against
 * throw-away projects. Each test pins one reported failure:
 *
 *   - correctness#2 / data-model#4 — zero-arg `review` on an unchanged tree;
 *   - CLI-06   — Windows / `./` / absolute targets in `query`;
 *   - CLI-11   — gate/flag validation (`--fail-on none`, `outdated --fail-on`,
 *                telemetry actions);
 *   - data-model#46 — analyze survives a malformed carried-forward scan;
 *   - performance#2/#8 — `--minimal` reuses the cached git topology;
 *   - performance#9 — `export` fills the F8 parse cache;
 *   - R2       — `hook install` refuses a global/in-tree hooks dir without --shared;
 *   - R3       — install/setup-agents/uninstall keep a user's own FACTS hook;
 *   - correctness#2 (ci-report half) — a snapshot base cannot trip the
 *                vulnerability gate, a full base still does;
 *   - security#1/#3/#4, CLI-13, CLI-14, legacy-ui wiring — the `ui` server;
 *   - browser-fs request / owner decision — hand-written .cursorrules kept,
 *                FACTS-managed ones refreshed; install/uninstall of the hook;
 *   - ux#8 / mcp-pkg-3 — install pins the MCP server with --root, and the
 *                not-on-npm note follows MCP_PUBLISHED (in --help too, cli-r3-4);
 *   - data-model#3 — why no agent.diff.pack was written is printed.
 *
 * HOME is a temp dir, so telemetry and recents never touch the real one.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CLI_PUBLISHED, MCP_NPX, MCP_PUBLISHED } from '@factstack/spec';
import { parseServerCommand } from '@factstack/skills';
import { FRESHNESS_HOOK_COMMAND } from '../src/agentHook.js';
// Plain .mjs build helper shared with sync-ui; tsconfig.test.json's allowJs infers its types.
import { bundleBabelParser } from '../scripts/lib/build-ui.mjs';

const CLI_ROOT = path.join(import.meta.dirname, '..');
const TSX = path.join(CLI_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI = path.join(CLI_ROOT, 'src', 'cli.ts');
const T = 120_000;

let home = '';
let env: NodeJS.ProcessEnv = {};
const temps: string[] = [];

beforeAll(() => {
  home = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'facts-e2e-home-')));
  const gitconfig = path.join(home, 'gitconfig');
  writeFileSync(
    gitconfig,
    '[user]\n\tname = FACTS e2e\n\temail = e2e@example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n',
  );
  env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    FACTSTACK_TELEMETRY_URL: '',
    FACTSTACK_HOOK_COMMAND: '',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: realpathSync.native(tmpdir()),
  };
});
afterAll(() => {
  for (const d of [...temps, home]) rmSync(d, { recursive: true, force: true });
});

function cli(args: string[], cwd = CLI_ROOT, extraEnv: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, [TSX, CLI, ...args], {
    cwd,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    timeout: T,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** src/a.ts ⇄ src/c.ts (an import cycle) and src/b.ts → src/a.ts. */
function fixture(): string {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'facts-e2e-')));
  temps.push(dir);
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: { lodash: '^4.17.0' } }),
  );
  writeFileSync(
    path.join(dir, 'src', 'a.ts'),
    "import { c } from './c';\nexport const a = () => c();\n",
  );
  writeFileSync(
    path.join(dir, 'src', 'c.ts'),
    "import { a } from './a';\nexport const c = () => 1;\nexport const loop = () => a();\n",
  );
  writeFileSync(path.join(dir, 'src', 'b.ts'), "import { a } from './a';\nexport default a;\n");
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

const analyze = (dir: string, ...extra: string[]) => {
  const r = cli(['analyze', dir, '--no-progress', ...extra]);
  expect(r.code, r.stderr).toBe(0);
  return r;
};

describe('review — the default base is the previous FULL analysis (correctness#2)', () => {
  it(
    'an unchanged tree with a cycle reads NONE and passes --fail-on low',
    () => {
      const dir = fixture();
      analyze(dir);
      // No baseline yet: the only snapshot is compared by counts — and says so.
      const first = cli(['review', '-r', dir, '--json', '--fail-on', 'low']);
      expect(first.code, first.stderr).toBe(0);
      expect(first.stderr).toContain('no review baseline yet');
      expect(JSON.parse(first.stdout).severity).toBe('none');

      analyze(dir);
      expect(existsSync(path.join(dir, '.facts', 'baseline', 'agent.json'))).toBe(true);
      const r = cli(['review', '-r', dir, '--json', '--fail-on', 'low']);
      expect(r.code, r.stderr).toBe(0);
      const verdict = JSON.parse(r.stdout);
      expect(verdict.severity).toBe('none');
      expect(JSON.stringify(verdict.findings ?? [])).not.toMatch(/cycle|secret/i);
      expect(r.stderr).not.toContain('no review baseline yet');
    },
    T,
  );

  it(
    '--fail-on none never fails; an unknown value exits 2 (CLI-11)',
    () => {
      const dir = fixture();
      analyze(dir);
      const agent = path.join(dir, '.facts', 'agent.json');
      expect(cli(['review', agent, agent, '--fail-on', 'none']).code).toBe(0);
      expect(cli(['review', agent, agent, '--fail-on', 'nope']).code).toBe(2);
    },
    T,
  );
});

describe('query targets typed the Windows way (CLI-06)', () => {
  it(
    'backslash, ./ and absolute paths all resolve to the artifact path',
    () => {
      const dir = fixture();
      analyze(dir);
      for (const t of ['src\\a.ts', '.\\src\\a.ts', './src/a.ts', path.join(dir, 'src', 'a.ts')]) {
        const r = cli(['query', 'callers', t, '-r', dir, '--json']);
        expect(r.code, r.stderr).toBe(0);
        const out = JSON.parse(r.stdout);
        expect(out.count, t).toBe(2);
        expect(out.results.sort()).toEqual(['src/b.ts', 'src/c.ts']);
      }
      const miss = cli(['query', 'callers', 'src/nope.ts', '-r', dir]);
      expect(miss.stderr).toContain('is not a file in the graph');
    },
    T,
  );
});

describe('flag validation (CLI-11)', () => {
  it(
    'outdated rejects a non-numeric --fail-on before any network call',
    () => {
      const r = cli(['outdated', fixture(), '--fail-on', 'five']);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('--fail-on must be a number');
    },
    T,
  );

  it(
    'telemetry rejects a mistyped action instead of showing status',
    () => {
      const r = cli(['telemetry', 'optout']);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/unknown action "optout".*opt-out/);
    },
    T,
  );
});

describe('scan carry-forward (data-model#46)', () => {
  it(
    'a malformed prior vulnerability scan no longer breaks every later analyze',
    () => {
      const dir = fixture();
      analyze(dir);
      const p = path.join(dir, '.facts', 'agent.json');
      const art = JSON.parse(readFileSync(p, 'utf8'));
      art.vulnerabilityScan = { scannedAt: '2026-09-01T00:00:00.000Z', findings: 1 }; // no packagesQueried/Skipped
      art.vulnerabilities = [{ id: 'GHSA-x', severity: 'high' }]; // no installedVersion …
      writeFileSync(p, JSON.stringify(art));
      const r = analyze(dir);
      expect(r.stderr).toMatch(/vulns: .*scan-vulns/);
      expect(cli(['export', dir, '-o', path.join(dir, 'out')]).code).toBe(0);
    },
    T,
  );
});

/* performance#9: only `analyze` opened the F8 parse cache; `export`,
   `quick` and `ui` re-parsed every file on every run. */
type SqliteModule = {
  DatabaseSync: new (
    file: string,
    options?: { readOnly?: boolean },
  ) => { prepare(sql: string): { get(): unknown }; close(): void };
};
describe('export uses the F8 parse cache (performance#9)', () => {
  it(
    'a fresh project (no .facts) gets a populated .facts/cache.db from export alone',
    async () => {
      const dir = fixture();
      expect(existsSync(path.join(dir, '.facts'))).toBe(false);
      const r = cli(['export', dir, '-o', path.join(dir, 'out')]);
      expect(r.code, r.stderr).toBe(0);
      const db = path.join(dir, '.facts', 'cache.db');
      expect(existsSync(db)).toBe(true);
      // @types/node@20 has no node:sqlite typings (as in doctor.ts): a string
      // spec keeps tsc from resolving it, and SqliteModule types what we read.
      const sqliteSpec: string = 'node:sqlite';
      const { DatabaseSync } = (await import(sqliteSpec)) as SqliteModule;
      const conn = new DatabaseSync(db, { readOnly: true });
      try {
        const row = conn.prepare('SELECT COUNT(*) AS n FROM extraction').get() as { n: number };
        expect(row.n).toBeGreaterThanOrEqual(3); // src/a.ts, b.ts, c.ts parsed once, cached
      } finally {
        conn.close();
      }
    },
    T,
  );
});

/* data-model#3: emit reports why it wrote no agent.diff.pack (duplicate PK,
   schema change, unreadable previous pack); the CLI used to swallow it. */
describe('a skipped agent.diff.pack says why (data-model#3)', () => {
  it(
    'analyze (TTY + --json) and the analyzeAndWrite paths print the reason; a clean run does not',
    () => {
      const dir = fixture();
      analyze(dir);
      const pack = path.join(dir, '.facts', 'agent.pack');
      const reason = /no agent\.diff\.pack: previous agent\.pack /;

      writeFileSync(pack, 'not a pack\n');
      expect(analyze(dir).stderr).toMatch(reason);

      writeFileSync(pack, 'not a pack\n');
      const json = analyze(dir, '--json');
      expect(json.stderr).toMatch(reason);
      expect(JSON.parse(json.stdout).diffSkipped).toMatch(/^previous agent\.pack /);

      // `quick --reanalyze` goes through analyzeAndWrite (as ui/watch/export do).
      writeFileSync(pack, 'not a pack\n');
      const tmp = { TEMP: dir, TMP: dir, TMPDIR: dir }; // its report lands in the fixture
      const quick = cli(['quick', dir, '--reanalyze', '--no-open'], CLI_ROOT, tmp);
      expect(quick.code, quick.stderr).toBe(0);
      expect(quick.stderr).toMatch(reason);

      const clean = analyze(dir);
      expect(clean.stderr).not.toContain('no agent.diff.pack');
      expect(clean.stderr).toContain('agent.diff.pack');
    },
    T,
  );
});

describe('--minimal reuses the cached git topology (performance#2/#8)', () => {
  it(
    'a full analyze refreshes the cache; the hook path reads it without re-mining',
    () => {
      const dir = fixture();
      git(dir, 'init', '-q');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'init');
      const cache = path.join(dir, '.facts', 'topology-cache.json');
      const savedAt = () => JSON.parse(readFileSync(cache, 'utf8')).savedAt as number;

      analyze(dir);
      const first = savedAt();
      analyze(dir, '--minimal');
      expect(savedAt()).toBe(first); // reused: not re-mined, not rewritten
      analyze(dir);
      expect(savedAt()).toBeGreaterThan(first); // a full analyze refreshes it
    },
    T,
  );
});

describe('ci-report against a snapshot base (correctness#2)', () => {
  it(
    'reports the CVE delta as unavailable and skips the gate; a full base still gates',
    () => {
      const dir = fixture();
      analyze(dir);
      analyze(dir);
      const p = path.join(dir, '.facts', 'agent.json');
      const art = JSON.parse(readFileSync(p, 'utf8'));
      art.vulnerabilities = [
        {
          id: 'GHSA-existing',
          severity: 'high',
          ecosystem: 'npm',
          package: 'lodash',
          installedVersion: '4.17.0',
          fixedVersion: '4.17.21',
          advisoryUrl: 'https://github.com/advisories/GHSA-existing',
          lastChecked: 1_700_000_000_000,
          manifestPath: 'package.json',
        },
      ];
      writeFileSync(p, JSON.stringify(art));
      const snaps = path.join(dir, '.facts', 'snapshots');
      const snap = path.join(snaps, readdirSync(snaps).sort()[0]!);

      const viaSnapshot = cli(['ci-report', dir, '--base', snap, '--fail-on-shift', '1']);
      expect(viaSnapshot.code, viaSnapshot.stderr).toBe(0);
      expect(viaSnapshot.stdout).toContain('Vulnerability diff unavailable');
      expect(viaSnapshot.stdout).not.toContain('GHSA-existing');
      expect(viaSnapshot.stderr).toContain('--fail-on-shift skipped');

      const baseline = path.join(dir, '.facts', 'baseline', 'agent.json');
      const viaBaseline = cli(['ci-report', dir, '--base', baseline, '--fail-on-shift', '1']);
      expect(viaBaseline.code).toBe(1); // a real new advisory against a full base
      expect(viaBaseline.stdout).toContain('`GHSA-existing`');
    },
    T,
  );
});

/* ── the ui server ────────────────────────────────────────────────────── */

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function get(
  port: number,
  pathname: string,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('factstack ui — hardened server (security#3/#4, CLI-13, CLI-14)', () => {
  it(
    'serves a hash-only CSP, the vendored parser, and refuses cross-site loads',
    async () => {
      // The vendored parser is a build output (sync-ui); make sure it exists.
      const vendor = path.join(CLI_ROOT, 'src', 'ui', 'vendor', 'babel-parser.mjs');
      if (!existsSync(vendor)) {
        mkdirSync(path.dirname(vendor), { recursive: true });
        writeFileSync(vendor, await bundleBabelParser());
      }
      const dir = fixture();
      analyze(dir);
      const port = await freePort();
      const child = spawn(
        process.execPath,
        [
          TSX,
          CLI,
          'ui',
          dir,
          '--port',
          String(port),
          '--no-open',
          '--idle-timeout',
          '0',
          '--no-stale-check',
        ],
        { env, stdio: ['ignore', 'ignore', 'pipe'] },
      );
      try {
        await new Promise<void>((resolve, reject) => {
          let err = '';
          const t = setTimeout(() => reject(new Error(`ui did not start: ${err}`)), 60_000);
          child.stderr!.on('data', (c: Buffer) => {
            err += c.toString();
            if (err.includes('serving')) {
              clearTimeout(t);
              resolve();
            }
          });
          child.on('exit', (code) => reject(new Error(`ui exited ${code}: ${err}`)));
        });

        const page = await get(port, '/');
        expect(page.status).toBe(200);
        const csp = String(page.headers['content-security-policy']);
        const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src ')) ?? '';
        expect(scriptSrc).toMatch(/'sha256-/);
        expect(scriptSrc).not.toMatch(/unsafe-inline|unsafe-eval/);
        expect(csp).toContain("frame-ancestors 'none'");
        expect(page.headers['x-content-type-options']).toBe('nosniff');
        expect(page.body).not.toMatch(/cdn\.jsdelivr|esm\.sh|fonts\.googleapis/);

        const parser = await get(port, '/vendor/babel-parser.mjs');
        expect(parser.status).toBe(200);
        expect(String(parser.headers['content-type'])).toMatch(/^text\/javascript/);
        expect((await get(port, '/vendor/..%2Fpackage.json')).status).toBe(404);
        expect((await get(port, '/vendor/other.mjs')).status).toBe(404);

        // CLI-13: the unused exec/browse/file-history endpoints are gone.
        for (const p of ['/api/exec', '/api/browse', '/api/file-history?file=src/a.ts']) {
          expect((await get(port, p)).status, p).toBe(404);
        }

        // CLI-14: a cross-site subresource load (no Origin) is refused…
        const xsite = await get(port, '/api/file?path=src/a.ts', {
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'no-cors',
        });
        expect(xsite.status).toBe(403);
        const nav = {
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
        };
        expect((await get(port, '/api/file?path=src/a.ts', nav)).status).toBe(403);
        expect(
          (await get(port, '/data/factstack.json', { 'sec-fetch-site': 'same-site' })).status,
        ).toBe(403);
        // A link from another site to the dashboard page itself still opens it.
        expect((await get(port, '/', nav)).status).toBe(200);
        // …a same-origin one still works, and is never sniffable as script.
        const own = await get(port, '/api/file?path=src/a.ts', { 'sec-fetch-site': 'same-origin' });
        expect(own.status).toBe(200);
        expect(own.headers['x-content-type-options']).toBe('nosniff');
        expect(own.headers['cross-origin-resource-policy']).toBe('same-origin');
      } finally {
        child.kill();
      }
    },
    T,
  );
});

/* ── git post-commit hook ─────────────────────────────────────────────── */

/* R2: a global core.hooksPath made `hook install` write a hook that ran
   `npx factstack analyze` in every repository on the machine. */
describe('hook install refuses a shared hooks dir (R2)', () => {
  it(
    'a global core.hooksPath: refused with the line to add, nothing written; --shared installs',
    () => {
      const dir = fixture();
      git(dir, 'init', '-q');
      const cfgDir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'facts-e2e-gcfg-')));
      temps.push(cfgDir);
      const globalHooks = path.join(cfgDir, 'globalhooks');
      const cfg = path.join(cfgDir, 'gitconfig');
      writeFileSync(
        cfg,
        readFileSync(env.GIT_CONFIG_GLOBAL!, 'utf8') +
          `[core]\n\thooksPath = ${globalHooks.replaceAll('\\', '/')}\n`,
      );
      const args = ['hook', 'install', dir, '--command', 'node x.js analyze'];
      const refused = cli(args, CLI_ROOT, { GIT_CONFIG_GLOBAL: cfg });
      expect(refused.code).toBe(1);
      expect(refused.stderr).toMatch(/global git config.*every repository/);
      expect(refused.stderr).toContain('--shared');
      expect(refused.stderr).toContain('node x.js analyze . >/dev/null 2>&1 || true');
      expect(existsSync(path.join(globalHooks, 'post-commit'))).toBe(false);
      expect(existsSync(path.join(dir, '.git', 'hooks', 'post-commit'))).toBe(false);

      const forced = cli([...args, '--shared'], CLI_ROOT, { GIT_CONFIG_GLOBAL: cfg });
      expect(forced.code, forced.stderr).toBe(0);
      expect(forced.stderr).toContain('shared hooks dir');
      expect(readFileSync(path.join(globalHooks, 'post-commit'), 'utf8')).toContain(
        'node x.js analyze .',
      );
    },
    T,
  );
});

/* ── install / setup-agents ───────────────────────────────────────────── */

describe('install, setup-agents and uninstall', () => {
  it(
    'keeps a hand-written .cursorrules, refreshes a FACTS-managed one, and removes the hook on uninstall',
    () => {
      const dir = fixture();
      git(dir, 'init', '-q');
      analyze(dir);

      // A hand-written rules file must survive every entry point.
      writeFileSync(path.join(dir, '.cursorrules'), 'my own rules\n');
      const setup = cli(['setup-agents', dir, '--json']);
      expect(setup.code, setup.stderr).toBe(0);
      const s = JSON.parse(setup.stdout);
      expect(s.preserved).toContain('.cursorrules');
      expect(readFileSync(path.join(dir, '.cursorrules'), 'utf8')).toBe('my own rules\n');
      expect(s.hook.gitignore).toBe('added');
      expect(readFileSync(path.join(dir, '.gitignore'), 'utf8')).toContain(
        '/.claude/settings.local.json',
      );

      // A FACTS-managed one (the marker) is refreshed.
      writeFileSync(
        path.join(dir, '.cursorrules'),
        '<!-- factstack:managed · stale -->\nSTALE-GENERATED-BODY\n',
      );
      const install = cli(['install', dir, '--agent', 'all', '--json']);
      expect(install.code, install.stderr).toBe(0);
      const inst = JSON.parse(install.stdout);
      // mcp-pkg-3: the flag follows MCP_PUBLISHED, so publishing cannot turn this red.
      if (!MCP_PUBLISHED) expect(inst.serverNote).toMatch(/not on npm yet/);
      else if (inst.serverNote !== undefined) {
        expect(inst.serverNote).not.toMatch(/not on npm yet/);
        expect(inst.serverNote).toContain(MCP_NPX);
      }
      // ux#8: every config pins the server to this project with an absolute --root.
      const pinnedArgs = [...parseServerCommand(MCP_NPX)!.args, '--root', dir];
      expect(inst.server).toEqual({ command: 'npx', args: pinnedArgs });
      const mcpJson = JSON.parse(readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
      expect(mcpJson.mcpServers.factstack.args).toEqual(pinnedArgs);
      const vscode = JSON.parse(readFileSync(path.join(dir, '.vscode', 'mcp.json'), 'utf8'));
      expect(vscode.servers.factstack).toMatchObject({ type: 'stdio', args: pinnedArgs });
      const again = JSON.parse(cli(['install', dir, '--agent', 'all', '--json']).stdout);
      expect(again.agents.map((a: { mcpStatus: string }) => a.mcpStatus)).toEqual([
        'already-installed',
        'already-installed',
        'already-installed',
      ]);
      const cursor = inst.agents.find((a: { agent: string }) => a.agent === 'cursor');
      expect(cursor.skills).toContain('.cursorrules');
      expect(readFileSync(path.join(dir, '.cursorrules'), 'utf8')).not.toContain(
        'STALE-GENERATED-BODY',
      );

      const settings = path.join(dir, '.claude', 'settings.local.json');
      expect(readFileSync(settings, 'utf8')).toContain(FRESHNESS_HOOK_COMMAND);
      const un = cli(['uninstall', dir, '--json']);
      expect(un.code, un.stderr).toBe(0);
      expect(JSON.parse(un.stdout).hook.removed).toEqual([FRESHNESS_HOOK_COMMAND]);
      expect(readFileSync(settings, 'utf8')).not.toContain('factstack');
    },
    T,
  );

  it(
    'keeps a FACTS hook command the user set up, chained logic included (R3)',
    () => {
      const dir = fixture();
      analyze(dir);
      mkdirSync(path.join(dir, '.claude'));
      const settings = path.join(dir, '.claude', 'settings.local.json');
      const chained = 'pnpm exec factstack analyze --minimal && pnpm test';
      const before =
        JSON.stringify(
          {
            permissions: { deny: ['Read(./.env)'] },
            hooks: {
              PostToolUse: [
                { matcher: 'Edit|Write', hooks: [{ type: 'command', command: chained }] },
              ],
            },
          },
          null,
          2,
        ) + '\n';
      writeFileSync(settings, before);

      const inst = cli(['install', dir, '--agent', 'claude', '--json']);
      expect(inst.code, inst.stderr).toBe(0);
      const claude = JSON.parse(inst.stdout).agents[0];
      expect(claude.hookCommand).toBe(chained);
      expect(claude.hookKept).toEqual([chained]);
      expect(readFileSync(settings, 'utf8')).toBe(before);

      const setup = cli(['setup-agents', dir, '--json']);
      expect(setup.code, setup.stderr).toBe(0);
      expect(JSON.parse(setup.stdout).hook.kept).toEqual([chained]);
      expect(readFileSync(settings, 'utf8')).toBe(before);

      const un = cli(['uninstall', dir, '--agent', 'claude', '--json']);
      expect(JSON.parse(un.stdout).hook).toEqual({ removed: [], kept: [chained] });
      expect(readFileSync(settings, 'utf8')).toBe(before);
    },
    T,
  );

  it(
    'a relative --root in --server-command is refused; an absolute or client-variable one is kept (ux#8)',
    () => {
      const dir = fixture();
      analyze(dir);
      const rel = cli([
        'install',
        dir,
        '--agent',
        'cursor',
        '--json',
        '--server-command',
        'node srv.js --root .',
      ]);
      expect(rel.code).toBe(1);
      const cursor = JSON.parse(rel.stdout).agents[0];
      expect(cursor.mcpStatus).toBe('failed');
      expect(cursor.mcpError).toMatch(/--root "\." is not an absolute path/);
      expect(existsSync(path.join(dir, '.cursor', 'mcp.json'))).toBe(false);

      const kept = cli([
        'install',
        dir,
        '--agent',
        'cursor',
        '--json',
        '--server-command',
        'node srv.js --root ${workspaceFolder}',
      ]);
      expect(kept.code, kept.stderr).toBe(0);
      const out = JSON.parse(kept.stdout);
      expect(out.serverNote).toBeUndefined(); // an override is never flagged
      expect(out.server.args).toEqual(['srv.js', '--root', '${workspaceFolder}']);
      const cfg = JSON.parse(readFileSync(path.join(dir, '.cursor', 'mcp.json'), 'utf8'));
      expect(cfg.mcpServers.factstack.args).toEqual(['srv.js', '--root', '${workspaceFolder}']);
    },
    T,
  );

  it(
    '--help says "not on npm" only while the package is unpublished (cli-r3-4)',
    () => {
      const help = (...cmd: string[]) => {
        const r = cli([...cmd, '--help']);
        expect(r.code, r.stderr).toBe(0);
        return r.stdout.replace(/\s+/g, ' '); // commander wraps long help
      };
      expect(help('install')).toContain(`(default: \`${MCP_NPX}\``);
      expect(help('install').includes('not on npm until the package is published')).toBe(
        !MCP_PUBLISHED,
      );
      for (const cmd of ['setup-agents', 'hook']) {
        expect(help(cmd).includes('not on npm until it is published')).toBe(!CLI_PUBLISHED);
      }
    },
    T,
  );

  it(
    'reports a malformed settings.local.json as a failed hook without touching it',
    () => {
      const dir = fixture();
      analyze(dir);
      mkdirSync(path.join(dir, '.claude'));
      const settings = path.join(dir, '.claude', 'settings.local.json');
      writeFileSync(settings, '{ "permissions": { "deny": ["Read(./.env)"], } }');
      const r = cli(['install', dir, '--agent', 'claude', '--json']);
      const claude = JSON.parse(r.stdout).agents[0];
      expect(claude.hook).toBe('failed');
      expect(claude.hookError).toMatch(/refusing to overwrite/);
      expect(readFileSync(settings, 'utf8')).toBe(
        '{ "permissions": { "deny": ["Read(./.env)"], } }',
      );
    },
    T,
  );
});
