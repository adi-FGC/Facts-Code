/**
 * Mermaid diagram generators — v0.7.1.
 *
 * Pure, deterministic Mermaid-flowchart emitters over `AgentArtifact.graph`.
 * Three views (package / hub / focal) share the same output contract:
 *
 *   - Returns a string starting with a `flowchart` directive so the
 *     output can be wrapped in a ```mermaid block and dropped into any
 *     GitHub markdown surface (PR comments, READMEs, Discussions).
 *   - Deterministic: byte-identical output for byte-identical input.
 *   - Capped: every view enforces a node count + edge count budget so
 *     a 10k-file monorepo can't produce a Mermaid block that locks up
 *     the GitHub renderer (it tops out around ~50 nodes in practice).
 *   - Edge kind styling: imports = solid arrow, type-imports = dashed,
 *     dynamic-imports = thick arrow. The visual vocabulary is small
 *     enough that no legend is needed.
 *
 * Why these live in @factstack/core (not a sibling package today):
 * one renderer family (Mermaid), one output shape. When a second
 * adapter lands (D2, Graphviz DOT), promote to `@factstack/diagrams`
 * — same "second adapter ⇒ real seam" principle that scoped
 * `@factstack/skills` only after it had three renderers.
 *
 * The CLI verb `factstack export-diagram` dispatches based on
 * `--view`. `ci-report` embeds the package view in PR comments behind
 * an opt-in `--with-diagram` flag.
 */

import type { AgentArtifact } from '@factstack/spec';

/* ─────────── public API ─────────── */

export type DiagramView = 'package' | 'hub' | 'focal';

/**
 * The minimal slice every renderer here actually reads: the graph's edge
 * list. `AgentArtifact` satisfies this structurally, so all existing callers
 * (CLI, MCP, ci-report) keep passing a full artifact unchanged — but a caller
 * that only holds edges (e.g. the browser's `Dataset`) can feed the renderers
 * without fabricating a whole artifact or casting. Depend on what you use.
 */
export interface DiagramSource {
  /* buildDiagram reads only from/to/kind — keep the param to that minimal
     structural shape (not the full `AgentArtifact['graph']['edges']`) so any
     edge-bearing caller works, including the browser `Dataset` whose edges
     omit the F1 `confidence` field. Extra fields (confidence, …) are fine. */
  graph: { edges: ReadonlyArray<{ from: string; to: string; kind: string }> };
}

export interface DiagramOptions {
  view: DiagramView;
  /** Required for `focal`. Project-relative path of the file to center. */
  focus?: string;
  /** Max BFS depth for `focal`. Default 2; clamped to [1, 5]. */
  depth?: number;
  /** Global node-count cap. Default 30; clamped to [2, 80]. The
   *  low minimum (2 rather than e.g. 5) accommodates test fixtures
   *  and pathological tiny-budget callers; production CLIs would
   *  never pass anything that low, but the cap is the cap. */
  maxNodes?: number;
  /** Hub view: number of hub files to show. Default 3; clamped to [1, 5]. */
  topHubs?: number;
  /** Hub view: importers per hub. Default 5; clamped to [1, 12]. */
  importersPerHub?: number;
}

/**
 * Generate a Mermaid flowchart string for the given view.
 *
 * Dispatches to the per-view renderer based on `opts.view`. Throws
 * with a clear message if `focal` is requested without `opts.focus`
 * — the CLI is responsible for guarding that at the arg-parsing
 * layer, but the renderer enforces it as the second line of defense.
 *
 * Returns the bare Mermaid source (no ` ```mermaid ` wrappers). Callers
 * that target markdown wrap it; callers that target a `.mmd` file
 * write it as-is.
 */
export function buildDiagram(agent: DiagramSource, opts: DiagramOptions): string {
  switch (opts.view) {
    case 'package':
      return buildPackageDiagram(agent, opts);
    case 'hub':
      return buildHubDiagram(agent, opts);
    case 'focal':
      if (!opts.focus) {
        throw new Error('buildDiagram(focal): opts.focus is required');
      }
      return buildFocalDiagram(agent, { ...opts, focus: opts.focus });
  }
}

/* ─────────── package view ─────────── */

/**
 * One node per package, one edge per cross-package import (aggregated
 * with a count label). For a monorepo with N packages this is the
 * smallest readable summary — "where does my project's data flow at
 * the architectural level."
 *
 * Self-edges (within-package imports) are filtered. Bidirectional
 * pairs are kept as two separate edges so cycles are visible at a
 * glance, even though we don't compute cycle metadata for the package
 * graph (`agent.graph.cycles` operates at the file level).
 */
export function buildPackageDiagram(
  agent: DiagramSource,
  opts: Pick<DiagramOptions, 'maxNodes'> = {},
): string {
  const maxNodes = clamp(opts.maxNodes ?? 30, 2, 80);

  /* Aggregate edges to (fromPkg, toPkg) → { count, kinds }.
   * Tracking kinds lets us pick the most-representative arrow style
   * for the merged edge: if any edge is a regular import, the merged
   * arrow is solid; otherwise we degrade to dashed (type-only) or
   * thick (dynamic). */
  const edgeMap = new Map<string, { from: string; to: string; count: number; kinds: Set<string> }>();
  for (const e of agent.graph.edges) {
    const fromPkg = classifyPath(e.from);
    const toPkg = classifyPath(e.to);
    if (!fromPkg || !toPkg || fromPkg === toPkg) continue;
    const key = `${fromPkg}\x00${toPkg}`;
    const entry = edgeMap.get(key);
    if (entry) {
      entry.count++;
      entry.kinds.add(e.kind);
    } else {
      edgeMap.set(key, { from: fromPkg, to: toPkg, count: 1, kinds: new Set([e.kind]) });
    }
  }

  /* Collect referenced packages so we don't render orphan nodes. */
  const referenced = new Set<string>();
  for (const e of edgeMap.values()) {
    referenced.add(e.from);
    referenced.add(e.to);
  }
  const nodes = [...referenced].sort();

  /* Hard cap: trim least-active packages if we exceed the budget. */
  if (nodes.length > maxNodes) {
    /* Score each package by total edge weight (in + out) and keep
     * the top `maxNodes`. The dropped packages take their edges with
     * them — no dangling refs. */
    const weight = new Map<string, number>();
    for (const e of edgeMap.values()) {
      weight.set(e.from, (weight.get(e.from) ?? 0) + e.count);
      weight.set(e.to, (weight.get(e.to) ?? 0) + e.count);
    }
    const keep = new Set(
      [...weight.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, maxNodes)
        .map(([p]) => p),
    );
    for (const [key, e] of [...edgeMap.entries()]) {
      if (!keep.has(e.from) || !keep.has(e.to)) edgeMap.delete(key);
    }
    nodes.length = 0;
    nodes.push(...[...keep].sort());
  }

  const lines: string[] = [];
  lines.push('flowchart LR');

  /* Emit nodes first so the layout engine has stable IDs to refer to.
   * The label includes a short tag — `[apps/cli]` rather than just
   * `apps/cli` — for visual breathing room. */
  for (const pkg of nodes) {
    lines.push(`  ${sanitizeId(pkg)}["${escapeMermaidLabel(pkg)}"]`);
  }

  /* Edges sorted alphabetically by (from, to) for deterministic
   * output across runs. */
  const sortedEdges = [...edgeMap.values()].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
  for (const edge of sortedEdges) {
    const arrow = pickArrowForKinds(edge.kinds);
    const label = edge.count > 1 ? `|${edge.count}|` : '';
    lines.push(`  ${sanitizeId(edge.from)} ${arrow}${label} ${sanitizeId(edge.to)}`);
  }

  return lines.join('\n') + '\n';
}

/* ─────────── hub view ─────────── */

/**
 * Top-N most-imported files + their top-K importers. Surfaces the
 * "where the leverage is" structural picture — the files everything
 * depends on, and who depends on them.
 *
 * Hubs are ranked by in-degree (tied: alphabetical for determinism).
 * Importers per hub are ranked alphabetically — by-importer in-degree
 * would surface "which OTHER hub uses this hub" but feels noisier in
 * practice for a v1 visual.
 */
export function buildHubDiagram(
  agent: DiagramSource,
  opts: Pick<DiagramOptions, 'topHubs' | 'importersPerHub' | 'maxNodes'> = {},
): string {
  const topHubs = clamp(opts.topHubs ?? 3, 1, 5);
  const importersPerHub = clamp(opts.importersPerHub ?? 5, 1, 12);
  const maxNodes = clamp(opts.maxNodes ?? 30, 2, 80);

  /* in-degree per file, tracked with edge kinds for arrow styling. */
  const inDegree = new Map<string, number>();
  const incoming = new Map<string, Array<{ from: string; kind: string }>>();
  for (const e of agent.graph.edges) {
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    const arr = incoming.get(e.to) ?? [];
    arr.push({ from: e.from, kind: e.kind });
    incoming.set(e.to, arr);
  }

  const hubs = [...inDegree.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topHubs)
    .map(([path, n]) => ({ path, inDegree: n }));

  if (hubs.length === 0) {
    return 'flowchart LR\n  empty["(no edges in graph)"]\n';
  }

  /* Build the importer set per hub, capped + alpha-sorted. */
  const hubData = hubs.map((hub) => {
    const importers = (incoming.get(hub.path) ?? [])
      .slice()
      .sort((a, b) => a.from.localeCompare(b.from))
      .slice(0, importersPerHub);
    return { ...hub, importers };
  });

  /* Total node-count guard: hubs + their importers (deduped). The
   * importer caps already limit growth but a 5×5 hub matrix with 25
   * unique files might still exceed maxNodes on bigger limits. */
  const allNodes = new Set<string>();
  for (const h of hubData) {
    allNodes.add(h.path);
    for (const i of h.importers) allNodes.add(i.from);
  }
  if (allNodes.size > maxNodes) {
    /* Drop importers from the tail of each hub list (already sorted)
     * until under budget. Hubs themselves are always kept. */
    let toDrop = allNodes.size - maxNodes;
    for (let i = hubData.length - 1; i >= 0 && toDrop > 0; i--) {
      const hub = hubData[i];
      while (hub && hub.importers.length > 1 && toDrop > 0) {
        const dropped = hub.importers.pop();
        if (dropped && !hubData.some((h) => h.path === dropped.from || h.importers.some((j) => j.from === dropped.from))) {
          allNodes.delete(dropped.from);
          toDrop--;
        }
      }
    }
  }

  const lines: string[] = [];
  lines.push('flowchart LR');

  /* Emit hub nodes with a distinctive label so they stand out from
   * the importer commodity nodes. */
  for (const h of hubData) {
    lines.push(`  ${sanitizeId(h.path)}["${escapeMermaidLabel(shortPath(h.path))}<br/>↪ ${h.inDegree} importers"]`);
  }

  /* Emit importer nodes with their short label. Deduplicate against:
   *   - other importers (a file that imports two of the listed hubs
   *     should render once with two outgoing arrows, not twice).
   *   - the hub set itself (a file can be BOTH a hub AND an importer
   *     of a different hub — e.g. `loadArtifacts.ts` is a 21-degree
   *     hub but also imports the 44-degree `spec/index.ts`. Emitting
   *     it again as a plain importer would clobber the hub label
   *     since Mermaid uses last-write-wins for duplicate IDs). */
  const renderedImporters = new Set<string>(hubData.map((h) => h.path));
  for (const h of hubData) {
    for (const imp of h.importers) {
      if (renderedImporters.has(imp.from)) continue;
      renderedImporters.add(imp.from);
      lines.push(`  ${sanitizeId(imp.from)}["${escapeMermaidLabel(shortPath(imp.from))}"]`);
    }
  }

  /* Edges importer → hub. Order: hub-by-hub, importer alpha within. */
  for (const h of hubData) {
    for (const imp of h.importers) {
      const arrow = arrowForKind(imp.kind);
      lines.push(`  ${sanitizeId(imp.from)} ${arrow} ${sanitizeId(h.path)}`);
    }
  }

  /* Style hubs so they pop visually. The `style` directive applies
   * to a specific node by ID — Mermaid renders it as a filled
   * rectangle distinct from the unstyled importer nodes. */
  for (const h of hubData) {
    lines.push(`  style ${sanitizeId(h.path)} fill:#dbeafe,stroke:#1e40af,stroke-width:2px`);
  }

  return lines.join('\n') + '\n';
}

/* ─────────── focal view ─────────── */

/**
 * Caller graph rooted at `opts.focus`. BFS-expands the set of files
 * that transitively import the focus, capped by depth + node count.
 *
 * Direction is "callers" (things that import focus) by default —
 * answers "what would break if I changed this file?" Future addition:
 * `--direction callees` for "what does this file transitively depend
 * on?" but v1 keeps to the more common workflow.
 */
export function buildFocalDiagram(
  agent: DiagramSource,
  opts: { focus: string; depth?: number; maxNodes?: number },
): string {
  const depth = clamp(opts.depth ?? 2, 1, 5);
  const maxNodes = clamp(opts.maxNodes ?? 30, 2, 80);
  const focus = opts.focus;

  /* Quick existence check. If focus isn't in the graph at all, we'd
   * silently emit an empty diagram — better to surface the issue with
   * a clear placeholder. */
  const allNodes = new Set<string>();
  for (const e of agent.graph.edges) {
    allNodes.add(e.from);
    allNodes.add(e.to);
  }
  if (!allNodes.has(focus)) {
    return (
      'flowchart LR\n' +
      `  unknown["focus not in graph:<br/>${escapeMermaidLabel(focus)}"]\n`
    );
  }

  /* Build reverse-edges map: for each file, who imports it.
   * BFS walks this map outward. */
  const callers = new Map<string, Array<{ from: string; kind: string }>>();
  for (const e of agent.graph.edges) {
    const arr = callers.get(e.to) ?? [];
    arr.push({ from: e.from, kind: e.kind });
    callers.set(e.to, arr);
  }

  /* BFS frontier-by-frontier so we naturally respect the depth cap +
   * can stop cleanly at maxNodes. Edges emitted in discovery order
   * (which is deterministic given alphabetical neighbour iteration). */
  const visited = new Set<string>([focus]);
  const edges: Array<{ from: string; to: string; kind: string }> = [];
  let frontier = [focus];
  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const node of frontier) {
      const incoming = callers.get(node) ?? [];
      const sortedIncoming = incoming.slice().sort((a, b) => a.from.localeCompare(b.from));
      for (const inc of sortedIncoming) {
        if (visited.size >= maxNodes) break;
        if (!visited.has(inc.from)) {
          visited.add(inc.from);
          next.push(inc.from);
        }
        edges.push({ from: inc.from, to: node, kind: inc.kind });
      }
      if (visited.size >= maxNodes) break;
    }
    frontier = next;
  }

  const lines: string[] = [];
  lines.push('flowchart LR');

  /* Focus node first, styled distinctively. */
  lines.push(`  ${sanitizeId(focus)}["${escapeMermaidLabel(shortPath(focus))}"]`);
  lines.push(
    `  style ${sanitizeId(focus)} fill:#fef3c7,stroke:#d97706,stroke-width:2px`,
  );

  /* Other nodes (visited minus focus) in alpha order. */
  const others = [...visited].filter((n) => n !== focus).sort();
  for (const node of others) {
    lines.push(`  ${sanitizeId(node)}["${escapeMermaidLabel(shortPath(node))}"]`);
  }

  /* Edges — already in BFS discovery order, which is deterministic. */
  for (const e of edges) {
    const arrow = arrowForKind(e.kind);
    lines.push(`  ${sanitizeId(e.from)} ${arrow} ${sanitizeId(e.to)}`);
  }

  return lines.join('\n') + '\n';
}

/* ─────────── helpers ─────────── */

/**
 * Classify a project-relative path to a package label.
 *
 * Recognized prefixes:
 *   - `packages/<name>/...` → `packages/<name>`
 *   - `apps/<name>/...` → `apps/<name>`
 *   - `docs/...` → `docs`
 *   - `legacy/...` → `legacy`
 *   - anything else → null (skipped from the package view; usually
 *     means root-level config files like `vite.config.ts` which
 *     would each become a single-file package).
 *
 * The two-prefix model fits this repo's pnpm-workspace layout. Other
 * monorepos with different conventions (e.g., `libs/<name>` from
 * Nx) would need to extend this — a future enhancement once a second
 * consumer pattern is real.
 */
export function classifyPath(p: string): string | null {
  const norm = p.replace(/\\/g, '/');
  const match = norm.match(/^(packages|apps)\/([^/]+)/);
  if (match) return `${match[1]}/${match[2]}`;
  if (norm.startsWith('docs/')) return 'docs';
  if (norm.startsWith('legacy/')) return 'legacy';
  return null;
}

/**
 * Sanitize a path to a valid Mermaid node ID. IDs cannot contain
 * slashes, dots, hyphens-in-edges, or other characters that would
 * be parsed as Mermaid syntax. Replace non-alphanumerics with `_`
 * and prefix with `n_` to guarantee a letter start (Mermaid IDs
 * can't start with a digit).
 */
export function sanitizeId(s: string): string {
  return 'n_' + s.replace(/[^a-zA-Z0-9]/g, '_');
}

/**
 * Trim a long file path to a label that fits in a Mermaid node
 * without overflowing. Strategy:
 *   - keep the package prefix + filename
 *   - elide the middle `/src/`-like path segments with `…`
 *   - if still too long, truncate the filename
 *
 * Example: `apps/ui-remix/src/lib/loadArtifacts.ts` becomes
 *   `apps/ui-remix/…/loadArtifacts.ts`.
 */
export function shortPath(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const parts = norm.split('/');
  if (parts.length <= 3) return norm;
  const head = parts.slice(0, 2).join('/');
  const tail = parts[parts.length - 1];
  return `${head}/…/${tail}`;
}

/**
 * Escape a string for safe inclusion in a Mermaid node label. The
 * primary risks are `"` (breaks the label literal) and `<` / `>`
 * (interpreted as HTML by Mermaid's renderer). Newlines must be
 * encoded as `<br/>`. The renderer is HTML-aware so we don't need
 * to escape `&` — Mermaid handles entities itself.
 */
export function escapeMermaidLabel(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Map an edge kind to its Mermaid arrow representation. */
function arrowForKind(kind: string): string {
  switch (kind) {
    case 'type-import':
      return '-.->';
    case 'dynamic-import':
      return '==>';
    case 'import':
    default:
      return '-->';
  }
}

/**
 * Pick the arrow style for a merged (aggregated) edge in the package
 * view. Solid arrows win — if any constituent edge is a regular
 * import, the merged arrow is solid. Otherwise prefer dashed
 * (type-imports are "lighter" than dynamic-imports for architectural
 * inspection).
 */
function pickArrowForKinds(kinds: Set<string>): string {
  if (kinds.has('import')) return '-->';
  if (kinds.has('dynamic-import')) return '==>';
  return '-.->';
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
