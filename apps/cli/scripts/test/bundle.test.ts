/**
 * deploy-infra#7 — the publishable single-file CLI. Builds the publish folder
 * into a temp dir and runs the bundle with plain Node from OUTSIDE the repo
 * (no node_modules, no tsx): the only way to prove every workspace package
 * and npm dependency really was inlined. Never publishes.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NODE_ENGINES } from '../../src/runtime.js';
import { CLI_ROOT, PUBLISH_NAME, bundleCli } from '../bundle.mjs';

const work = mkdtempSync(path.join(tmpdir(), 'facts-bundle-'));
const out = path.join(work, 'publish');
let built: Awaited<ReturnType<typeof bundleCli>>;

beforeAll(async () => {
  built = await bundleCli({ outDir: out });
}, 180_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

const run = (args: string[], cwd = work) =>
  spawnSync(process.execPath, [path.join(out, 'dist', 'cli.js'), ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, HOME: work, USERPROFILE: work, FORCE_COLOR: '0' },
  });

describe('publish folder', () => {
  it('is named factstack, bins factstack, pins the Node floor, needs no install', () => {
    const pkg = JSON.parse(readFileSync(path.join(out, 'package.json'), 'utf8'));
    const cli = JSON.parse(readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf8'));
    expect(pkg.name).toBe(PUBLISH_NAME);
    expect(pkg.name).toBe('factstack');
    expect(pkg.bin).toEqual({ factstack: 'dist/cli.js' });
    expect(pkg.engines).toEqual({ node: NODE_ENGINES });
    expect(pkg.license).toBe(cli.license); // the owner settles it before publishing
    expect(pkg.version).toBe(cli.version);
    expect(pkg.dependencies).toEqual({});
    // deploy-infra#8: npm refuses to publish it until a --release build.
    expect(pkg.private).toBe(true);
    expect(pkg.publishConfig).toBeUndefined();
    expect(built.manifest).toEqual(pkg);
    expect(pkg.files).toEqual(['dist', 'README.md', 'THIRD_PARTY_LICENSES.md']);
    for (const f of [
      'README.md',
      'THIRD_PARTY_LICENSES.md',
      'dist/cli.js',
      'dist/ui/index.html',
      'dist/vendor/babel-parser.mjs',
    ]) {
      expect(existsSync(path.join(out, f)), f).toBe(true);
    }
    expect(
      readFileSync(path.join(out, 'dist', 'cli.js'), 'utf8').startsWith('#!/usr/bin/env node\n'),
    ).toBe(true);
    expect(built.bundled.length).toBeGreaterThan(0);
    const licenses = readFileSync(path.join(out, 'THIRD_PARTY_LICENSES.md'), 'utf8');
    for (const name of ['commander', 'zod', '@babel/parser']) {
      expect(licenses).toContain(`## ${name}@`);
    }
    // R10: every bundled package carries its notice (ignore@6 ships LICENSE-MIT).
    expect(licenses).not.toMatch(/No license file shipped/);
    const sections = licenses.split(/^## /m).slice(1);
    expect(sections).toHaveLength(built.bundled.length);
    for (const s of sections) expect(s, s.split('\n', 1)[0]).toContain('```text\n');
    const ignore = sections.find((s) => s.startsWith('ignore@'));
    if (ignore) expect(ignore).toContain('Permission is hereby granted');
  });

  it('runs with plain Node from outside the repo: --version, --help, doctor', () => {
    const version = run(['--version']);
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout.trim()).toBe(
      JSON.parse(readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf8')).version,
    );
    const help = run(['--help']);
    expect(help.stdout).toContain('Usage: factstack');
    expect(run(['doctor']).status).toBe(0);
  });

  it('analyzes and exports a real project', () => {
    const proj = path.join(work, 'proj');
    mkdirSync(path.join(proj, 'src'), { recursive: true });
    writeFileSync(path.join(proj, 'package.json'), '{"name":"p","version":"1.0.0"}');
    writeFileSync(
      path.join(proj, 'src', 'a.ts'),
      "import { b } from './b';\nexport const a = b;\n",
    );
    writeFileSync(path.join(proj, 'src', 'b.ts'), 'export const b = 1;\n');
    const r = run(['analyze', proj, '--json', '--no-progress']);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).ok).toBe(true);
    expect(existsSync(path.join(proj, '.facts', 'agent.pack'))).toBe(true);
    const q = run(['query', 'callers', 'src\\b.ts', '-r', proj, '--json']);
    expect(JSON.parse(q.stdout).results).toEqual(['src/a.ts']);
    const e = run(['export', proj, '-o', path.join(proj, 'out')]);
    expect(e.status, e.stderr).toBe(0);
    const html = readFileSync(path.join(proj, 'out', 'facts-report.html'), 'utf8');
    expect(html).toContain('http-equiv="Content-Security-Policy"');
  });
});
