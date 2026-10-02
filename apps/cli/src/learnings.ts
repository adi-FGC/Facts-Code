/* ─── F9 — session/cross-session memory helpers (learnings.jsonl) ────────
 * All best-effort: the log is auxiliary state, so a missing or corrupt file
 * degrades to "no memory", never to a failed command. Moved out of cli.ts
 * unchanged (tech-debt#6). */

import path from 'node:path';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import {
  buildContextStore,
  formatLearningEvent,
  parseLearningsJsonl,
  type ContextStore,
  type LearningEvent,
} from '@factstack/core';

/** Read + parse .facts/learnings.jsonl; [] when absent/unreadable. */
export function readLearningEvents(root: string): LearningEvent[] {
  try {
    const p = path.join(root, '.facts', 'learnings.jsonl');
    if (!existsSync(p)) return [];
    return parseLearningsJsonl(readFileSync(p, 'utf8')).events;
  } catch {
    return [];
  }
}

/** Append one validated event to the log (creates .facts/ if needed). */
export function appendLearningLine(root: string, event: LearningEvent): void {
  const factsDir = path.join(root, '.facts');
  if (!existsSync(factsDir)) mkdirSync(factsDir, { recursive: true });
  appendFileSync(path.join(factsDir, 'learnings.jsonl'), formatLearningEvent(event), 'utf8');
}

/** Aggregate the durable context records for MEMORY's Working-context section.
 *  Always returns a store (possibly empty) so call sites can pass it
 *  unconditionally — buildMemory omits the section when the store is empty. */
export function loadContextStore(root: string): ContextStore {
  return buildContextStore(readLearningEvents(root));
}
