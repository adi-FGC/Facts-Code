/**
 * Root package.json scripts actually run.
 *
 * Regressions:
 *  - `pnpm bench`, `bench:check`, `bench:update` called a bare `tsx`, which is
 *    not a root dependency ("'tsx' is not recognized"); ci.yml tells
 *    maintainers to repin the determinism gate with `pnpm bench:update`;
 *  - `pnpm test:cov` ran `turbo run test:cov`, a task turbo.json never
 *    registered ("Could not find task `test:cov`"), though 13 packages
 *    define the script.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const turbo = JSON.parse(readFileSync(join(ROOT, 'turbo.json'), 'utf8'));

describe('root scripts', () => {
  it.each(['bench', 'bench:check', 'bench:update'])('%s runs a tsx that is installed', (name) => {
    const [bin, entry, cli] = pkg.scripts[name].split(/\s+/);
    // Not a bare `tsx` (no root .bin); node + a workspace tsx entry works on every OS shell.
    expect(bin).toBe('node');
    expect(existsSync(join(ROOT, entry)), entry).toBe(true);
    expect(cli).toBe('apps/cli/src/cli.ts');
  });

  it('every turbo task a root script runs is registered', () => {
    const tasks = Object.values(pkg.scripts).flatMap((s) =>
      [...s.matchAll(/turbo run ([\w:-]+)/g)].map((m) => m[1]),
    );
    for (const t of tasks) expect(turbo.tasks, t).toHaveProperty([t]);
  });

  it('turbo resolves test:cov across the workspace', () => {
    const out = execFileSync(
      process.execPath,
      [join(ROOT, 'node_modules/turbo/bin/turbo'), 'run', 'test:cov', '--dry=json'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const plan = JSON.parse(out);
    expect(
      plan.tasks.filter((t) => t.task === 'test:cov' && t.command !== '<NONEXISTENT>').length,
    ).toBeGreaterThan(5);
  }, 60_000);
});
