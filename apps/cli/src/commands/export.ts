/**
 * `factstack export [target]`: a self-contained HTML report (the local UI
 * with the dataset inlined, share-safe by default) — or, with --graph, the
 * dependency/symbol graph as GraphML / JSON Graph. No server needed.
 */
import path from 'node:path';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import kleur from 'kleur';
import { exportGraph, graphExportFilename, humanToViz, readSnapshots } from '@factstack/emit';
import type { AgentArtifact, HumanArtifact } from '@factstack/spec';
import { shareableDataset } from '@factstack/spec';
import { loadAndValidate } from '../artifacts.js';
import { formatBytes, relativize } from '../format.js';
import { processIO, type CliIO } from '../io.js';
import { analyzeAndWrite } from '../pipeline.js';
import { injectInlineData, prepareStaticReport } from '../ui/embed.js';
import { readUiTemplate, warnIfLargeReport } from '../uiTemplate.js';

export interface ExportOptions {
  out: string;
  name: string;
  graph?: string;
  includePrivate?: boolean;
}

export async function exportCommand(
  target: string | undefined,
  opts: ExportOptions,
  io: CliIO = processIO,
): Promise<void> {
  const root = path.resolve(target ?? '.');
  const factsDir = path.join(root, '.facts');
  const agentPath = path.join(factsDir, 'agent.json');
  const humanPath = path.join(factsDir, 'human.json');

  if (!existsSync(humanPath) || !existsSync(agentPath)) {
    io.stderr.write(kleur.dim('  no existing .facts/ — analyzing first…\n'));
    await analyzeAndWrite(root, {}, io);
  }

  let agent: AgentArtifact;
  let human: HumanArtifact;
  try {
    agent = loadAndValidate<AgentArtifact>(agentPath, 'agent');
    human = loadAndValidate<HumanArtifact>(humanPath, 'human');
  } catch (err) {
    io.stderr.write(
      kleur.red('factstack export: ') + (err instanceof Error ? err.message : String(err)) + '\n',
    );
    io.stderr.write(kleur.dim('  run `factstack analyze .` to regenerate.\n'));
    io.exit(1);
  }

  // F14 — graph export branch: emit GraphML / JSON Graph instead of the HTML
  // report. Pure, deterministic serialization over the file + symbol graph.
  if (opts.graph) {
    const fmt = opts.graph.toLowerCase();
    if (fmt !== 'graphml' && fmt !== 'json-graph') {
      io.stderr.write(
        kleur.red('factstack export: ') +
          `unknown --graph format "${opts.graph}". Expected: graphml | json-graph\n`,
      );
      io.exit(1);
    }
    const format = fmt as 'graphml' | 'json-graph';
    const content = exportGraph(agent, format);
    const outDir = path.resolve(opts.out);
    mkdirSync(outDir, { recursive: true });
    const gPath = path.join(outDir, graphExportFilename(format));
    writeFileSync(gPath, content, 'utf8');
    const nodes = (agent.graph.nodes?.length ?? 0) + (agent.graph.symbolNodes?.length ?? 0);
    const edges = (agent.graph.edges?.length ?? 0) + (agent.graph.symbolEdges?.length ?? 0);
    io.stderr.write(
      kleur.bold().green('FACTS') +
        kleur.dim(' · exported ') +
        kleur.cyan(relativize(gPath, process.cwd())) +
        kleur.dim(` (${format} · ${nodes} nodes, ${edges} edges)`) +
        '\n',
    );
    return;
  }

  let viz = humanToViz(agent, human);
  viz.history = await readSnapshots(root);
  viz.project.root = root;
  /* The report is a sharing artifact ("share a report with no server"),
     so by default it gets the published site's scrub — the same shared
     implementation: no agent session prompts, no contributor emails, and
     the root, its parent and every checkout path rewritten, so the header
     shows '.' exactly as the static site does. */
  const shareSafe = !opts.includePrivate;
  if (shareSafe) viz = shareableDataset(viz, root).data;

  // Self-contained: the template inlines its CSS and loads nothing remote;
  // prepareStaticReport adds a <meta> CSP and stubs the one server-only
  // module import (src/ui/embed.ts).
  const out = injectInlineData(prepareStaticReport(readUiTemplate()), viz);

  const outDir = path.resolve(opts.out);
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, opts.name);
  writeFileSync(outPath, out, 'utf8');

  const size = statSync(outPath).size;
  io.stderr.write(
    kleur.bold().green('FACTS') +
      kleur.dim(' · exported ') +
      kleur.cyan(relativize(outPath, process.cwd())) +
      kleur.dim(` (${formatBytes(size)})`) +
      '\n',
  );
  warnIfLargeReport(size, io);
  if (shareSafe) {
    io.stderr.write(
      kleur.dim(
        '  agent session prompts, contributor emails and local paths removed for sharing (--include-private keeps them).\n',
      ),
    );
  }
  io.stderr.write(
    kleur.dim(
      '  open the file directly in a browser — no server required (self-contained, works offline).\n',
    ),
  );
}
