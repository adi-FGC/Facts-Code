/** `factstack query <selector> [target...]`: structured graph verbs or a free-text question. */
import path from 'node:path';
import kleur from 'kleur';
import { executeQuery, planFromQuestion } from '@factstack/core';
import type { AgentArtifact } from '@factstack/spec';
import { QUERY_VERBS } from '@factstack/spec';
import { loadAndValidate } from '../artifacts.js';
import { parseIntInRange } from '../format.js';
import { processIO, type CliIO } from '../io.js';
import { fileInGraph, isPathLike, normalizeTarget } from '../targets.js';

export interface QueryOptions {
  json?: boolean;
  root: string;
  filter?: string;
  limit: string;
  /** Unset → each verb's own default from core (1, or 3 for `impact`). */
  depth?: string;
  direction?: string;
  minConfidence?: string;
}

/**
 * Render a QueryResult to stderr as an indented list. `cycles` is an array of
 * path arrays (one indented block per cycle); every other verb is a flat
 * string list (paths, symbol ids, or an ordered path-between sequence).
 */
export function printQueryResult(
  result: { verb: string; results: unknown },
  io: CliIO = processIO,
): void {
  const rows = result.results;
  if (result.verb === 'cycles') {
    for (const cyc of (rows as string[][]) ?? []) {
      io.stderr.write(kleur.dim('  ─── cycle ───\n'));
      for (const p of cyc) io.stderr.write('  ' + p + '\n');
    }
    return;
  }
  for (const r of (rows as string[]) ?? []) io.stderr.write('  ' + r + '\n');
}

export async function queryCommand(
  selector: string,
  targetArr: string[] | undefined,
  opts: QueryOptions,
  io: CliIO = processIO,
): Promise<void> {
  const targets = targetArr ?? [];
  const isVerb = (QUERY_VERBS as readonly string[]).includes(selector);

  const CONF_LEVELS = ['extracted', 'inferred', 'ambiguous'] as const;
  if (opts.minConfidence && !(CONF_LEVELS as readonly string[]).includes(opts.minConfidence)) {
    io.stderr.write(
      kleur.red('factstack query: ') +
        `unknown --min-confidence "${opts.minConfidence}". Expected: ${CONF_LEVELS.join(', ')}\n`,
    );
    io.exit(1);
  }
  if (opts.direction && !['out', 'in', 'both'].includes(opts.direction)) {
    io.stderr.write(
      kleur.red('factstack query: ') +
        `unknown --direction "${opts.direction}". Expected: out | in | both\n`,
    );
    io.exit(1);
  }
  // Numeric option guards — `Number('nope')` is NaN, which downstream
  // slice(0, NaN) paths silently treat as 0 (empty result, no signal).
  const limit = parseIntInRange(opts.limit, 200, 1, 100_000);
  /* No depth unless the user gave one, so core applies each verb's
     default (3 for `impact`) — the same answer MCP query_graph gives. */
  const depth = opts.depth !== undefined ? parseIntInRange(opts.depth, 1, 0, 50) : undefined;
  const root = path.resolve(opts.root);
  const agentPath = path.join(root, '.facts', 'agent.json');
  let agent: AgentArtifact;
  try {
    agent = loadAndValidate<AgentArtifact>(agentPath, 'agent');
  } catch (err) {
    io.stderr.write(
      kleur.red('factstack query: ') + (err instanceof Error ? err.message : String(err)) + '\n',
    );
    io.stderr.write(kleur.dim('  run `factstack analyze .` first.\n'));
    io.exit(1);
  }

  // ── Free-text path: selector isn't a known verb → treat selector + targets
  //    as a natural-language question and map it deterministically (INV3). ──
  if (!isVerb) {
    const question = [selector, ...targets].join(' ');
    const plan = planFromQuestion(agent, question);
    if (!plan.ok) {
      if (opts.json) {
        io.stdout.write(
          JSON.stringify({ ok: false, reason: plan.reason, candidates: plan.candidates }, null, 2) +
            '\n',
        );
      } else {
        io.stderr.write(kleur.yellow('factstack query: ') + plan.reason + '\n');
        for (const c of plan.candidates) io.stderr.write(kleur.dim('  • ') + c + '\n');
        if (!plan.candidates.length)
          io.stderr.write(kleur.dim('  (no candidates — try `factstack query callers <path>`)\n'));
      }
      io.exit(plan.candidates.length ? 0 : 1);
    }
    // Lift the plan to a verb call for uniform list rendering: GraphQuery
    // plans become `neighbors` with the resolved direction.
    const p = plan.plan;
    const result = p.graphQuery
      ? executeQuery(agent, {
          verb: 'neighbors',
          ...(p.graphQuery.start.id ? { path: p.graphQuery.start.id } : {}),
          direction: p.graphQuery.traverse?.direction ?? 'both',
          depth: p.graphQuery.traverse?.maxDepth ?? 1,
          limit,
        })
      : executeQuery(agent, {
          verb: p.verb!,
          ...(p.path ? { path: p.path } : {}),
          ...(p.to ? { to: p.to } : {}),
          limit,
        });
    if (opts.json) {
      io.stdout.write(
        JSON.stringify(
          { interpretation: p.interpretation, entities: p.entities, ...result },
          null,
          2,
        ) + '\n',
      );
      return;
    }
    io.stderr.write(kleur.dim(p.interpretation) + '\n');
    printQueryResult(result, io);
    return;
  }

  // ── Structured verb path ────────────────────────────────────────────────
  const verb = selector as (typeof QUERY_VERBS)[number];
  // CLI-06: `src\a.ts`, `.\src\a.ts`, `./src/a.ts` and an absolute path all
  // mean the artifact's `src/a.ts` — unnormalized they answered "0 results".
  const target = targets[0] !== undefined ? normalizeTarget(root, targets[0]) : undefined;
  const target2 = targets[1] !== undefined ? normalizeTarget(root, targets[1]) : undefined;
  const needsTarget = [
    'callers',
    'imports',
    'neighbors',
    'references',
    'implementers',
    'path-between',
    'impact',
  ];
  if (needsTarget.includes(verb) && !target) {
    io.stderr.write(
      kleur.red('factstack query: ') + `verb "${verb}" requires a target path/symbol.\n`,
    );
    io.stderr.write(kleur.dim(`  example: factstack query ${verb} packages/core/src/index.ts\n`));
    io.exit(1);
  }
  if (verb === 'path-between' && !targets[1]) {
    io.stderr.write(
      kleur.red('factstack query: ') + 'verb "path-between" requires two targets: <from> <to>.\n',
    );
    io.exit(1);
  }
  const result = executeQuery(agent, {
    verb,
    ...(target ? { path: target } : {}),
    ...(target2 ? { to: target2 } : {}),
    ...(opts.direction ? { direction: opts.direction as 'out' | 'in' | 'both' } : {}),
    ...(opts.filter ? { filter: opts.filter } : {}),
    ...(opts.minConfidence
      ? { minConfidence: opts.minConfidence as (typeof CONF_LEVELS)[number] }
      : {}),
    limit,
    ...(depth !== undefined ? { depth } : {}),
  });
  if (opts.json) {
    io.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  const label = result.target ?? target;
  const header = label
    ? `${verb}(${label}) — ${result.count} result${result.count === 1 ? '' : 's'}`
    : `${verb} — ${result.count} result${result.count === 1 ? '' : 's'}`;
  io.stderr.write(kleur.bold(header) + '\n');
  printQueryResult(result, io);
  // "0 results" for a file the graph does not know is not "no callers".
  for (const t of [target, target2]) {
    if (result.count === 0 && t && isPathLike(t) && !fileInGraph(agent, t)) {
      io.stderr.write(
        kleur.dim(
          `  note: "${t}" is not a file in the graph — check the path (project-relative, e.g. src/a.ts)\n`,
        ),
      );
    }
  }
}
