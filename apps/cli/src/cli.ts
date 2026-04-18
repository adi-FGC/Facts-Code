#!/usr/bin/env node
/**
 * factstack — CXO-grade static code analyzer.
 *
 * v0.1 commands:
 *   factstack [path]           analyze <path> (default cwd) + emit artifacts
 *   factstack analyze [path]   alias
 *   factstack doctor           sanity-check artifacts + environment
 *   factstack --json           machine-invocable mode (no TTY chrome)
 *
 * v0.2 (on the roadmap): `ui`, `export`, `watch`.
 */

import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { Command } from 'commander';
import kleur from 'kleur';
import { analyze } from '@factstack/core';
import { gzippedBytes, writeArtifacts } from '@factstack/emit';
import { nodeFS } from '@factstack/fs-node';

const program = new Command();

program
  .name('factstack')
  .description('FACTS — AI Coding Tracker Stack. Analyse a project and emit AI-agent + CXO-readable artifacts.')
  .version('0.1.0-alpha.1');

program
  .command('analyze [target]', { isDefault: true })
  .description('Analyze a project directory and write artifacts into <target>/.facts/')
  .option('--json', 'Emit machine-readable JSON to stdout instead of a TTY summary')
  .option('--no-progress', 'Suppress progress output')
  .option('--no-gitignore-entry', 'Do not add .facts/ to the project .gitignore')
  .action(async (target: string | undefined, opts: { json?: boolean; progress?: boolean; gitignoreEntry?: boolean }) => {
    const root = path.resolve(target ?? '.');
    const machine = opts.json ?? false;
    const showProgress = !machine && (opts.progress ?? true);
    const t0 = performance.now();

    if (!machine) {
      process.stderr.write(kleur.bold().green('FACTS') + kleur.dim(' · analyzing ') + kleur.cyan(root) + '\n');
    }

    const fs = nodeFS(root);
    const projectName = path.basename(root);
    let lastPrinted = 0;

    const result = await analyze(fs, {
      root: '.',
      projectName,
      gzip: gzippedBytes,
      onProgress: showProgress
        ? (pct, file) => {
            const now = performance.now();
            // Throttle to 10 Hz for TTY friendliness.
            if (now - lastPrinted < 100 && pct < 1) return;
            lastPrinted = now;
            const width = 24;
            const filled = Math.round(pct * width);
            const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
            const label = file ? file.slice(-48).padEnd(48, ' ') : 'done'.padEnd(48, ' ');
            process.stderr.write(`\r  ${kleur.green(bar)} ${Math.round(pct * 100)}%  ${kleur.dim(label)}`);
            if (pct >= 1) process.stderr.write('\n');
          }
        : undefined,
    });

    const written = await writeArtifacts({
      root,
      agent: result.agent,
      human: result.human,
      addGitignoreEntry: opts.gitignoreEntry ?? true,
    });

    const elapsed = performance.now() - t0;

    if (machine) {
      process.stdout.write(JSON.stringify({
        ok: true,
        elapsedMs: Math.round(elapsed),
        ...written,
        stats: result.agent.stats,
        risks: result.agent.risks.length,
      }, null, 2) + '\n');
      return;
    }

    // Pretty summary
    const s = result.agent.stats;
    const lines = [
      '',
      kleur.bold('  Summary'),
      kleur.dim('  ───────'),
      `  files        ${kleur.white(String(s.fileCount))}`,
      `  LOC          ${kleur.white(formatCount(s.loc))}`,
      `  tokens       ${kleur.white(formatCount(s.totalTokenCost))}${kleur.dim(' (cl100k approx)')}`,
      `  risks        ${result.agent.risks.length === 0 ? kleur.green('0') : kleur.yellow(String(result.agent.risks.length))}`,
      `  frameworks   ${kleur.white(result.agent.project.frameworks.join(', ') || '—')}`,
      '',
      kleur.bold('  Artifacts'),
      kleur.dim('  ─────────'),
      `  ${kleur.green('✓')} ${relativize(written.agentPath, root)}`,
      `  ${kleur.green('✓')} ${relativize(written.humanPath, root)}`,
      written.jsonlPath ? `  ${kleur.green('✓')} ${relativize(written.jsonlPath, root)}` : '',
      '',
      kleur.dim(`  Done in ${elapsed.toFixed(0)} ms. Total ${formatBytes(written.bytesWritten)} written.`),
      '',
    ];
    process.stderr.write(lines.filter(Boolean).join('\n') + '\n');
  });

program
  .command('doctor')
  .description('Verify FACTS can analyse this machine (Node version, permissions, etc.)')
  .action(async () => {
    const checks: Array<{ label: string; ok: boolean; detail: string }> = [];
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    checks.push({
      label: 'Node ≥ 20',
      ok: nodeMajor >= 20,
      detail: `found v${process.versions.node}`,
    });
    // node:sqlite (v0.2 target, but pre-check)
    try {
      const sqlite = await import('node:sqlite').catch(() => null);
      checks.push({
        label: 'node:sqlite available',
        ok: sqlite !== null,
        detail: sqlite ? 'ok' : 'upgrade to Node 22+ for v0.2 SQLite index',
      });
    } catch {
      checks.push({ label: 'node:sqlite available', ok: false, detail: 'not available' });
    }
    for (const c of checks) {
      const mark = c.ok ? kleur.green('✓') : kleur.red('✗');
      process.stderr.write(`  ${mark} ${c.label.padEnd(28, ' ')} ${kleur.dim(c.detail)}\n`);
    }
    process.exit(checks.every((c) => c.ok) ? 0 : 1);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(kleur.red('factstack: ') + message + '\n');
  if (process.env.FACTSTACK_DEBUG && err instanceof Error && err.stack) {
    process.stderr.write(err.stack + '\n');
  }
  process.exit(1);
});

/* -------------------------------- utils ------------------------------- */

function formatCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return (n / 1_048_576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return `${n} B`;
}

function relativize(p: string, root: string): string {
  return path.relative(root, p).replace(/\\/g, '/');
}
