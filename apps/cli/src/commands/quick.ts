/**
 * `factstack quick [target]`: scan if needed, write a self-contained viewer
 * to a temp file and open it — no server, nothing left running.
 */
import path from 'node:path';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import kleur from 'kleur';
import open from 'open';
import { humanToViz, readSnapshots } from '@factstack/emit';
import type { AgentArtifact, HumanArtifact } from '@factstack/spec';
import { loadAndValidate } from '../artifacts.js';
import { formatBytes } from '../format.js';
import { processIO, type CliIO } from '../io.js';
import { analyzeAndWrite } from '../pipeline.js';
import { injectInlineData, prepareStaticReport } from '../ui/embed.js';
import { readUiTemplate, warnIfLargeReport } from '../uiTemplate.js';

export interface QuickOptions {
  reanalyze?: boolean;
  open: boolean;
}

/**
 * Write the viewer where only this user can read it. It is the
 * user's own look, so it is not scrubbed: it carries the absolute project
 * root, contributor emails and, when opted in, agent prompts. A fresh
 * mkdtemp dir (0700) holds a new 0600 file (`wx`: never an existing one),
 * so no other local user can read it or pre-create the predictable
 * `<tmp>/factstack-quick-<name>.html` it used to be. Returns the file path.
 */
export function writeQuickReport(safeName: string, html: string, dir: string = tmpdir()): string {
  const outDir = mkdtempSync(path.join(dir, 'factstack-quick-'));
  const outPath = path.join(outDir, `factstack-quick-${safeName}.html`);
  writeFileSync(outPath, html, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return outPath;
}

export async function quickCommand(
  target: string | undefined,
  opts: QuickOptions,
  io: CliIO = processIO,
): Promise<void> {
  const root = path.resolve(target ?? '.');
  const factsDir = path.join(root, '.facts');
  const agentPath = path.join(factsDir, 'agent.json');
  const humanPath = path.join(factsDir, 'human.json');

  const t0 = performance.now();
  // Analyze if there's nothing to show yet (or --reanalyze). On an already
  // analyzed repo this is instant — the "5-second look" is for first contact.
  if (opts.reanalyze || !existsSync(humanPath) || !existsSync(agentPath)) {
    io.stderr.write(kleur.dim('  scanning ') + kleur.reset(path.basename(root)) + kleur.dim('…\n'));
    await analyzeAndWrite(root, {}, io);
  }

  let agent: AgentArtifact;
  let human: HumanArtifact;
  try {
    agent = loadAndValidate<AgentArtifact>(agentPath, 'agent');
    human = loadAndValidate<HumanArtifact>(humanPath, 'human');
  } catch (err) {
    io.stderr.write(
      kleur.red('factstack quick: ') + (err instanceof Error ? err.message : String(err)) + '\n',
    );
    io.stderr.write(
      kleur.dim('  run `factstack analyze .` to regenerate, or `factstack quick --reanalyze`.\n'),
    );
    io.exit(1);
  }

  const viz = humanToViz(agent, human);
  viz.project.root = root;
  viz.history = await readSnapshots(root);

  // Self-contained HTML (inline CSS, <meta> CSP, no remote loads), written
  // to a temp file and opened. No server → nothing left running.
  const html = injectInlineData(prepareStaticReport(readUiTemplate()), viz);
  const safeName =
    (agent.project.name || 'project').replaceAll(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'project';
  const outPath = writeQuickReport(safeName, html);

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  const size = statSync(outPath).size;
  io.stderr.write(
    kleur.bold().green('FACTS') +
      kleur.dim(' · quick ') +
      kleur.dim(`(${elapsed}s · ${formatBytes(size)})`) +
      '\n',
  );
  io.stderr.write(kleur.dim('  ') + kleur.cyan(outPath) + '\n');
  warnIfLargeReport(size, io);
  if (opts.open !== false) {
    open(outPath).catch(() => {
      /* ignore */
    });
  } else {
    io.stderr.write(kleur.dim('  open it in a browser — no server required.\n'));
  }
}
