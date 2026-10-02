/**
 * apps/ui-remix/scripts/gen-fb-config.mjs — where the public Firebase web
 * config comes from, and what happens when it is nowhere.
 *
 * Regression: fb.mjs exists only in the owner's MAIN checkout, the script only
 * looked at the checkout it ran in, and it exited 0 when the file was missing.
 * Every build from a linked worktree (how production was deployed) and every
 * CI build silently shipped without dist/mcp-auth-config.json; the SPA
 * fallback then served index.html for it and the sign-in page broke.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findFbConfig,
  parseFbEnv,
  parseFbSnippet,
} from '../apps/ui-remix/scripts/gen-fb-config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'apps/ui-remix/scripts/gen-fb-config.mjs');
const SNIPPET = `// Firebase console snippet
const firebaseConfig = {
  apiKey: "AIza-test-key",
  authDomain: "demo.firebaseapp.com",
  projectId: "demo-project",
  appId: "1:2:web:3"
};`;
const ENV_JSON = JSON.stringify({ apiKey: 'AIza-env', projectId: 'env-project', extra: 'dropped' });

const temps = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'fx-fb-'));
  temps.push(d);
  return d;
};
afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

const run = (args, env = {}) => {
  const clean = { ...process.env };
  delete clean.FACTS_FB_WEB_CONFIG;
  delete clean.GITHUB_ACTIONS;
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...clean, ...env },
  });
};

describe('config sources', () => {
  it('parses the console snippet and the env JSON (unknown keys dropped)', () => {
    expect(parseFbSnippet(SNIPPET)).toMatchObject({
      apiKey: 'AIza-test-key',
      projectId: 'demo-project',
    });
    expect(parseFbEnv(ENV_JSON)).toEqual({ apiKey: 'AIza-env', projectId: 'env-project' });
  });

  it("finds the MAIN checkout's fb.mjs from a linked worktree", () => {
    const main = tmp();
    const worktree = join(main, '.claude', 'worktrees', 'wt');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(main, 'fb.mjs'), SNIPPET);
    const got = findFbConfig({ root: worktree, env: {}, mainCheckout: main });
    expect(got.cfg?.projectId).toBe('demo-project');
    expect(got.source).toBe(join(main, 'fb.mjs'));
  });

  it('falls back to FACTS_FB_WEB_CONFIG when no fb.mjs exists', () => {
    const got = findFbConfig({
      root: tmp(),
      env: { FACTS_FB_WEB_CONFIG: ENV_JSON },
      mainCheckout: null,
    });
    expect(got).toMatchObject({ source: 'FACTS_FB_WEB_CONFIG', cfg: { projectId: 'env-project' } });
  });

  it('reports malformed env JSON instead of throwing', () => {
    const got = findFbConfig({
      root: tmp(),
      env: { FACTS_FB_WEB_CONFIG: '{nope' },
      mainCheckout: null,
    });
    expect(got.cfg).toBeNull();
    expect(got.problems.join()).toMatch(/not valid JSON/);
  });
});

describe('CLI', () => {
  it('warns loudly and exits 0 when nothing is found (plain build)', () => {
    const root = tmp();
    const r = run(['--root', root, '--out', join(root, 'out.json')]);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/NOT written/);
    expect(r.stderr).toMatch(/BROKEN MCP sign-in page/);
    expect(existsSync(join(root, 'out.json'))).toBe(false);
  });

  it('exits 1 under --require (deploy builds) when nothing is found', () => {
    const root = tmp();
    expect(run(['--require', '--root', root, '--out', join(root, 'out.json')]).status).toBe(1);
  });

  it('writes the file from FACTS_FB_WEB_CONFIG', () => {
    const root = tmp();
    const out = join(root, 'out.json');
    const r = run(['--require', '--root', root, '--out', out], { FACTS_FB_WEB_CONFIG: ENV_JSON });
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({
      apiKey: 'AIza-env',
      projectId: 'env-project',
    });
  });

  it('adds a GitHub Actions ::warning:: annotation in CI', () => {
    const root = tmp();
    const r = run(['--root', root, '--out', join(root, 'o.json')], { GITHUB_ACTIONS: 'true' });
    expect(r.stderr).toMatch(/::warning title=MCP sign-in config missing::/);
  });
});
