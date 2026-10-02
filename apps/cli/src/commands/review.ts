/** `factstack review [base] [head]`: the Change Verdict (Markdown or JSON), with a --fail-on gate. */
import path from 'node:path';
import kleur from 'kleur';
import { buildChangeVerdict, renderVerdictMarkdown } from '@factstack/core';
import { staleHint } from '@factstack/emit';
import { resolveEndpointPair } from '../endpoints.js';
import { processIO, type CliIO } from '../io.js';

export interface ReviewOptions {
  json?: boolean;
  failOn?: string;
  root: string;
}

export async function reviewCommand(
  baseArg: string | undefined,
  headArg: string | undefined,
  opts: ReviewOptions,
  io: CliIO = processIO,
): Promise<void> {
  const root = path.resolve(opts.root);
  const factsDir = path.join(root, '.facts');

  /* CLI-11: validate the gate first. `none` means "never fail" — it used
     to rank 0, so `--fail-on none` failed on every verdict. */
  const RANK: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
  if (opts.failOn !== undefined && RANK[opts.failOn] === undefined) {
    io.stderr.write(
      kleur.red('factstack review: ') +
        `invalid --fail-on "${opts.failOn}" (use low|medium|high|critical, or none)\n`,
    );
    io.exit(2);
  }

  /* Zero-arg (owner decision 2026-09-24): the review baseline — the
     previous FULL analyze — so an unchanged tree reads NONE. Only before
     a baseline exists does it fall back to the previous snapshot rollup,
     which carries counts only. */
  const { from, to, baseSource, headStale } = resolveEndpointPair(baseArg, headArg, factsDir);
  /* The per-edit `--minimal` hook marked agent.json stale — it is the
     last full analyze, so every edit since is missing from the verdict. A
     gate must not pass on that (exit 2, like an invalid gate); without one,
     the verdict is printed with the warning. */
  if (headStale) {
    const gated = opts.failOn !== undefined && opts.failOn !== 'none';
    io.stderr.write(
      (gated ? kleur.red('factstack review: ') : kleur.yellow('factstack review: ')) +
        staleHint(headStale) +
        '\n',
    );
    if (gated) {
      io.stderr.write(
        kleur.dim(
          '  --fail-on does not gate a stale head: run `factstack analyze`, then re-run review.\n',
        ),
      );
      io.exit(2);
    }
  }
  if (baseSource === 'snapshot') {
    io.stderr.write(
      kleur.dim(
        '  no review baseline yet (.facts/baseline/agent.json) — comparing against a snapshot rollup: counts only, cycles and CVEs not compared. Run `factstack analyze` again to create one.\n',
      ),
    );
  }

  if (!from || !to) {
    io.stderr.write(kleur.red('factstack review: ') + 'need two analyzable endpoints.\n');
    if (!to) io.stderr.write(kleur.dim('  run factstack analyze to produce .facts/agent.json\n'));
    else
      io.stderr.write(
        kleur.dim(
          '  no base: run factstack analyze again so .facts/baseline/agent.json exists, or pass a base path\n',
        ),
      );
    io.exit(1);
  }

  /* Pass the ENDPOINTS, not `.artifact`: a snapshot base's overrides and
     snapshotFile tell core it is a rollup (counts only). Dropping them
     turned every existing secret, cycle and CVE into "new" (correctness#2). */
  const verdict = buildChangeVerdict(from, to);

  if (opts.json)
    io.stdout.write(
      JSON.stringify(headStale ? { ...verdict, headStale } : verdict, null, 2) + '\n',
    );
  else io.stdout.write(renderVerdictMarkdown(verdict) + '\n');

  if (opts.failOn && opts.failOn !== 'none') {
    const threshold = RANK[opts.failOn]!;
    if (RANK[verdict.severity]! >= threshold) {
      io.stderr.write(
        kleur.yellow('\nfactstack review: ') +
          `verdict severity "${verdict.severity}" >= --fail-on "${opts.failOn}"\n`,
      );
      io.exit(1);
    }
  }
}
