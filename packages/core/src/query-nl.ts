/**
 * F3 — free-text → query plan (deterministic, INV3: no model in the core).
 *
 * We do NOT "understand" the question with an LLM. We tokenize it, match tokens
 * against real entity names/paths in the graph, and pick one of a small set of
 * keyword-cued templates. The calling agent owns real natural-language
 * reasoning; FACTS only offers a deterministic shortcut for the common shapes
 * ("who calls X", "what does X import", "path between X and Y", "unused files",
 * "cycles"). Anything we can't map confidently returns a ranked
 * "did you mean…" candidate list rather than a guess.
 *
 * Pure: same (agent, question) ⇒ same plan. Entity scans are left-to-right and
 * the resolver returns id-sorted candidates, so ties break deterministically.
 */

import type { AgentArtifact, GraphQuery, QueryVerb } from '@factstack/spec';
import { findEntities, suggestEntities } from './query.js';

export interface NlPlan {
  /** Plain restatement of the interpreted intent, for display + confirmation. */
  interpretation: string;
  /** Resolved seed entity ids (for citations / display). */
  entities: string[];
  /** Execution path A — a declarative GraphQuery (run via runGraphQuery). */
  graphQuery?: GraphQuery;
  /** Execution path B — a legacy verb call (run via executeQuery). Used for
   *  orphans / cycles / path-between, which aren't single-seed traversals. */
  verb?: QueryVerb;
  path?: string;
  to?: string;
}

export type NlResult =
  | { ok: true; plan: NlPlan }
  | { ok: false; reason: string; candidates: string[] };

/** Words that never name a graph entity — skipped when scanning for seeds. */
const STOP = new Set([
  'who', 'what', 'whats', 'which', 'where', 'how', 'why', 'when',
  'call', 'calls', 'called', 'calling', 'caller', 'callers',
  'use', 'uses', 'used', 'using', 'user', // 'user' is a stopword as a question word; a real `User` symbol still resolves via the token's original case in findEntities
  'reference', 'references', 'referenced', 'referencing',
  'import', 'imports', 'imported', 'importing', 'importer', 'importers',
  'depend', 'depends', 'depended', 'depending', 'dependency', 'dependencies',
  'the', 'a', 'an', 'of', 'to', 'on', 'in', 'into', 'by', 'for', 'from', 'and', 'or',
  'is', 'are', 'be', 'does', 'do', 'did', 'that', 'this', 'these', 'those',
  'between', 'path', 'paths', 'connection', 'connected', 'reach', 'reaches', 'reachable',
  'unused', 'orphan', 'orphans', 'orphaned', 'unreferenced', 'dead', 'code',
  'cycle', 'cycles', 'circular', 'cyclic', 'loop', 'loops',
  'find', 'show', 'list', 'me', 'get', 'all', 'any', 'some',
  'file', 'files', 'symbol', 'symbols', 'function', 'functions', 'class', 'classes',
  'module', 'modules', 'thing', 'things', 'it', 'its',
]);

function tokenize(q: string): string[] {
  // Keep identifier + path + symbol-id characters; split on everything else.
  return q.split(/[^A-Za-z0-9_/.#@-]+/).filter(Boolean);
}

/** Resolve the first token that names exactly one entity. Reports ambiguity
 *  (a token that matches several ids) so the caller can ask "did you mean…". */
function pickEntity(
  agent: AgentArtifact,
  tokens: string[],
): { id?: string; ambiguous?: string[]; tried: string[] } {
  const tried: string[] = [];
  for (const tok of tokens) {
    if (tok.length < 2 || STOP.has(tok.toLowerCase())) continue;
    tried.push(tok);
    const ids = findEntities(agent, tok);
    if (ids.length === 1) return { id: ids[0]!, tried };
    if (ids.length > 1) return { ambiguous: ids, tried };
  }
  return { tried };
}

function didYouMean(agent: AgentArtifact, tried: string[], reason: string): NlResult {
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const tok of tried) {
    for (const id of suggestEntities(agent, tok)) {
      if (!seen.has(id)) { seen.add(id); candidates.push(id); }
    }
  }
  return { ok: false, reason, candidates: candidates.slice(0, 10) };
}

/**
 * Map a free-text question to a deterministic query plan, or a candidate list.
 */
export function planFromQuestion(agent: AgentArtifact, question: string): NlResult {
  const raw = question.trim();
  if (!raw) return { ok: false, reason: 'Empty question.', candidates: [] };
  const lower = raw.toLowerCase();
  const tokens = tokenize(raw);

  // ── Template: path-between (two endpoints) ──────────────────────────────
  // "path between A and B", "from A to B", "A -> B".
  const between =
    lower.match(/\bbetween\b(.+?)\band\b(.+)/) ||
    lower.match(/\bfrom\b(.+?)\bto\b(.+)/) ||
    raw.match(/(.+?)->(.+)/);
  if (between) {
    const left = pickEntity(agent, tokenize(between[1] ?? ''));
    const right = pickEntity(agent, tokenize(between[2] ?? ''));
    if (left.ambiguous) return didYouMean(agent, left.tried, 'The source entity is ambiguous — pick one:');
    if (right.ambiguous) return didYouMean(agent, right.tried, 'The destination entity is ambiguous — pick one:');
    if (left.id && right.id) {
      return {
        ok: true,
        plan: {
          interpretation: `path-between — shortest dependency path from \`${left.id}\` to \`${right.id}\``,
          entities: [left.id, right.id],
          verb: 'path-between',
          path: left.id,
          to: right.id,
        },
      };
    }
    return didYouMean(agent, [...left.tried, ...right.tried], 'Could not resolve both endpoints. Did you mean:');
  }

  // ── Template: orphans (no entity) ───────────────────────────────────────
  if (/\b(unused|orphan|orphans|orphaned|unreferenced|dead\s+code)\b/.test(lower)) {
    return {
      ok: true,
      plan: { interpretation: 'orphans — source files with no incoming imports', entities: [], verb: 'orphans' },
    };
  }

  // ── Template: cycles (no entity) ────────────────────────────────────────
  if (/\b(cycle|cycles|circular|cyclic)\b/.test(lower)) {
    return {
      ok: true,
      plan: { interpretation: 'cycles — circular dependency groups (SCCs)', entities: [], verb: 'cycles' },
    };
  }

  // ── Direction cue: incoming (who calls / used by / what depends on X) ────
  const incoming =
    /\b(who|what)\s+(calls?|uses?|references?|imports?)\b/.test(lower) ||
    /\b(callers?|used\s+by|imported\s+by|referenced\s+by|referencing)\b/.test(lower) ||
    /\b(who|what)\s+depends?\s+on\b/.test(lower);

  // ── Direction cue: outgoing (what does X import / X depends on …) ────────
  const outgoing =
    /\b(depends?\s+on|imports?|uses?|requires?)\b/.test(lower) ||
    /\bwhat\s+does\b.*\b(use|import|call|need)\b/.test(lower);

  if (incoming || outgoing) {
    const picked = pickEntity(agent, tokens);
    if (picked.ambiguous) {
      return { ok: false, reason: 'That name matches several entities — pick one:', candidates: picked.ambiguous.slice(0, 10) };
    }
    if (!picked.id) return didYouMean(agent, picked.tried, 'No matching entity found. Did you mean:');

    // Incoming wins when both cue groups fire (e.g. "who depends on X" matches
    // both) because "who/what <verb>" is the stronger directional signal.
    const direction: 'in' | 'out' = incoming ? 'in' : 'out';
    const label = direction === 'in'
      ? `callers — nodes that reference \`${picked.id}\``
      : `imports — nodes that \`${picked.id}\` depends on`;
    return {
      ok: true,
      plan: {
        interpretation: label,
        entities: [picked.id],
        graphQuery: {
          start: { id: picked.id },
          traverse: { direction, maxDepth: 1 },
          select: 'subgraph',
          limit: 200,
        },
      },
    };
  }

  // ── No template matched: resolve any entity and offer neighbors, else
  //    return candidates so the agent can disambiguate. ────────────────────
  const picked = pickEntity(agent, tokens);
  if (picked.id) {
    return {
      ok: true,
      plan: {
        interpretation: `neighbors — nodes directly connected to \`${picked.id}\` (no direction cue in the question)`,
        entities: [picked.id],
        graphQuery: {
          start: { id: picked.id },
          traverse: { direction: 'both', maxDepth: 1 },
          select: 'subgraph',
          limit: 200,
        },
      },
    };
  }
  if (picked.ambiguous) {
    return { ok: false, reason: 'That name matches several entities — pick one:', candidates: picked.ambiguous.slice(0, 10) };
  }
  return didYouMean(agent, picked.tried.length ? picked.tried : tokens, 'Could not map that question to the graph. Did you mean:');
}
