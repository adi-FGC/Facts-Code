/** `factstack doctor`: can FACTS analyze on this machine (Node floor, node:sqlite)? */
import kleur from 'kleur';
import { processIO, type CliIO } from '../io.js';
import { NODE_FLOOR, nodeAtLeast } from '../runtime.js';

export async function doctorCommand(io: CliIO = processIO): Promise<void> {
  const checks: Array<{ label: string; ok: boolean; detail: string }> = [];
  /* tech-debt#1 (owner decision 2026-09-24): the CLI floor is Node 24.3
     everywhere — the only version CI tests and the engines field states.
     The old `major >= 20` check reported green on untested 20.x–24.2. */
  checks.push({
    label: `Node ≥ ${NODE_FLOOR.join('.')}`,
    ok: nodeAtLeast(process.versions.node, NODE_FLOOR),
    detail: `found v${process.versions.node}`,
  });
  // node:sqlite backs the F8 parse cache (.facts/cache.db). @types/node
  // doesn't ship typings for it; use a dynamic spec string so TS doesn't try
  // to resolve it at type-check time.
  try {
    const sqliteSpec: string = 'node:sqlite';
    const sqlite = await import(sqliteSpec).catch(() => null);
    checks.push({
      label: 'node:sqlite available',
      ok: sqlite !== null,
      detail: sqlite
        ? 'ok'
        : `missing — upgrade to Node ${NODE_FLOOR.join('.')}+ (analyze still runs, without the F8 parse cache)`,
    });
  } catch {
    checks.push({ label: 'node:sqlite available', ok: false, detail: 'not available' });
  }
  for (const c of checks) {
    const mark = c.ok ? kleur.green('✓') : kleur.red('✗');
    io.stderr.write(`  ${mark} ${c.label.padEnd(28, ' ')} ${kleur.dim(c.detail)}\n`);
  }
  io.exit(checks.every((c) => c.ok) ? 0 : 1);
}
