/**
 * The deploy scripts' "run main() only when started as a script" guard.
 *
 * Regression: the guard compared `process.argv[1]` (the path as typed) with
 * `import.meta.url` (Node's REAL path). Started through a junction, symlink or
 * subst'd checkout the two differ, so every gate silently skipped its checks
 * and exited 0 — the whole deploy:cf chain "passed" with nothing checked.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = join(ROOT, 'apps/ui-remix/scripts');

const tmp = mkdtempSync(join(tmpdir(), 'fx-entry-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
/* A directory junction on Windows (no admin needed); a symlink elsewhere. */
const linked = join(tmp, 'linked-scripts');
symlinkSync(SCRIPTS, linked, 'junction');

const run = (script, args) => {
  const env = { ...process.env };
  for (const k of ['FACTS_FB_WEB_CONFIG', 'FACTS_ALLOW_HISTORY_RESET', 'FACTS_DEPLOY_FORCE'])
    delete env[k];
  delete env.GITHUB_ACTIONS;
  delete env.GITHUB_OUTPUT;
  const r = spawnSync(process.execPath, [join(linked, script), ...args], {
    encoding: 'utf8',
    env,
    cwd: tmp,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

describe('scripts started through a junction/symlink still run their checks', () => {
  const empty = mkdtempSync(join(tmp, 'empty-'));

  it('deploy-check post fails an empty dist', () => {
    const r = run('deploy-check.mjs', ['post', '--dist', empty]);
    expect(r.out).toMatch(/\[deploy-check\] post: .*mcp-auth-config\.json is missing/);
    expect(r.status).toBe(1);
  });

  it('gen-fb-config --require runs (and refuses when no config is found)', () => {
    const r = run('gen-fb-config.mjs', [
      '--require',
      '--root',
      empty,
      '--out',
      join(tmp, 'c.json'),
    ]);
    expect(r.out).toContain('[gen-fb-config]');
  });

  it('carry-history fails on an unreadable live dataset', () => {
    const r = run('carry-history.mjs', ['--from', join(tmp, 'nope.json'), '--root', empty]);
    expect(r.out).toContain('[carry-history] could not read the live dataset');
    expect(r.status).toBe(1);
  });

  it('perf-report fails on a missing build', () => {
    const r = run('perf-report.mjs', ['--dist', empty]);
    expect(r.out).toContain('[perf-report]');
    expect(r.status).toBe(1);
  });
});
