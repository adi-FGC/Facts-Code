/**
 * Turbo's cache sees every file a cached task reads.
 *
 * Regression (tech-debt#5): the CLI's `build` (sync:ui) and `test` (the
 * legacy-ui "committed template == fresh build" gate and the static XSS
 * audit) read legacy/prototype/index.html from outside apps/cli, and
 * @factstack/cli does not depend on @factstack/prototype. After a prototype
 * edit a local `turbo test` could replay a cached pass and ship a stale UI.
 * The prototype's data/ folder is read by neither (the CLI serves its own
 * /data/factstack.json), so only index.html is an input.
 *
 * It is an input of those CLI tasks only (`@factstack/cli#<task>` entries,
 * `$TURBO_ROOT$/…`), not a globalDependency: a global input would flush the
 * cache of every workspace package on a prototype edit.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROTOTYPE_SRC } from '../apps/cli/scripts/lib/build-ui.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROTOTYPE = relative(ROOT, PROTOTYPE_SRC).replace(/\\/g, '/');
const CLI_TASKS = ['build', 'test', 'test:cov'];

/* `turbo run … --dry=json`: the plan, with each task's inputs repo-relative. */
function dryRun(...args) {
  const out = execFileSync(
    process.execPath,
    [join(ROOT, 'node_modules/turbo/bin/turbo'), 'run', ...args, '--dry=json'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' },
    },
  );
  const plan = JSON.parse(out);
  const dirOf = new Map(Object.entries(plan.packages ?? {}));
  for (const t of plan.tasks) {
    t.dir = String(t.directory ?? dirOf.get(t.package) ?? '.').replace(/\\/g, '/');
    t.repoInputs = Object.keys(t.inputs ?? {}).map((p) => join(t.dir, p).replace(/\\/g, '/'));
  }
  return plan;
}

describe('turbo cache inputs', () => {
  it('the CLI build + tests read the prototype this test guards', () => {
    expect(PROTOTYPE).toBe('legacy/prototype/index.html');
  });

  it('every cached CLI task that reads the prototype is re-run when it changes', () => {
    const plan = dryRun(...CLI_TASKS, 'typecheck', '--filter=@factstack/cli');
    const global = Object.keys(plan.globalCacheInputs?.files ?? {});
    const tasks = plan.tasks.filter((t) => t.package === '@factstack/cli');
    const byTask = new Map(tasks.map((t) => [t.task, t]));
    for (const name of CLI_TASKS) {
      const t = byTask.get(name);
      expect(t, name).toBeDefined();
      /* Either a global dependency or a task input. */
      expect([...global, ...t.repoInputs], t.taskId).toContain(PROTOTYPE);
      /* $TURBO_DEFAULT$ kept: the package's own files are still inputs. */
      for (const own of byTask.get('typecheck').repoInputs)
        expect(t.repoInputs, `${t.taskId} lost ${own}`).toContain(own);
    }
  }, 60_000);

  it('a prototype edit re-runs only the CLI tasks, not every package', () => {
    const plan = dryRun(...CLI_TASKS, 'typecheck');
    expect(Object.keys(plan.globalCacheInputs?.files ?? {})).not.toContain(PROTOTYPE);
    /* legacy/prototype is a workspace package too; its own tasks own the file. */
    const readers = plan.tasks.filter(
      (t) => t.repoInputs.includes(PROTOTYPE) && !PROTOTYPE.startsWith(`${t.dir}/`),
    );
    expect(readers.map((t) => t.taskId).sort()).toEqual(
      CLI_TASKS.map((n) => `@factstack/cli#${n}`).sort(),
    );
  }, 60_000);

  it("the CLI's task entries keep the generic task's settings (turbo does not merge them)", () => {
    const { tasks } = JSON.parse(readFileSync(join(ROOT, 'turbo.json'), 'utf8'));
    for (const name of CLI_TASKS) {
      const { inputs, ...rest } = tasks[`@factstack/cli#${name}`];
      expect(rest, name).toEqual(tasks[name]);
      expect(inputs, name).toEqual(['$TURBO_DEFAULT$', `$TURBO_ROOT$/${PROTOTYPE}`]);
    }
  });
});
