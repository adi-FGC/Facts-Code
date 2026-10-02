/**
 * The `factstack ui` server's security layer, tested on its own (tech-debt#6
 * — it used to live in closures inside cli.ts's `ui` action, reachable only
 * through a spawned binary): the Origin/Host guard (CSRF + DNS rebinding),
 * Fetch Metadata (CLI-14), path containment incl. symlink escapes, the body
 * and file size caps, the hash-only CSP page, /vendor/*, the removed
 * endpoints (CLI-13), and the serialized re-analyze + SSE push.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { connect, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { humanToViz, type VizArtifact } from '@factstack/emit';
import type { AgentArtifact, HumanArtifact } from '@factstack/spec';
import { analyzeProject } from '../src/pipeline.js';
import {
  createUiServer,
  isCrossSiteFetch,
  isInside,
  isOriginAllowed,
  readBody,
  safeResolveInside,
  type UiServer,
} from '../src/ui-server.js';
import { readUiTemplate } from '../src/uiTemplate.js';
import { fixtureProject, hermeticEnv } from './cli-io.js';

const temps: string[] = [];
const tempDir = (prefix: string): string => {
  const d = realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
  temps.push(d);
  return d;
};
let restoreEnv: () => void = () => {};
beforeAll(() => {
  restoreEnv = hermeticEnv();
});
afterAll(() => {
  restoreEnv();
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const req = (headers: Record<string, string | string[]>, method = 'GET', url = '/') =>
  ({ headers, method, url }) as unknown as IncomingMessage;

/* ── isOriginAllowed: CSRF / DNS-rebind (ft-8) ────────────────────────── */

describe('isOriginAllowed', () => {
  const PORT = 4747;

  it.each([
    'http://127.0.0.1:4747',
    'http://localhost:4747',
    'http://[::1]:4747',
    'https://localhost:4747',
  ])('accepts its own origin %s', (origin) => {
    expect(isOriginAllowed(req({ origin }), PORT)).toBe(true);
  });

  it.each([
    ['a foreign origin', 'https://evil.example'],
    ['the right host on another port', 'http://127.0.0.1:4748'],
    ['a rebinding hostname', 'http://evil.example:4747'],
    ['the opaque origin of file://, data: and sandboxed frames', 'null'],
    ['an unparsable origin', 'not a url'],
  ])('rejects %s', (_label, origin) => {
    // …even when the Host header looks local: Origin wins.
    expect(isOriginAllowed(req({ origin, host: '127.0.0.1:4747' }), PORT)).toBe(false);
  });

  it('falls back to Host when there is no Origin', () => {
    expect(isOriginAllowed(req({ host: '127.0.0.1:4747' }), PORT)).toBe(true);
    expect(isOriginAllowed(req({ host: 'localhost:4747' }), PORT)).toBe(true);
    expect(isOriginAllowed(req({ host: 'evil.example:4747' }), PORT)).toBe(false);
    expect(isOriginAllowed(req({ host: '127.0.0.1' }), PORT)).toBe(false);
  });

  it('denies a request with neither Origin nor Host (default-deny)', () => {
    expect(isOriginAllowed(req({}), PORT)).toBe(false);
  });
});

/* ── isCrossSiteFetch: Fetch Metadata (CLI-14) ────────────────────────── */

describe('isCrossSiteFetch', () => {
  const nav = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };

  it('lets non-browser clients, same-origin and user-typed requests through', () => {
    expect(isCrossSiteFetch(req({}))).toBe(false);
    expect(isCrossSiteFetch(req({ 'sec-fetch-site': 'same-origin' }, 'GET', '/api/file'))).toBe(
      false,
    );
    expect(isCrossSiteFetch(req({ 'sec-fetch-site': 'none' }, 'GET', '/api/file'))).toBe(false);
    expect(isCrossSiteFetch(req({ 'sec-fetch-site': 'Same-Origin' }, 'GET', '/'))).toBe(false);
  });

  it('refuses cross-site and same-site subresource loads (no Origin sent)', () => {
    for (const site of ['cross-site', 'same-site']) {
      expect(
        isCrossSiteFetch(req({ 'sec-fetch-site': site, 'sec-fetch-mode': 'no-cors' }, 'GET', '/')),
      ).toBe(true);
      expect(isCrossSiteFetch(req({ 'sec-fetch-site': site }, 'GET', '/api/file?path=a'))).toBe(
        true,
      );
    }
  });

  it('allows only a top-level GET navigation to the dashboard page itself', () => {
    const site = { 'sec-fetch-site': 'cross-site', ...nav };
    expect(isCrossSiteFetch(req(site, 'GET', '/'))).toBe(false);
    expect(isCrossSiteFetch(req(site, 'GET', '/index.html?x=1'))).toBe(false);
    expect(isCrossSiteFetch(req(site, 'GET', '/api/file?path=src/a.ts'))).toBe(true);
    expect(isCrossSiteFetch(req(site, 'GET', '/data/factstack.json'))).toBe(true);
    expect(isCrossSiteFetch(req(site, 'POST', '/'))).toBe(true);
    expect(isCrossSiteFetch(req({ ...site, 'sec-fetch-dest': 'iframe' }, 'GET', '/'))).toBe(true);
  });

  it('reads the first value of a repeated header', () => {
    expect(isCrossSiteFetch(req({ 'sec-fetch-site': ['cross-site', 'same-origin'] }))).toBe(true);
    expect(isCrossSiteFetch(req({ 'sec-fetch-site': ['same-origin', 'cross-site'] }))).toBe(false);
  });
});

/* ── safeResolveInside: path containment ──────────────────────────────── */

/** A directory link that needs no privilege: a junction on Windows, a
 *  plain symlink elsewhere — so the escape cases always run. */
function linkDir(target: string, at: string): void {
  symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
}

describe('safeResolveInside', () => {
  it('resolves paths inside the root; refuses every way out', () => {
    const base = tempDir('facts-contain-');
    const root = path.join(base, 'proj');
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'a.ts'), 'x');
    mkdirSync(path.join(base, 'proj-evil'));
    writeFileSync(path.join(base, 'proj-evil', 'secret.txt'), 's');
    writeFileSync(path.join(base, 'outside.txt'), 's');

    expect(safeResolveInside(root, 'src/a.ts')).toBe(path.join(root, 'src', 'a.ts'));
    expect(safeResolveInside(root, 'src/../src/a.ts')).toBe(path.join(root, 'src', 'a.ts'));
    expect(safeResolveInside(root, '')).toBe(root);
    // Not there yet: returned, so the caller answers 404, not 403.
    expect(safeResolveInside(root, 'src/new.ts')).toBe(path.join(root, 'src', 'new.ts'));

    expect(safeResolveInside(root, '../outside.txt')).toBeNull();
    expect(safeResolveInside(root, 'src/../../outside.txt')).toBeNull();
    expect(safeResolveInside(root, path.join(base, 'outside.txt'))).toBeNull();
    // A sibling that shares the root's name as a string prefix.
    expect(safeResolveInside(root, '../proj-evil/secret.txt')).toBeNull();
  });

  it('refuses a symlink leaf and a path through a symlinked directory that leaves the root', () => {
    const base = tempDir('facts-contain-link-');
    const root = path.join(base, 'proj');
    const outside = path.join(base, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'secret.txt'), 's');
    linkDir(outside, path.join(root, 'peek'));
    expect(safeResolveInside(root, 'peek')).toBeNull(); // the link itself
    expect(safeResolveInside(root, 'peek/secret.txt')).toBeNull(); // realpath lands outside
  });

  it('never follows a symlink leaf, even one that stays inside the root', () => {
    const root = tempDir('facts-contain-inner-');
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'a.ts'), 'x');
    linkDir(path.join(root, 'src'), path.join(root, 'alias'));
    expect(safeResolveInside(root, 'alias')).toBeNull();
    // A link mid-path that stays inside resolves to the real file.
    expect(safeResolveInside(root, 'alias/a.ts')).toBe(
      realpathSync(path.join(root, 'src', 'a.ts')),
    );
  });

  /* The real path of a file was checked against the UNRESOLVED root,
     so `factstack ui <a junction or symlink>` answered 403 for every file
     (and macOS /tmp → /private/tmp did the same). */
  it('serves files when the root itself is reached through a link', () => {
    const base = tempDir('facts-contain-root-link-');
    const real = path.join(base, 'real');
    mkdirSync(path.join(real, 'src'), { recursive: true });
    writeFileSync(path.join(real, 'src', 'a.ts'), 'x');
    writeFileSync(path.join(base, 'outside.txt'), 's');
    const link = path.join(base, 'link');
    linkDir(real, link);
    expect(safeResolveInside(link, 'src/a.ts')).toBe(realpathSync(path.join(real, 'src', 'a.ts')));
    // Still contained: a way out of the linked root is refused.
    expect(safeResolveInside(link, '../outside.txt')).toBeNull();
    expect(safeResolveInside(link, 'src/../../outside.txt')).toBeNull();
  });

  it('isInside: the root itself and descendants only', () => {
    const root = path.resolve(tmpdir(), 'r');
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, path.join(root, 'a', 'b'))).toBe(true);
    expect(isInside(root, path.resolve(tmpdir(), 'r-sibling'))).toBe(false);
    expect(isInside(root, path.dirname(root))).toBe(false);
  });
});

/* ── readBody: the request-body cap (ft-8) ────────────────────────────── */

describe('readBody', () => {
  function fakeReq(chunks: string[]): IncomingMessage & { destroyed: boolean } {
    const r = new EventEmitter() as unknown as IncomingMessage & { destroyed: boolean };
    r.destroyed = false;
    (r as unknown as { destroy: () => void }).destroy = () => {
      r.destroyed = true;
    };
    queueMicrotask(() => {
      for (const c of chunks) r.emit('data', c);
      r.emit('end');
    });
    return r;
  }

  it('returns a body under the cap', async () => {
    await expect(readBody(fakeReq(['{"a":', '1}']), 16)).resolves.toBe('{"a":1}');
  });

  it('rejects and destroys the request past the cap', async () => {
    const r = fakeReq(['x'.repeat(10), 'x'.repeat(10)]);
    await expect(readBody(r, 16)).rejects.toThrow('request body too large');
    expect(r.destroyed).toBe(true);
  });
});

/* ── createUiServer: the routes over a real socket ────────────────────── */

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function call(
  port: number,
  pathname: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: opts.method ?? 'GET',
        headers: opts.headers ?? {},
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    r.on('error', reject);
    r.end(opts.body);
  });
}

/** An HTTP/1.0 request with no Host header (Node answers HTTP/1.1 requests
 *  without Host with its own 400 before any handler runs). */
function rawNoHost(port: number, pathname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => sock.write(`GET ${pathname} HTTP/1.0\r\n\r\n`));
    let data = '';
    sock.setEncoding('utf8');
    sock.on('data', (c: string) => (data += c));
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
  });
}

describe('createUiServer', () => {
  let root = '';
  let port = 0;
  let ui: UiServer;
  let artifacts: { agent: AgentArtifact; human: HumanArtifact };
  let recentFile = '';
  let activity = 0;
  let reanalyzeRuns = 0;
  let active = 0;
  let maxActive = 0;
  let failNext = false;

  beforeAll(async () => {
    root = fixtureProject('facts-ui-server-');
    temps.push(root);
    const { agent, human } = await analyzeProject(root, { addGitignoreEntry: false });
    artifacts = { agent, human };
    // Added after the analyze, so the walker never reads them.
    writeFileSync(path.join(root, 'src', 'blob.bin'), Buffer.from([0x50, 0x4b, 0x00, 0x01]));
    writeFileSync(path.join(root, 'src', 'big.ts'), 'x'.repeat(2 * 1024 * 1024 + 1));
    const outside = tempDir('facts-ui-outside-');
    writeFileSync(path.join(outside, 'secret.txt'), 'TOP-SECRET');
    linkDir(outside, path.join(root, 'peek'));
    const viz: VizArtifact = humanToViz(agent, human);
    viz.project.root = root;
    recentFile = path.join(tempDir('facts-ui-recent-'), 'recent.json');
    writeFileSync(
      recentFile,
      JSON.stringify([{ path: root, name: 'demo', scannedAt: '2026-09-24T00:00:00.000Z' }]),
    );
    port = await freePort();
    ui = createUiServer({
      root,
      port,
      template: readUiTemplate(),
      viz,
      recentFile,
      onActivity: () => activity++,
      reanalyze: async () => {
        reanalyzeRuns++;
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 40));
        active--;
        if (failNext) {
          failNext = false;
          throw new Error('analyze blew up');
        }
        return artifacts;
      },
    });
    await new Promise<void>((resolve) => ui.server.listen(port, '127.0.0.1', resolve));
  }, 120_000);

  afterAll(async () => {
    (ui?.server as unknown as { closeAllConnections?: () => void })?.closeAllConnections?.();
    await new Promise((r) => ui?.server.close(r));
  });

  const same = { 'sec-fetch-site': 'same-origin' };

  it('serves the dashboard with the hash-only CSP and the hardening headers', async () => {
    const before = activity;
    const page = await call(port, '/');
    expect(page.status).toBe(200);
    const csp = String(page.headers['content-security-policy']);
    const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src ')) ?? '';
    expect(scriptSrc).toMatch(/'sha256-/);
    expect(scriptSrc).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.body).toContain('<script id="factstack-data" type="application/json">');
    expect(activity).toBeGreaterThan(before); // every request resets the idle timer

    const data = await call(port, '/data/factstack.json');
    expect(data.status).toBe(200);
    expect(JSON.parse(data.body).project.root).toBe(root);
  });

  it('refuses foreign origins, opaque origins, rebinding hosts and Host-less requests with 403', async () => {
    for (const headers of [
      { origin: 'https://evil.example' },
      { origin: 'null' },
      { origin: `http://127.0.0.1:${port + 1}` },
      { host: `evil.example:${port}` },
    ]) {
      const r = await call(port, '/data/factstack.json', { headers });
      expect(r.status, JSON.stringify(headers)).toBe(403);
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.body).toContain('cross-origin request rejected');
    }
    expect(await rawNoHost(port, '/data/factstack.json')).toMatch(/^HTTP\/1\.1 403 /);
  });

  it('a cross-site page cannot trigger the filesystem-write endpoint', async () => {
    for (const headers of [
      { origin: 'https://evil.example', 'content-type': 'text/plain' },
      { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' },
    ]) {
      const r = await call(port, '/api/setup-agents', { method: 'POST', headers, body: '{}' });
      expect(r.status).toBe(403);
    }
    expect(existsSync(path.join(root, 'AGENTS.md'))).toBe(false);
    expect(existsSync(path.join(root, '.cursorrules'))).toBe(false);
    expect(existsSync(path.join(root, '.claude'))).toBe(false);
  });

  it('refuses cross-site subresource loads but opens a navigation to the page (CLI-14)', async () => {
    const xsite = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' };
    expect((await call(port, '/api/file?path=src/a.ts', { headers: xsite })).status).toBe(403);
    const nav = {
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    };
    expect((await call(port, '/api/file?path=src/a.ts', { headers: nav })).status).toBe(403);
    expect((await call(port, '/', { headers: nav })).status).toBe(200);
  });

  it('/api/file: contained, capped, text only', async () => {
    const ok = await call(port, '/api/file?path=src/a.ts', { headers: same });
    expect(ok.status).toBe(200);
    expect(ok.body).toContain('export const a');
    expect(ok.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect((await call(port, '/api/file?path=.\\src\\a.ts')).status).toBe(200);

    const status = async (p: string) => (await call(port, `/api/file?path=${p}`)).status;
    expect(await status('')).toBe(400); // path required
    expect(await status('src')).toBe(400); // a directory
    expect(await status('src/nope.ts')).toBe(404);
    expect(await status('..%2Fpackage.json')).toBe(403);
    expect(await status(encodeURIComponent('../../etc/passwd'))).toBe(403);
    expect(await status(encodeURIComponent(path.join(path.dirname(root), 'x.txt')))).toBe(403);
    expect(await status('peek%2Fsecret.txt')).toBe(403); // through a linked dir
    expect(await status('peek')).toBe(403); // the link itself
    expect(await status('src/blob.bin')).toBe(415); // binary
    expect(await status('src/big.ts')).toBe(413); // over the 2 MB cap
  });

  it('/api/outline: contained, JSON', async () => {
    const ok = await call(port, '/api/outline?path=src/c.ts');
    expect(ok.status).toBe(200);
    const body = JSON.parse(ok.body);
    expect(body).toMatchObject({ path: 'src/c.ts', ext: '.ts' });
    expect(Array.isArray(body.outline)).toBe(true);
    expect((await call(port, '/api/outline?path=..%2Foutside.ts')).status).toBe(403);
    const missing = await call(port, '/api/outline?path=src/nope.ts');
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body)).toMatchObject({ outline: [], error: 'not found' });
    expect((await call(port, '/api/outline?path=src/big.ts')).status).toBe(413);
  });

  it('serves only allow-listed /vendor modules; the removed endpoints stay gone (CLI-13)', async () => {
    expect((await call(port, '/vendor/..%2Fpackage.json')).status).toBe(404);
    expect((await call(port, '/vendor/other.mjs')).status).toBe(404);
    for (const p of ['/api/exec', '/api/browse', '/api/file-history?file=src/a.ts']) {
      expect((await call(port, p)).status, p).toBe(404);
      expect((await call(port, p, { method: 'POST', body: '{}' })).status, p).toBe(404);
    }
    expect((await call(port, '/nope')).status).toBe(404);
  });

  it('/api/recent reads the recents file', async () => {
    const r = await call(port, '/api/recent');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(r.body)).toEqual({
      ok: true,
      recent: [{ path: root, name: 'demo', scannedAt: '2026-09-24T00:00:00.000Z' }],
    });
  });

  it('re-analyzes one run at a time and pushes an SSE update', async () => {
    const events: string[] = [];
    const sse = request({ host: '127.0.0.1', port, path: '/api/events', headers: same });
    const opened = new Promise<void>((resolve) => {
      sse.on('response', (res) => {
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          events.push(c);
          resolve();
        });
      });
    });
    sse.end();
    await opened; // the ': hello' comment

    const before = reanalyzeRuns;
    const [a, b] = await Promise.all([
      call(port, '/api/reanalyze', { method: 'POST', headers: same }),
      call(port, '/api/reanalyze', { method: 'POST', headers: same }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(JSON.parse(a.body)).toEqual({ ok: true, stats: artifacts.agent.stats });
    expect(reanalyzeRuns - before).toBe(2);
    expect(maxActive).toBe(1); // serialized: never two analyzes writing at once

    failNext = true;
    const failed = await call(port, '/api/reanalyze', { method: 'POST', headers: same });
    expect(failed.status).toBe(500);
    expect(JSON.parse(failed.body)).toEqual({ ok: false, error: 'analyze blew up' });

    // A watcher-triggered failure is pushed to the dashboards, never thrown.
    failNext = true;
    ui.queueWatchReanalyze();
    await expect.poll(() => events.join(''), { timeout: 5_000 }).toContain('event: error');
    expect(events.join('')).toContain('event: update');
    expect(events.join('')).toContain('"reason":"user"');
    expect(events.join('')).toContain('analyze blew up');
    sse.destroy();
  });

  it('/api/setup-agents keeps what the CLI keeps: an existing AGENTS.md, a marker-less rules file', async () => {
    writeFileSync(path.join(root, 'AGENTS.md'), '# our own agent guide\n');
    writeFileSync(path.join(root, '.cursorrules'), 'our own rules\n');
    const r = await call(port, '/api/setup-agents', { method: 'POST', headers: same, body: '{}' });
    expect(r.status, r.body).toBe(200);
    const out = JSON.parse(r.body);
    expect(out).toMatchObject({ ok: true, hookInstalled: true });
    expect([...out.preserved].sort()).toEqual(['.cursorrules', 'AGENTS.md']);
    expect(out.files).toContain('.github/copilot-instructions.md');
    expect(out.files).not.toContain('AGENTS.md');
    expect(readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toBe('# our own agent guide\n');
    expect(readFileSync(path.join(root, '.cursorrules'), 'utf8')).toBe('our own rules\n');
  });
});
