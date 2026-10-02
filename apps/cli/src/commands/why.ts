/** `factstack why <target>`: F10 design rationale attached to a symbol, file or name. */
import path from 'node:path';
import kleur from 'kleur';
import type { AgentArtifact } from '@factstack/spec';
import { loadAndValidate } from '../artifacts.js';
import { processIO, type CliIO } from '../io.js';
import { normalizeTarget } from '../targets.js';

export interface WhyOptions {
  json?: boolean;
  root: string;
}

export function whyCommand(target: string, opts: WhyOptions, io: CliIO = processIO): void {
  const root = path.resolve(opts.root);
  const agentPath = path.join(root, '.facts', 'agent.json');
  let agent: AgentArtifact;
  try {
    agent = loadAndValidate<AgentArtifact>(agentPath, 'agent');
  } catch (err) {
    io.stderr.write(
      kleur.red('factstack why: ') + (err instanceof Error ? err.message : String(err)) + '\n',
    );
    io.stderr.write(
      kleur.dim('  run `factstack analyze .` first (add --symbols for symbol-level links).\n'),
    );
    io.exit(1);
  }
  // CLI-06: `src\a.ts` / `./src/a.ts` / an absolute path match like `src/a.ts`.
  const needle = normalizeTarget(root, target).toLowerCase();
  const items = (agent.rationale ?? []).filter((r) => {
    const sym = (r.symbol ?? '').toLowerCase();
    return sym.includes(needle) || r.file.toLowerCase().includes(needle);
  });
  if (opts.json) {
    io.stdout.write(
      JSON.stringify({ target, count: items.length, rationale: items }, null, 2) + '\n',
    );
    return;
  }
  if (!items.length) {
    io.stdout.write(
      kleur.dim(`No rationale found for "${target}". `) +
        'Try a symbol name, file path, or run `factstack analyze . --symbols`.\n',
    );
    return;
  }
  io.stdout.write(kleur.bold(`Rationale for "${target}" (${items.length})\n\n`));
  for (const r of items) {
    const loc = r.symbol ?? `${r.file}:${r.line}`;
    io.stdout.write(`  ${kleur.cyan(r.kind.toUpperCase())} ${kleur.dim(loc)}\n    ${r.text}\n\n`);
  }
}
