/**
 * `factstack bench`: F13 reproducible context-savings benchmark over the
 * committed corpus; `--update` pins bench/expected.json, `--check` gates CI.
 */
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import kleur from 'kleur';
import { analyze, runBench, type BenchTask } from '@factstack/core';
import { nodeFS } from '@factstack/fs-node';
import { formatCount, relativize } from '../format.js';
import { processIO, type CliIO } from '../io.js';

export interface BenchOptions {
  corpus: string;
  tasks: string;
  update?: boolean;
  check?: boolean;
  json?: boolean;
}

export async function benchCommand(opts: BenchOptions, io: CliIO = processIO): Promise<void> {
  if (opts.update && opts.check) {
    // Together these would write expected.json and then "check" against the
    // file just written — a CI gate that can never fail. Refuse loudly.
    io.stderr.write(
      kleur.red('factstack bench: ') +
        '--update and --check are mutually exclusive (updating first would make the check vacuous).\n',
    );
    io.exit(1);
  }
  const corpusDir = path.resolve(opts.corpus);
  const tasksFile = path.resolve(opts.tasks);
  if (!existsSync(corpusDir)) {
    io.stderr.write(kleur.red('factstack bench: ') + `corpus dir not found: ${corpusDir}\n`);
    io.exit(1);
  }
  let tasks: BenchTask[];
  try {
    const raw: unknown = JSON.parse(readFileSync(tasksFile, 'utf8'));
    if (
      !Array.isArray(raw) ||
      raw.some(
        (t) =>
          !t ||
          typeof t.id !== 'string' ||
          typeof t.query !== 'string' ||
          !Array.isArray(t.expectedAnchors),
      )
    ) {
      throw new Error('each task needs { id: string, query: string, expectedAnchors: string[] }');
    }
    // A zero/negative/non-numeric budget would silently starve the FACTS
    // side down to the seed floor and fabricate a huge "savings" figure that
    // --update would then commit — fail loudly instead.
    if (
      raw.some(
        (t) =>
          t.budgetTokens !== undefined &&
          !(
            typeof t.budgetTokens === 'number' &&
            Number.isFinite(t.budgetTokens) &&
            t.budgetTokens > 0
          ),
      )
    ) {
      throw new Error('budgetTokens, when present, must be a positive number');
    }
    tasks = raw as BenchTask[];
  } catch (err) {
    io.stderr.write(
      kleur.red('factstack bench: ') + `bad task file ${tasksFile} — ${(err as Error).message}\n`,
    );
    io.exit(1);
  }

  /* Deterministic analyze: NO gitStats (churn stays null) and NO gzip — every
   number must derive from the committed corpus bytes alone, so the report
   reproduces byte-identically on any machine (the corpus .gitattributes
   pins LF for the same reason). */
  const result = await analyze(nodeFS(corpusDir), { root: '.', symbols: true });
  const report = runBench(result.agent, tasks);
  const body = JSON.stringify(report, null, 2) + '\n';

  const expectedFile = path.join(path.dirname(tasksFile), 'expected.json');
  let verdict: 'updated' | 'match' | 'drift' | 'none' = 'none';
  if (opts.update) {
    writeFileSync(expectedFile, body, 'utf8');
    verdict = 'updated';
  } else if (existsSync(expectedFile)) {
    verdict = readFileSync(expectedFile, 'utf8') === body ? 'match' : 'drift';
  }

  if (opts.json) {
    io.stdout.write(body);
  } else {
    const c = report.corpus;
    io.stderr.write(
      kleur.bold().green('FACTS') +
        kleur.dim(' · bench — corpus ') +
        kleur.cyan(relativize(corpusDir, process.cwd())) +
        kleur.dim(
          ` (${c.files} files · ${formatCount(c.loc)} LOC · ${formatCount(c.totalTokens)} tokens)`,
        ) +
        '\n\n',
    );
    const head = `  ${'task'.padEnd(22)} ${'FACTS'.padStart(10)} ${'naive'.padStart(14)} ${'savings'.padStart(9)}  recall F/N`;
    io.stdout.write(kleur.dim(head) + '\n');
    for (const r of report.tasks) {
      const facts = `${formatCount(r.facts.tokens)}t·1`;
      const naive = `${formatCount(r.naive.tokens)}t·${r.naive.turns}r`;
      // Pad BEFORE colorizing — ANSI escapes would count toward the width.
      const savRaw = `${r.savingsPct}%`.padStart(9);
      const sav = r.savingsPct >= 0 ? kleur.green(savRaw) : kleur.yellow(savRaw);
      const rec = `${r.facts.recall.toFixed(2)}/${r.naive.recall.toFixed(2)}`;
      io.stdout.write(
        `  ${r.id.padEnd(22)} ${facts.padStart(10)} ${naive.padStart(14)} ${sav}  ${rec}\n`,
      );
    }
    const a = report.aggregate;
    io.stdout.write(
      kleur.bold(
        `  ${'TOTAL'.padEnd(22)} ${`${formatCount(a.factsTokens)}t`.padStart(10)} ${`${formatCount(a.naiveTokens)}t`.padStart(14)} ${`${a.savingsPct}%`.padStart(9)}  ${a.meanFactsRecall.toFixed(2)}/${a.meanNaiveRecall.toFixed(2)}\n`,
      ),
    );
    io.stdout.write('\n');
  }

  const expectedRel = relativize(expectedFile, process.cwd());
  if (verdict === 'updated') io.stderr.write(kleur.green(`  ✓ wrote ${expectedRel}\n`));
  if (verdict === 'match') io.stderr.write(kleur.green(`  ✓ matches committed ${expectedRel}\n`));
  if (verdict === 'drift')
    io.stderr.write(
      kleur.yellow(
        `  ✗ drifts from committed ${expectedRel} — run \`factstack bench --update\` after intentional corpus/task changes\n`,
      ),
    );
  if (verdict === 'none')
    io.stderr.write(
      kleur.dim(`  no ${expectedRel} committed yet — run with --update to pin the numbers\n`),
    );
  if (opts.check && verdict !== 'match' && verdict !== 'updated') io.exit(1);
}
