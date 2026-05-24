/**
 * Sequence-flow analyzer — derive a swimlanes.io-style temporal
 * sequence from a static dependency graph.
 *
 * Mental model:
 *   The graph is "file A imports file B". The sequence diagram is
 *   "starting at entry point E, walk imports in depth-first order;
 *    each importer→importee becomes a message in chronological order."
 *
 * For runtime call sequences we'd need an actual call graph (symbol
 * extractor v0.4.4 lands that). Until then, the import-order walk
 * is the best static approximation: it captures "what does the
 * codebase pull in when this entry boots".
 *
 * Layout terminology (swimlanes.io):
 *   - **Lifeline / actor**  → a unique file referenced in the sequence
 *   - **Message**           → one import edge, with an ordinal step #
 *   - **Activation**        → contiguous spans where an actor is the
 *                             current executor (between dispatch + return)
 *
 * Tunables:
 *   - `maxDepth` caps recursion depth (default 5). Beyond this the
 *     diagram becomes a wall of lines without informative shape.
 *   - `maxBranchesPerNode` caps the fan-out per importer (default 8).
 *     A barrel re-export with 40 imports would otherwise produce a
 *     starburst that flattens the diagram.
 *   - `maxMessages` caps total messages (default 60). Belt-and-suspenders
 *     for very dense entry points.
 */

export interface SequenceInputs {
  /** Project-relative paths of every in-project file. */
  files: ReadonlySet<string>;
  /** Resolved file→file imports. */
  edges: ReadonlyArray<{ from: string; to: string }>;
  /** Where the sequence starts. Must be in `files`. */
  entryPoint: string;
  /** Hard limits — defaults applied when omitted. */
  maxDepth?: number;
  maxBranchesPerNode?: number;
  maxMessages?: number;
}

export interface SequenceMessage {
  /** 1-based ordinal — the row this message occupies in the diagram. */
  step: number;
  /** Source lifeline (the importer). */
  from: string;
  /** Destination lifeline (the importee). */
  to: string;
  /** Depth from the entry point (entry = 0). Used for visual nesting. */
  depth: number;
  /** True when this message points at a node we've already visited
   *  in the current branch — a cycle. We emit one synthetic message
   *  per cycle hit and don't recurse further. */
  isCycle: boolean;
  /** True when this is a "return" — synthesized at the end of a
   *  branch when we pop back up to the caller. swimlanes.io draws
   *  returns with a dashed arrow. */
  isReturn: boolean;
}

export interface SequenceResult {
  entryPoint: string;
  /** Lifeline order matches first-appearance in the sequence. swimlanes.io
   *  picks lifeline columns by author-order in the DSL; we mirror that
   *  so the layout is deterministic and matches the DSL output below. */
  lifelines: string[];
  messages: SequenceMessage[];
  /** True when the walk hit one of the caps (depth/branch/total). The
   *  UI surfaces this as a "truncated" badge so users know what they're
   *  looking at isn't the whole picture. */
  truncated: boolean;
  /** swimlanes.io-compatible DSL representation. Round-trippable into
   *  the swimlanes.io editor for further customization. */
  dsl: string;
}

const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_BRANCHES = 8;
const DEFAULT_MAX_MESSAGES = 60;

/**
 * Build the sequence from inputs. Pure — no I/O, no random.
 *
 * Algorithm:
 *   1. Build a forward adjacency map restricted to in-project files
 *      and rank each node's out-edges by total degree (most-imported
 *      target first → most "important" branch fans out first).
 *   2. DFS preorder from entryPoint. For each visited node:
 *      a. Pop the top `maxBranchesPerNode` outgoing edges.
 *      b. For each, emit a message (importer → importee), recurse.
 *      c. After recursion returns, emit a synthetic return message.
 *   3. Cycle handling: maintain a `visiting` set per call-stack branch
 *      (added on entry, removed on exit). If a target is already in
 *      `visiting`, emit one isCycle=true message and don't recurse.
 *   4. Caps: stop emitting when maxMessages is hit; flag truncated.
 */
export function buildSequenceFlow(input: SequenceInputs): SequenceResult {
  const maxDepth = input.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxBranches = input.maxBranchesPerNode ?? DEFAULT_MAX_BRANCHES;
  const maxMessages = input.maxMessages ?? DEFAULT_MAX_MESSAGES;

  /* Build forward adjacency restricted to in-project files. */
  const adj = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  for (const e of input.edges) {
    if (!input.files.has(e.from) || !input.files.has(e.to)) continue;
    const arr = adj.get(e.from) ?? [];
    arr.push(e.to);
    adj.set(e.from, arr);
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  }
  /* Rank each node's out-edges by the target's in-degree so the most
     central downstream files fan out first. Tie-break alphabetically
     for deterministic output. */
  for (const arr of adj.values()) {
    arr.sort((a, b) => {
      const d = (inDeg.get(b) ?? 0) - (inDeg.get(a) ?? 0);
      return d !== 0 ? d : a.localeCompare(b);
    });
  }

  const messages: SequenceMessage[] = [];
  const lifelinesSet = new Set<string>();
  const lifelines: string[] = [];
  let truncated = false;
  let step = 0;

  function addLifeline(id: string) {
    if (lifelinesSet.has(id)) return;
    lifelinesSet.add(id);
    lifelines.push(id);
  }

  /* Entry node is always the first lifeline. */
  if (input.files.has(input.entryPoint)) addLifeline(input.entryPoint);

  function dfs(node: string, depth: number, visiting: Set<string>): void {
    if (messages.length >= maxMessages) { truncated = true; return; }
    if (depth >= maxDepth) { truncated = true; return; }
    const succ = adj.get(node) ?? [];
    const visible = succ.slice(0, maxBranches);
    if (succ.length > maxBranches) truncated = true;

    for (const to of visible) {
      if (messages.length >= maxMessages) { truncated = true; return; }
      const isCycle = visiting.has(to);
      step++;
      addLifeline(to);
      messages.push({ step, from: node, to, depth, isCycle, isReturn: false });
      if (isCycle) continue;

      /* Recurse into a fresh branch. The visiting set is per-branch so
         a node visited via a sibling branch isn't treated as a cycle. */
      visiting.add(to);
      dfs(to, depth + 1, visiting);
      visiting.delete(to);

      /* Synthetic return — only emit when the callee actually fanned
         out (i.e., we recursed). Skip when the callee was a leaf so
         the diagram doesn't pile up returns for every leaf import. */
      if ((adj.get(to)?.length ?? 0) > 0) {
        step++;
        messages.push({ step, from: to, to: node, depth, isCycle: false, isReturn: true });
      }
    }
  }

  if (input.files.has(input.entryPoint)) {
    dfs(input.entryPoint, 0, new Set([input.entryPoint]));
  }

  /* DSL rendering — swimlanes.io grammar:
       title: ...                  (optional; we use the entry path)
       Alice -> Bob: message       (forward message)
       Alice --> Bob: response     (dashed = return)
     We use the FILE BASENAMES as actor names for readability, with a
     comment block at the top mapping basenames back to full paths. */
  const dsl = renderDsl(input.entryPoint, lifelines, messages);

  return { entryPoint: input.entryPoint, lifelines, messages, truncated, dsl };
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

/** Build a basename map ensuring uniqueness — if two files share a
 *  basename (e.g. two index.ts), suffix with a #2 disambiguator. */
function buildActorNames(lifelines: string[]): Map<string, string> {
  const used = new Map<string, number>();
  const out = new Map<string, string>();
  for (const path of lifelines) {
    const base = basename(path) || path;
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    out.set(path, count === 0 ? base : `${base} #${count + 1}`);
  }
  return out;
}

function renderDsl(entry: string, lifelines: string[], messages: SequenceMessage[]): string {
  const actorOf = buildActorNames(lifelines);
  const lines: string[] = [];
  lines.push(`title: ${entry}`);
  lines.push('');
  /* Comment block: actor name → file path. swimlanes.io uses `#` for
     comments. Round-tripping this DSL preserves the mapping so users
     can re-derive paths from actor names later. */
  lines.push('# Actors → files');
  for (const path of lifelines) {
    lines.push(`# ${actorOf.get(path)} = ${path}`);
  }
  lines.push('');
  for (const m of messages) {
    const fromActor = actorOf.get(m.from) ?? m.from;
    const toActor = actorOf.get(m.to) ?? m.to;
    const arrow = m.isReturn ? '-->' : '->';
    const label = m.isCycle ? 'imports (cycle)' : (m.isReturn ? 'returns' : 'imports');
    lines.push(`${fromActor} ${arrow} ${toActor}: ${label}`);
  }
  return lines.join('\n').trimEnd();
}

/**
 * Pick a reasonable default entry point for a project. Strategy:
 *   1. First framework-route handler (highest in-degree wins).
 *   2. Failing that, the file with the highest out-degree among
 *      "entry-tier-shaped" files (index.ts at root, main.tsx, bin/*).
 *   3. Failing that, any file. We're never producing nothing — the
 *      sequence view should always have something to show.
 */
export function pickDefaultEntryPoint(
  files: ReadonlySet<string>,
  edges: ReadonlyArray<{ from: string; to: string }>,
  routeHandlers: ReadonlyArray<string>,
): string | null {
  if (files.size === 0) return null;
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  for (const e of edges) {
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
    outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
  }
  /* Routes ranked by in-degree first (most-imported route handlers
     are the most "central" ones — pages/admin/dashboard tends to be
     imported by layouts; pages/about-us isn't). */
  const validRoutes = routeHandlers.filter((p) => files.has(p));
  if (validRoutes.length > 0) {
    const ranked = validRoutes.slice().sort((a, b) => (inDeg.get(b) ?? 0) - (inDeg.get(a) ?? 0));
    return ranked[0] ?? null;
  }
  /* Failing that, highest out-degree entry-shaped file. */
  const candidates = Array.from(files).filter((p) =>
    /^(?:main|index|bin|cli)\.[jt]sx?$/i.test(basename(p)) ||
    /^bin\//.test(p),
  );
  if (candidates.length > 0) {
    candidates.sort((a, b) => (outDeg.get(b) ?? 0) - (outDeg.get(a) ?? 0));
    return candidates[0] ?? null;
  }
  /* Anyone with at least one out-edge. Else first file. */
  const withOutEdges = Array.from(files).filter((p) => (outDeg.get(p) ?? 0) > 0);
  if (withOutEdges.length > 0) {
    withOutEdges.sort((a, b) => (outDeg.get(b) ?? 0) - (outDeg.get(a) ?? 0));
    return withOutEdges[0] ?? null;
  }
  return Array.from(files)[0] ?? null;
}
