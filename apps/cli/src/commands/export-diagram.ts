/** `factstack export-diagram [target]`: a Mermaid flowchart of the project graph. */
import path from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import kleur from 'kleur';
import { buildDiagram, type DiagramView } from '@factstack/core';
import type { AgentArtifact } from '@factstack/spec';
import { loadAndValidate } from '../artifacts.js';
import { formatBytes, parseIntInRange, relativize } from '../format.js';
import { processIO, type CliIO } from '../io.js';
import { fileInGraph, normalizeTarget } from '../targets.js';

export interface ExportDiagramOptions {
  view: string;
  focus?: string;
  depth: string;
  maxNodes: string;
  out?: string;
  wrap: boolean;
  json?: boolean;
}

export async function exportDiagramCommand(
  target: string | undefined,
  opts: ExportDiagramOptions,
  io: CliIO = processIO,
): Promise<void> {
  const root = path.resolve(target ?? '.');
  const agentPath = path.join(root, '.facts', 'agent.json');

  if (!existsSync(agentPath)) {
    io.stderr.write(kleur.red('factstack export-diagram: ') + 'no .facts/agent.json found.\n');
    io.stderr.write(kleur.dim('  run `factstack analyze .` first.\n'));
    io.exit(1);
  }

  let agent: AgentArtifact;
  try {
    agent = loadAndValidate<AgentArtifact>(agentPath, 'agent');
  } catch (err) {
    io.stderr.write(
      kleur.red('factstack export-diagram: ') +
        (err instanceof Error ? err.message : String(err)) +
        '\n',
    );
    io.exit(1);
  }

  /* Validate --view against the union before passing to buildDiagram.
   commander gives us a string; the renderer wants a literal type. */
  if (opts.view !== 'package' && opts.view !== 'hub' && opts.view !== 'focal') {
    io.stderr.write(
      kleur.red('factstack export-diagram: ') +
        `unknown --view "${opts.view}". Expected: package, hub, focal\n`,
    );
    io.exit(1);
  }

  /* Focal requires --focus. Surface this as a clear error from the
   CLI rather than letting the renderer throw — the renderer's
   throw is the second line of defense; this is the user-facing one. */
  if (opts.view === 'focal' && !opts.focus) {
    io.stderr.write(
      kleur.red('factstack export-diagram: ') + '--view=focal requires --focus <path>.\n',
    );
    io.stderr.write(
      kleur.dim(
        '  example: factstack export-diagram --view focal --focus packages/core/src/diff.ts\n',
      ),
    );
    io.exit(1);
  }

  const view = opts.view as DiagramView;
  const depth = parseIntInRange(opts.depth, 2, 1, 5);
  const maxNodes = parseIntInRange(opts.maxNodes, 30, 2, 80);
  // CLI-06: `src\a.ts` / `./src/a.ts` / absolute → the artifact's `src/a.ts`.
  if (opts.focus) opts.focus = normalizeTarget(root, opts.focus);
  if (view === 'focal' && opts.focus && !fileInGraph(agent, opts.focus)) {
    io.stderr.write(
      kleur.yellow('factstack export-diagram: ') +
        `--focus "${opts.focus}" is not a file in the graph (project-relative path, e.g. src/a.ts)\n`,
    );
  }

  const mermaidSource = buildDiagram(agent, {
    view,
    ...(opts.focus ? { focus: opts.focus } : {}),
    depth,
    maxNodes,
  });

  /* JSON mode: emit an envelope with metadata + the source so
   downstream tools (e.g. a future MCP tool) can compose against
   a known shape. */
  if (opts.json) {
    io.stdout.write(
      JSON.stringify(
        {
          view,
          ...(opts.focus ? { focus: opts.focus } : {}),
          depth,
          maxNodes,
          mermaid: mermaidSource,
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  /* --out file write OR stdout pipe. For .md files we wrap in a
   ```mermaid block by default so the file is paste-ready into any
   markdown surface; --no-wrap opts out for users targeting a
   Mermaid Live Editor or a custom embed. */
  const outputBody =
    opts.out && opts.out.endsWith('.md') && opts.wrap !== false
      ? '```mermaid\n' + mermaidSource + '```\n'
      : mermaidSource;

  if (opts.out) {
    const outPath = path.resolve(opts.out);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, outputBody, 'utf8');
    io.stderr.write(
      kleur.bold().green('FACTS') +
        kleur.dim(' · export-diagram ') +
        kleur.cyan(view) +
        kleur.dim(' → ') +
        kleur.cyan(relativize(outPath, process.cwd())) +
        kleur.dim(` (${formatBytes(outputBody.length)})`) +
        '\n',
    );
    return;
  }

  /* Default: pipe to stdout so consumers can do
   `factstack export-diagram > out.mmd` or pipe into pbcopy/xclip. */
  io.stdout.write(outputBody);
}
