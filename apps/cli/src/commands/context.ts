/**
 * F4 / F9 — the working-context commands:
 *   `factstack context <task...>`  ranked, token-budgeted context for a task
 *   `factstack remember <kind> …`  record a decision/fact/task/question
 *   `factstack context-store`      show the aggregated working context
 * All three read and write .facts/learnings.jsonl (../learnings.ts).
 */
import path from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import kleur from 'kleur';
import {
  assembleContext,
  buildMemory,
  contextRecordEvent,
  lastServedEntities,
  recentSessionEntities,
  resolveCloseTarget,
  sessionActionEvent,
  CONTEXT_KINDS,
  type ContextKind,
  type LearningEvent,
} from '@factstack/core';
import type { AgentArtifact, HumanArtifact } from '@factstack/spec';
import { loadAndValidate } from '../artifacts.js';
import { parseIntInRange } from '../format.js';
import { processIO, type CliIO } from '../io.js';
import { appendLearningLine, loadContextStore, readLearningEvents } from '../learnings.js';
import { normalizeTarget } from '../targets.js';

export interface ContextOptions {
  json?: boolean;
  root: string;
  budget: string;
  maxHops: string;
  seeds?: string;
}

export function contextCommand(
  taskArr: string[],
  opts: ContextOptions,
  io: CliIO = processIO,
): void {
  const query = taskArr.join(' ');
  const budgetTokens = parseIntInRange(opts.budget, 8000, 1, 100_000_000);
  const maxHops = parseIntInRange(opts.maxHops, 2, 0, 20);
  const root = path.resolve(opts.root);
  const seeds = opts.seeds
    ? opts.seeds
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => normalizeTarget(root, s)) // CLI-06
    : undefined;
  const agentPath = path.join(root, '.facts', 'agent.json');
  let agent: AgentArtifact;
  try {
    agent = loadAndValidate<AgentArtifact>(agentPath, 'agent');
  } catch (err) {
    io.stderr.write(
      kleur.red('factstack context: ') + (err instanceof Error ? err.message : String(err)) + '\n',
    );
    io.stderr.write(
      kleur.dim('  run `factstack analyze .` first (add --symbols for symbol-level anchors).\n'),
    );
    io.exit(1);
  }
  // F9 — boost what this project's agents recently served/read/edited, and
  // record what WE serve so the next call re-ranks toward it. Both sides are
  // best-effort reads/writes of .facts/learnings.jsonl.
  const sessionEvents = readLearningEvents(root);
  const recent = recentSessionEntities(sessionEvents);
  const result = assembleContext(agent, {
    query,
    ...(seeds && seeds.length ? { seeds } : {}),
    budgetTokens,
    maxHops,
    ...(recent.length ? { recentEntities: recent } : {}),
  });
  try {
    const servedIds = result.items.map((i) => i.id);
    // Consecutive-dedup: re-running the same query adds no signal — don't
    // grow the log one identical `served` line per repeat.
    if (JSON.stringify(servedIds) !== JSON.stringify(lastServedEntities(sessionEvents))) {
      appendLearningLine(
        root,
        sessionActionEvent({
          action: 'served',
          entities: servedIds,
          tokens: result.totalTokens,
        }),
      );
    }
  } catch {
    /* never fail the command on a log write */
  }
  if (opts.json) {
    io.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  // TTY: a header (cold-start is called out), a budget line, then ranked
  // anchors. ● = a seed, ○ = a graph-reached anchor.
  const head = result.coldStart
    ? kleur.yellow(
        `no seed matched "${query}" — showing the project's most important files (cold start)`,
      )
    : kleur.bold(`context for "${query}"`);
  io.stderr.write(head + '\n');
  const budgetNote =
    `${result.items.length} anchor${result.items.length === 1 ? '' : 's'} · ` +
    `${result.totalTokens}/${result.budgetTokens} tokens` +
    (result.truncated ? kleur.yellow(' · truncated (budget)') : '');
  io.stderr.write(kleur.dim(budgetNote) + '\n\n');
  for (const it of result.items) {
    const loc = it.line != null ? `${it.path}:${it.line}` : it.path;
    const seedMark = it.isSeed ? kleur.green('●') : kleur.dim('○');
    const kindTag = it.kind === 'file' ? '' : kleur.dim(` ${it.kind} ${it.name}`);
    io.stdout.write(
      `  ${seedMark} ${kleur.cyan(loc)}${kindTag} ${kleur.dim(`(${it.tokenCost}t · ${it.score})`)}\n`,
    );
  }
  if (!result.items.length) {
    io.stdout.write(
      kleur.dim(
        '  (nothing assembled — try a different task or run `factstack analyze . --symbols`)\n',
      ),
    );
  }
}

export interface RememberOptions {
  key?: string;
  done?: boolean;
  entities?: string;
  agent: string;
  json?: boolean;
  root: string;
}

export function rememberCommand(
  kind: string,
  textArr: string[],
  opts: RememberOptions,
  io: CliIO = processIO,
): void {
  if (!(CONTEXT_KINDS as readonly string[]).includes(kind)) {
    io.stderr.write(
      kleur.red('factstack remember: ') +
        `unknown kind "${kind}". Expected: ${CONTEXT_KINDS.join(' | ')}\n`,
    );
    io.exit(1);
  }
  const root = path.resolve(opts.root);
  const text = textArr.join(' ');
  const entities = opts.entities
    ? opts.entities
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => normalizeTarget(root, s)) // CLI-06
    : undefined;
  /* F9 — a close must land on the SAME dedup key as the open record, or it
   creates a NEW closed record while the keyed one silently stays open.
   resolveCloseTarget matches by (kind, key-or-text) first, then by exact
   text (adopting that record's key); matched:false → warn, don't claim
   "closed". */
  let keyForEvent = opts.key;
  let closeMatched = true;
  if (opts.done && (kind === 'task' || kind === 'question')) {
    const target = resolveCloseTarget(loadContextStore(root), kind as ContextKind, opts.key, text);
    keyForEvent = target.key;
    closeMatched = target.matched;
  }
  let event: LearningEvent;
  try {
    event = contextRecordEvent({
      kind: kind as ContextKind,
      text,
      agent: opts.agent,
      ...(opts.done ? { status: 'accepted' as const } : {}),
      ...(keyForEvent !== undefined ? { key: keyForEvent } : {}),
      ...(entities !== undefined ? { entities } : {}),
    });
    appendLearningLine(root, event);
  } catch (err) {
    io.stderr.write(
      kleur.red('factstack remember: ') + (err instanceof Error ? err.message : String(err)) + '\n',
    );
    io.exit(1);
  }
  /* DoD: a recorded decision shows up in MEMORY.md without waiting for the
   next analyze. Regenerate it in place when both artifacts exist; if they
   don't, the next analyze folds the record in. Best-effort. */
  let memoryRefreshed = false;
  try {
    const agentPath = path.join(root, '.facts', 'agent.json');
    const humanPath = path.join(root, '.facts', 'human.json');
    if (existsSync(agentPath) && existsSync(humanPath)) {
      const agent = loadAndValidate<AgentArtifact>(agentPath, 'agent');
      const human = loadAndValidate<HumanArtifact>(humanPath, 'human');
      writeFileSync(
        path.join(root, '.facts', 'MEMORY.md'),
        buildMemory(agent, human, { contextStore: loadContextStore(root) }),
        'utf8',
      );
      memoryRefreshed = true;
    }
  } catch {
    /* MEMORY refresh is a bonus, not the record of truth (the log is) */
  }
  if (opts.json) {
    io.stdout.write(
      JSON.stringify({
        ok: true,
        kind,
        key: keyForEvent ?? text,
        status: event.outcome,
        timestamp: event.timestamp,
        memoryRefreshed,
        ...(opts.done ? { closedExisting: closeMatched } : {}),
      }) + '\n',
    );
    return;
  }
  const verb = opts.done ? (closeMatched ? 'closed' : 'recorded (already-closed)') : 'recorded';
  io.stderr.write(kleur.bold().green('FACTS') + kleur.dim(` · ${verb} ${kind}: `) + text + '\n');
  if (opts.done && !closeMatched && (kind === 'task' || kind === 'question')) {
    io.stderr.write(
      kleur.yellow(`  note: no OPEN ${kind} matched this text/key — nothing was closed. `) +
        kleur.dim(
          'Run `factstack context-store` to see the open one, then pass its exact text or --key.\n',
        ),
    );
  }
  io.stderr.write(
    kleur.dim(
      memoryRefreshed
        ? '  MEMORY.md updated — agents see it in the Working context section.\n'
        : '  logged; it will surface in MEMORY.md on the next `factstack analyze`.\n',
    ),
  );
}

export interface ContextStoreOptions {
  json?: boolean;
  root: string;
}

export function contextStoreCommand(opts: ContextStoreOptions, io: CliIO = processIO): void {
  const root = path.resolve(opts.root);
  const store = loadContextStore(root);
  if (opts.json) {
    io.stdout.write(JSON.stringify(store, null, 2) + '\n');
    return;
  }
  const total = store.decisions.length + store.tasks.length + store.openQuestions.length;
  if (!total) {
    io.stdout.write(
      kleur.dim(
        'No working context recorded yet. Try `factstack remember decision "…"` or `factstack remember task "…"`.\n',
      ),
    );
    return;
  }
  const section = (
    title: string,
    rows: typeof store.tasks,
    bullet: (t: string) => string,
  ): void => {
    if (!rows.length) return;
    io.stdout.write(kleur.bold(`${title} (${rows.length})\n`));
    for (const r of rows) {
      io.stdout.write(
        `  ${bullet(r.text)} ${kleur.dim(`— ${r.agent} · ${r.timestamp.slice(0, 10)}`)}\n`,
      );
    }
    io.stdout.write('\n');
  };
  section('Open tasks', store.tasks, (t) => `${kleur.yellow('[ ]')} ${t}`);
  section('Decisions & facts', store.decisions, (t) => `${kleur.green('•')} ${t}`);
  section('Open questions', store.openQuestions, (t) => `${kleur.cyan('?')} ${t}`);
}
