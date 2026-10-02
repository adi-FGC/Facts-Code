/** `factstack diff [a] [b]`: compare two analyses (default: the review baseline vs agent.json). */
import path from 'node:path';
import kleur from 'kleur';
import { diffArtifacts } from '@factstack/core';
import { staleHint } from '@factstack/emit';
import { resolveEndpointPair } from '../endpoints.js';
import { formatCount } from '../format.js';
import { processIO, type CliIO } from '../io.js';

export interface DiffOptions {
  json?: boolean;
  root: string;
}

export async function diffCommand(
  snapA: string | undefined,
  snapB: string | undefined,
  opts: DiffOptions,
  io: CliIO = processIO,
): Promise<void> {
  const root = path.resolve(opts.root);
  /* Zero-arg: the review baseline (a FULL artifact, so per-file deltas
     work), else the PREVIOUS snapshot rollup — which `files.incomplete`
     below reports, so no separate notice (review prints one). */
  const { from, to, headStale } = resolveEndpointPair(snapA, snapB, path.join(root, '.facts'));
  /* After the per-edit `--minimal` hook, agent.json is the last full
     analyze — say so instead of presenting it as the tree as it is now. */
  if (headStale) io.stderr.write(kleur.yellow('factstack diff: ') + staleHint(headStale) + '\n');

  if (!from || !to) {
    io.stderr.write(kleur.red('factstack diff: ') + 'need two analyzable endpoints.\n');
    if (!from)
      io.stderr.write(
        kleur.dim(
          '  "from" not found — pass a snapshot/agent.json path, or run factstack analyze twice so .facts/baseline/agent.json exists\n',
        ),
      );
    if (!to)
      io.stderr.write(
        kleur.dim('  "to" not found — run factstack analyze to produce .facts/agent.json\n'),
      );
    io.exit(1);
  }

  const diff = diffArtifacts(from, to);

  if (opts.json) {
    io.stdout.write(JSON.stringify(headStale ? { ...diff, headStale } : diff, null, 2) + '\n');
    return;
  }

  // Editorial TTY table: prose lead + three-line stat delta block + file
  // counts. No ASCII-art: the CLI has a consistent `Summary` + `Artifacts`
  // block style already (see `analyze` action); match it.
  const s = diff.stats;
  const line = (label: string, d: { before: number; after: number; delta: number }) => {
    const arrow =
      d.delta === 0 ? kleur.dim('→') : d.delta > 0 ? kleur.yellow('↑') : kleur.green('↓');
    return `  ${label.padEnd(10)} ${arrow} ${formatCount(Math.abs(d.delta)).padStart(6)}${kleur.dim(' (was ' + formatCount(d.before) + ', now ' + formatCount(d.after) + ')')}`;
  };
  const lines = [
    '',
    kleur.bold('  Diff'),
    kleur.dim('  ────'),
    `  from ${kleur.white(diff.from.at)}`,
    `  to   ${kleur.white(diff.to.at)}`,
    '',
    line('files', s.files),
    line('LOC', s.loc),
    line('tokens', s.tokens),
    line('risks', s.risks),
    line('TODOs', s.todos),
    line('secrets', s.secrets),
    '',
    diff.files.incomplete
      ? kleur.dim(
          '  per-file diff unavailable (one endpoint is a snapshot rollup; compare two full agent.json files for added/removed)',
        )
      : kleur.dim(
          '  ' +
            diff.files.added.length +
            ' added, ' +
            diff.files.removed.length +
            ' removed, ' +
            diff.files.changed.length +
            ' changed',
        ),
    '',
  ];
  io.stderr.write(lines.join('\n') + '\n');
}
