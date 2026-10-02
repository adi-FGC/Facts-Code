/** `factstack outdated [target]`: declared npm deps vs the registry's latest (network step). */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import kleur from 'kleur';
import { checkOutdated, summarizeOutdated } from '@factstack/scanners';
import type { AgentArtifact } from '@factstack/spec';
import { loadAndValidate } from '../artifacts.js';
import { processIO, type CliIO } from '../io.js';
import { planOutdatedQueries, readLockfiles } from '../vulns.js';

export interface OutdatedOptions {
  failOn?: string;
  json?: boolean;
}

export async function outdatedCommand(
  target: string | undefined,
  opts: OutdatedOptions,
  io: CliIO = processIO,
): Promise<void> {
  const root = path.resolve(target ?? '.');
  const agentPath = path.join(root, '.facts', 'agent.json');

  /* CLI-11: validate the CI gate BEFORE any network or early return. A typo
     (`--fail-on five`) used to print a warning and exit 0 — the gate
     silently off — and the no-deps path never checked it at all. */
  let threshold: number | undefined;
  if (opts.failOn !== undefined) {
    threshold = Number(opts.failOn);
    if (opts.failOn.trim() === '' || !Number.isFinite(threshold) || threshold < 0) {
      io.stderr.write(
        kleur.red('factstack outdated: ') +
          `--fail-on must be a number >= 0 (got "${opts.failOn}")\n`,
      );
      io.exit(2);
    }
  }

  // Network step, like scan-vulns — never auto-analyze; keep "analyze
  // happened" explicit.
  if (!existsSync(agentPath)) {
    io.stderr.write(kleur.red('factstack outdated: ') + 'no .facts/agent.json found.\n');
    io.stderr.write(kleur.dim('  run `factstack analyze .` first; then re-run outdated.\n'));
    io.exit(1);
  }
  let agent: AgentArtifact;
  try {
    agent = loadAndValidate<AgentArtifact>(agentPath, 'agent');
  } catch (err) {
    io.stderr.write(
      kleur.red('factstack outdated: ') + (err instanceof Error ? err.message : String(err)) + '\n',
    );
    io.exit(1);
  }

  // The project's own npm deps (direct + dev) at the version actually
  // INSTALLED (lockfile), under the real name for `npm:` aliases — the same
  // resolution scan-vulns uses. workspace:/file:/git: and `*`/`latest`
  // specs have no registry version and are counted as skipped.
  const { queries, skipped } = planOutdatedQueries(
    agent.dependencyManifests,
    readLockfiles(root, agent.dependencyManifests),
  );

  if (queries.length === 0) {
    io.stderr.write(
      kleur.bold().green('FACTS') +
        kleur.dim(' · outdated: ') +
        'no registry-resolvable npm deps found.\n',
    );
    if (skipped > 0)
      io.stderr.write(kleur.dim(`  ${skipped} non-npm / non-registry deps skipped.\n`));
    if (opts.json)
      io.stdout.write(
        JSON.stringify({ ok: true, total: 0, outdatedCount: 0, outdated: [], skipped }, null, 2) +
          '\n',
      );
    // Same gate as below: 0 outdated only trips `--fail-on 0`.
    if (threshold !== undefined && 0 >= threshold) io.exit(1);
    return;
  }

  io.stderr.write(
    kleur.bold().green('FACTS') +
      kleur.dim(' · outdated: checking ') +
      kleur.cyan(String(queries.length)) +
      kleur.dim(` npm dep${queries.length === 1 ? '' : 's'} against the registry…\n`),
  );

  const t0 = performance.now();
  let results;
  try {
    // No explicit fetch → the checker binds Node 18+'s global fetch.
    results = await checkOutdated(queries, { concurrency: 8 });
  } catch (err) {
    io.stderr.write(
      kleur.red('factstack outdated: ') + (err instanceof Error ? err.message : String(err)) + '\n',
    );
    io.stderr.write(kleur.dim('  network error? registry unreachable? Re-run later.\n'));
    io.exit(1);
  }
  const elapsedMs = performance.now() - t0;
  const { total, outdated, errored } = summarizeOutdated(results);

  if (opts.json) {
    io.stdout.write(
      JSON.stringify(
        {
          ok: true,
          total,
          outdatedCount: outdated.length,
          errored,
          skipped,
          outdated: outdated.map((r) => ({ name: r.name, current: r.current, latest: r.latest })),
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    const lines: string[] = [
      '',
      kleur.bold().green('FACTS') + kleur.dim(' · outdated'),
      kleur.dim('  ─────────────'),
    ];
    if (outdated.length === 0) {
      lines.push(
        '  ' +
          kleur.green('✓') +
          ` all ${total} npm dep${total === 1 ? '' : 's'} on the latest version`,
      );
    } else {
      const sorted = [...outdated].sort((a, b) => a.name.localeCompare(b.name));
      const w = Math.min(44, Math.max(...sorted.map((r) => r.name.length)));
      for (const r of sorted) {
        lines.push(
          '  ' +
            kleur.yellow('↑') +
            ' ' +
            r.name.padEnd(w) +
            '  ' +
            kleur.dim(r.current) +
            kleur.dim(' → ') +
            kleur.cyan(String(r.latest)),
        );
      }
    }
    lines.push('');
    lines.push(
      kleur.dim(
        `  ${outdated.length}/${total} outdated` +
          (errored ? ` · ${errored} unresolved` : '') +
          (skipped ? ` · ${skipped} skipped` : '') +
          ` · ${(elapsedMs / 1000).toFixed(1)}s`,
      ),
    );
    lines.push('');
    io.stderr.write(lines.join('\n') + '\n');
  }

  // CI gate (validated up front): exit non-zero when the outdated count
  // meets the threshold.
  if (threshold !== undefined && outdated.length >= threshold) {
    io.stderr.write(kleur.red(`  fail-on: ${outdated.length} outdated ≥ ${threshold}\n`));
    io.exit(1);
  }
}
