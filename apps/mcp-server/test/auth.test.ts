/**
 * auth.ts — the OPTIONAL cloud sign-in (tech-debt#7, ux#9, MCP-04).
 *
 * Isolated via FACTS_HOME (a temp dir) + a stubbed global fetch; each test
 * re-imports the module so its cached web config starts empty.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let home: string;
const load = async () => {
  vi.resetModules();
  return import('../src/auth.js');
};
const writeSession = (s: Record<string, unknown>) => {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'auth.json'), JSON.stringify(s));
};
const expired = { uid: 'u1', email: 'a@b.c', idToken: 'old', refreshToken: 'r1', expiresAt: 0 };
const CONFIG = { apiKey: 'k', projectId: 'p' };

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => handler(String(url), init));
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  home = join(mkdtempSync(join(tmpdir(), 'facts-auth-')), '.factstack');
  vi.stubEnv('FACTS_HOME', home);
  vi.stubEnv('FACTS_AUTH_URL', 'https://auth.example/mcp-auth.html');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('login hint', () => {
  it('is the one published npx pair from @factstack/spec', async () => {
    const auth = await load();
    expect(auth.LOGIN_COMMAND).toBe('npx -y factstack-mcp login');
    expect(auth.loginHint()).toContain('npx -y factstack-mcp login');
    expect(auth.loginHint()).not.toContain('@factstack/');
  });

  it("reads spec's one published flag, not a local mirror of it", async () => {
    const auth = await load();
    expect(auth.MCP_PUBLISHED).toBe((await import('@factstack/spec')).MCP_PUBLISHED);
    // The first command a reader (or an agent) meets is the one that works today.
    expect(auth.loginHint().match(/`([^`]+)`/)?.[1]).toBe(auth.SIGN_IN_COMMAND);
  });

  /* Both forms, whatever the flag says today, so the owner's publish change
     (PUBLISHING.md step 4) lands on a green suite. */
  const loadWithPublished = async (published: boolean) => {
    vi.resetModules();
    vi.doMock('@factstack/spec', async (orig) => ({
      ...(await orig<typeof import('@factstack/spec')>()),
      MCP_PUBLISHED: published,
    }));
    try {
      return await import('../src/auth.js');
    } finally {
      vi.doUnmock('@factstack/spec');
    }
  };

  it('offers only the from-a-clone command as runnable until factstack-mcp is on npm (MCP-R4)', async () => {
    const auth = await loadWithPublished(false);
    expect(auth.SIGN_IN_COMMAND).toBe('npx tsx apps/mcp-server/src/server.ts login');
    const hint = auth.loginHint();
    expect(hint.match(/`([^`]+)`/)?.[1]).toBe(auth.SIGN_IN_COMMAND);
    expect(hint).toMatch(/not on npm yet/);
  });

  it('offers the npx login once factstack-mcp is on npm', async () => {
    const auth = await loadWithPublished(true);
    expect(auth.SIGN_IN_COMMAND).toBe('npx -y factstack-mcp login');
    const hint = auth.loginHint();
    expect(hint.match(/`([^`]+)`/)?.[1]).toBe('npx -y factstack-mcp login');
    expect(hint).not.toMatch(/not on npm yet|apps\/mcp-server/);
  });
});

describe('buildOpenCommand (MCP-04: Windows cut the URL at "&")', () => {
  const url = 'https://auth.example/mcp-auth.html?port=5123&state=abc123';

  it('win32 passes the whole URL as ONE argv element to a non-shell program', async () => {
    const { buildOpenCommand } = await load();
    const c = buildOpenCommand('win32', url);
    expect(c.command).not.toBe('cmd'); // cmd.exe treats a bare & as a command separator
    expect(c.args.at(-1)).toBe(url);
    expect(c.args.join(' ')).toContain('&state=abc123');
  });

  it('darwin / linux use open / xdg-open with the URL intact', async () => {
    const { buildOpenCommand } = await load();
    expect(buildOpenCommand('darwin', url)).toEqual({ command: 'open', args: [url] });
    expect(buildOpenCommand('linux', url)).toEqual({ command: 'xdg-open', args: [url] });
  });

  it.runIf(process.platform === 'win32')(
    'on this Windows host a non-shell argv keeps "&state=" (cmd.exe does not)',
    () => {
      const echo = spawnSync(
        process.execPath,
        ['-e', 'process.stdout.write(process.argv[1])', url],
        {
          encoding: 'utf8',
        },
      );
      expect(echo.stdout).toBe(url);
      const viaCmd = spawnSync('cmd', ['/c', 'echo', url], { encoding: 'utf8' });
      expect(viaCmd.stdout).not.toContain('state=abc123'); // the bug the fix avoids
    },
  );
});

describe('cloudSession — sign-in is optional, never a network gate', () => {
  it('no auth.json → signed-out (no network)', async () => {
    const fetch = stubFetch(() => {
      throw new Error('no network expected');
    });
    const auth = await load();
    expect(await auth.cloudSession()).toEqual({ state: 'signed-out' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('corrupt / partial auth.json → signed-out, not a crash', async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'auth.json'), '{"uid": 1');
    let auth = await load();
    expect((await auth.cloudSession()).state).toBe('signed-out');
    writeSession({ uid: 'u' }); // valid JSON, missing tokens
    auth = await load();
    expect((await auth.cloudSession()).state).toBe('signed-out');
  });

  it('fresh token → ready without any fetch', async () => {
    writeSession({ ...expired, idToken: 'fresh', expiresAt: Date.now() + 3_600_000 });
    const fetch = stubFetch(() => {
      throw new Error('no network expected');
    });
    const auth = await load();
    const c = await auth.cloudSession();
    expect(c.state).toBe('ready');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('expired + auth host unreachable → paused (distinct from signed-out)', async () => {
    writeSession(expired);
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    const auth = await load();
    const c = await auth.cloudSession();
    expect(c.state).toBe('paused');
  });

  it('expired + refresh OK → ready, and the refreshed token is saved', async () => {
    writeSession(expired);
    const fetch = stubFetch((url) =>
      url.endsWith('/mcp-auth-config.json')
        ? Response.json(CONFIG)
        : Response.json({ id_token: 'new', refresh_token: 'r2', expires_in: '3600' }),
    );
    const auth = await load();
    const c = await auth.cloudSession();
    expect(c.state).toBe('ready');
    const saved = JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8'));
    expect(saved.idToken).toBe('new');
    expect(saved.refreshToken).toBe('r2');
    // Every network call is bounded by a timeout signal.
    for (const call of fetch.mock.calls) expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('refresh rejected (revoked token) → paused, file untouched', async () => {
    writeSession(expired);
    stubFetch((url) =>
      url.endsWith('/mcp-auth-config.json')
        ? Response.json(CONFIG)
        : new Response('{"error":"TOKEN_EXPIRED"}', { status: 400 }),
    );
    const auth = await load();
    const c = await auth.cloudSession();
    expect(c.state).toBe('paused');
    expect(JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8')).idToken).toBe('old');
  });

  it('a refresh without expires_in yields a finite expiry (no refresh on every call)', async () => {
    writeSession(expired);
    stubFetch((url) =>
      url.endsWith('/mcp-auth-config.json')
        ? Response.json(CONFIG)
        : Response.json({ id_token: 'n' }),
    );
    const auth = await load();
    const c = await auth.cloudSession();
    expect(c.state).toBe('ready');
    const exp = c.state === 'ready' ? c.session.expiresAt : NaN;
    expect(Number.isFinite(exp)).toBe(true);
    expect(exp).toBeGreaterThan(Date.now() + 3_000_000);
  });
});
