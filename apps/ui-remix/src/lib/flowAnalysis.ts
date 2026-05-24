/**
 * Flow analysis — classify files into architectural tiers and compute
 * data-flow shape from existing dataset signals.
 *
 * What this module derives (without any analyzer changes):
 *
 *   - Per-file `Tier` classification using a layered heuristic:
 *       1. Explicit signals (file appears in data.routes[].handlerFile,
 *          file appears in data.entryPoints, file path matches a
 *          framework-specific convention like Next.js app/page.tsx).
 *       2. Path-pattern signals (`/schemas/`, `/models/`, `/api/`,
 *          `/components/`, `*.schema.ts`, etc).
 *       3. Topology signals (no out-edges + no in-edges = isolated;
 *          high in-degree + low out-degree = sink/data; high out-degree
 *          + zero callers = entry).
 *
 *   - Tier-to-tier edge aggregation: sum of file→file imports grouped
 *     by source-tier × dest-tier. Powers the swimlane arrows.
 *
 *   - Sample end-to-end flow paths: longest tier-coherent sequences
 *     from Entry/UI through the system to Data/External. These are
 *     the "request goes here, then here, then here" narratives.
 *
 *   - Entity inventory: files classified as Data (schemas, models,
 *     types) with their inbound referrer counts. Without per-file
 *     declaration extraction this is file-grained, not type-grained
 *     — symbol-level entities arrive with v0.4.4.
 *
 * Pure. No I/O, no DOM. Consumed by ui/flow/* components.
 *
 * History: built for the Flow tab in v0.5. Independent of the existing
 * graph analysis (lib/graphAnalysis.ts) because the questions are
 * orthogonal: graph asks "where's the coupling?", flow asks "what does
 * the app DO with data?".
 */

/* ─────────── tier model ─────────── */

/**
 * Architectural tiers, ordered top → bottom by data-flow convention.
 * The swimlane renderer paints them in this order; tier-to-tier arrows
 * usually point downward (request inbound) but upward arrows are valid
 * (response, callback, event emit).
 */
export type Tier =
  | 'entry'    // CLI bins, top-level dev-server bootstrap, build entrypoints
  | 'ui'       // React/Vue components, pages, views
  | 'route'    // HTTP route handlers (Express/FastAPI/Remix routes)
  | 'handler'  // Service layer: business logic invoked by routes
  | 'data'     // Schemas, models, DB layer, type definitions
  | 'external' // Network boundary: outbound API clients, fetch wrappers
  | 'lib'      // Internal utilities, helpers, framework-agnostic libs
  | 'config'   // Manifest files, build config, env loaders
  | 'test'     // Test files and fixtures
  | 'other';   // Fallback bucket

/** Display order — swimlane top-to-bottom. */
export const TIER_ORDER: readonly Tier[] = [
  'entry', 'ui', 'route', 'handler', 'data', 'external', 'lib', 'config', 'test', 'other',
] as const;

/** Editorial labels for each tier. */
export const TIER_LABEL: Record<Tier, string> = {
  entry:    'Entry points',
  ui:       'UI · views',
  route:    'Routes · handlers',
  handler:  'Services · logic',
  data:     'Data · schemas',
  external: 'External · boundary',
  lib:      'Library · utilities',
  config:   'Config · manifest',
  test:     'Tests',
  other:    'Other',
};

/** Editorial one-line descriptions — power the FootnoteChip tooltips. */
export const TIER_DESCRIPTION: Record<Tier, string> = {
  entry:    'Where execution starts — CLI bins, dev-server bootstrap, top-level routes.',
  ui:       'User-facing surfaces: components, pages, views.',
  route:    'HTTP route registration: maps URLs to handlers.',
  handler:  'Business logic — the code routes call into to do real work.',
  data:     'Data shape: schemas, models, DB layer, type definitions.',
  external: 'Outbound network: API clients, fetch wrappers, SDK calls.',
  lib:      'Internal utilities. Framework-agnostic, no business semantics.',
  config:   'Build, runtime, and environment configuration.',
  test:     'Test files and fixtures.',
  other:    'Everything that didn\'t match a more specific tier.',
};

/* ─────────── inputs ─────────── */

export interface FlowFileInput {
  path: string;
  language: string | null;
  /** ext including dot, e.g. ".ts" */
  ext: string;
}

export interface FlowEdgeInput {
  from: string;
  to: string;
}

export interface FlowRouteInput {
  handlerFile: string;
  framework: string;
}

export interface FlowEntryPointInput {
  path: string;
  handlerFile: string;
}

export interface FlowInputs {
  files: ReadonlyArray<FlowFileInput>;
  edges: ReadonlyArray<FlowEdgeInput>;
  routes: ReadonlyArray<FlowRouteInput>;
  entryPoints: ReadonlyArray<FlowEntryPointInput>;
  frameworks: ReadonlyArray<string>;
}

/* ─────────── classification ─────────── */

/**
 * Path-pattern rules. Each rule is `[tier, regex, weight]`.
 *
 * Weight semantics:
 *   3 — filename-suffix patterns (e.g. `*.schema.ts`, `*.test.ts`).
 *       Strong evidence: the author named the file to declare intent.
 *   2 — directory-segment patterns (e.g. `/schemas/`, `/components/`).
 *       Moderate evidence: the file's *location* implies its role,
 *       but it could be misplaced.
 *   1 — generic extension matches (e.g. `.tsx`, `.jsx`). Weak
 *       evidence: every React component is a `.tsx`, but a route
 *       handler in a SPA can also be `.tsx`.
 *
 * Confidence-scored classification (Option B): every matching rule
 * contributes its weight to the rule's tier; the highest-scoring tier
 * wins. Ties broken by rule-array order (stable). This handles the
 * common conflict like `apps/web/components/api/Client.tsx`:
 *   - /api/    → route +2
 *   - /components/ → ui +2
 *   - .tsx     → ui +1
 *   Result: ui wins (3 vs 2). Correct — it's a UI client component
 *   that happens to live under an /api/ folder name.
 *
 * These patterns capture the conventional layouts of Next.js, Remix,
 * Express, FastAPI, Django, generic Vite SPAs, and turbo/pnpm
 * monorepos. They're not exhaustive — projects with bespoke layouts
 * may fall into `other` and need explicit overrides.
 */
const PATH_RULES: ReadonlyArray<readonly [Tier, RegExp, number]> = [
  // Tests — filename and directory signals
  ['test',    /\.(?:test|spec)\.[jt]sx?$/i, 3],
  ['test',    /(?:^|\/)(?:__tests__|tests?|spec)\//, 2],

  // Config — filename signals for config files, dir for config folders
  ['config',  /(?:^|\/)(?:vite|webpack|rollup|tsconfig|tsconfig\.\w+|next|remix|astro|nuxt|svelte|tailwind|postcss|eslint|prettier|babel|jest|vitest|playwright|stylelint)\.config\.[cm]?[jt]sx?$/i, 3],
  ['config',  /(?:^|\/)(?:turbo|nx|lerna|rush|pnpm-workspace|package|tsconfig)\.json$/i, 3],
  ['config',  /^(?:\.env|\.env\..+|\.gitignore|\.prettierrc|\.eslintrc.*)$/i, 3],
  ['config',  /(?:^|\/)config(?:s)?\//, 2],

  // Data — explicit filename suffixes are the strongest signal.
  // .sql files are data by extension alone (migrations, seeds).
  ['data',    /\.(?:schema|model|entity|dto|types?)\.[jt]sx?$/i, 3],
  ['data',    /\.sql$/i, 3],
  ['data',    /(?:^|\/)(?:schemas?|models?|entities|types|prisma|migrations?)\//, 2],
  ['data',    /(?:^|\/)(?:db|database|repository|repositories)\//, 2],
  ['data',    /(?:^|\/)dao\//, 2],
  ['data',    /(?:^|\/)supabase\//, 2],

  // Routes — file conventions (Next.js + Astro) are strong signals.
  // The bare /api/ rule is deliberately gone: it fires on test files
  // and api-helper utilities, double-counting noise on top of the
  // explicit Layer-1 route-handler signal which is reliable on its own.
  ['route',   /(?:^|\/)(?:app|pages)\/.*\/(?:page|route|layout)\.[jt]sx?$/i, 3],
  ['route',   /(?:^|\/)(?:app|pages)\/api\//, 3],
  ['route',   /(?:^|\/)pages\/.+\.astro$/i, 3],
  ['route',   /(?:^|\/)routes\//, 2],

  // External — filename `*.client.ts` is explicit; dir is weaker
  ['external', /\.client\.[jt]sx?$/i, 3],
  ['external', /(?:^|\/)(?:clients?|integrations?|adapters?|vendors?)\//, 2],

  // Handler / service layer — dir signals only
  ['handler', /(?:^|\/)(?:services?|controllers?|handlers?|usecases?|domain)\//, 2],
  ['handler', /(?:^|\/)server\//, 2],

  // UI — dir signals + the JSX/Vue/Svelte/Astro extension as weak evidence.
  // Astro and Svelte are treated identically to React/Vue here.
  ['ui',      /(?:^|\/)(?:components?|views?|pages?|screens?|widgets?|islands?)\//, 2],
  ['ui',      /\.(?:tsx|jsx|vue|svelte|astro)$/i, 1],

  // Lib — dir signals only
  ['lib',     /(?:^|\/)(?:lib|libs|utils?|helpers?|shared|common)\//, 2],

  // Entry — only ROOT-level main/index/bin/cli or files inside /bin/.
  // The previous `(?:^|\/)index\.[jt]sx?$` rule fired on every barrel
  // file (`src/store/index.ts`, `src/lib/auth/index.ts` …) and produced
  // false-positive entry-tier counts. Anchor to root + /bin/.
  ['entry',   /^(?:main|index|bin|cli)\.[jt]sx?$/i, 2],
  ['entry',   /(?:^|\/)bin\//, 2],
];

/**
 * Classify a single file into a tier using a three-layer heuristic:
 *
 *   1. **Explicit signals** from the analyzer (entry point, route
 *      handler) — these always win because they represent real
 *      framework wiring, not a guess from a directory name.
 *   2. **Confidence-scored path patterns** — every matching rule
 *      adds its weight to the rule's tier; highest score wins. Ties
 *      broken by the order in which the winning tier first hit a
 *      match (stable across rule reorders within the same tier).
 *   3. **Fallback** — `other`.
 */
export function classifyFile(
  path: string,
  routeHandlerSet: ReadonlySet<string>,
  entryHandlerSet: ReadonlySet<string>,
): Tier {
  /* Layer 1 — explicit signals. */
  if (entryHandlerSet.has(path)) return 'entry';
  if (routeHandlerSet.has(path)) return 'route';

  /* Layer 2 — confidence-scored path patterns (Option B).
     Track first-match order per tier so ties resolve deterministically
     to whichever tier hit a rule earliest in the array — that's the
     project's stated priority encoded in the rule order. */
  const norm = path.replace(/\\/g, '/');
  const scores = new Map<Tier, number>();
  const firstHitIdx = new Map<Tier, number>();
  for (let i = 0; i < PATH_RULES.length; i++) {
    const [tier, re, weight] = PATH_RULES[i]!;
    if (!re.test(norm)) continue;
    scores.set(tier, (scores.get(tier) ?? 0) + weight);
    if (!firstHitIdx.has(tier)) firstHitIdx.set(tier, i);
  }
  if (scores.size === 0) return 'other';

  /* Pick the highest-scoring tier; ties go to whichever hit earliest
     in the rule array (lower firstHitIdx). */
  let bestTier: Tier = 'other';
  let bestScore = -1;
  let bestIdx = Infinity;
  for (const [tier, score] of scores) {
    const idx = firstHitIdx.get(tier) ?? Infinity;
    if (score > bestScore || (score === bestScore && idx < bestIdx)) {
      bestTier = tier;
      bestScore = score;
      bestIdx = idx;
    }
  }
  return bestTier;
}

/* ─────────── topology computation ─────────── */

export interface FlowFile extends FlowFileInput {
  tier: Tier;
  inDegree: number;
  outDegree: number;
}

export interface TierEdge {
  from: Tier;
  to: Tier;
  count: number;
}

export interface FlowPath {
  /** Tiers visited in order. */
  tiers: Tier[];
  /** Sample files at each step — picked by highest betweenness within
   *  the tier (approximated as highest in-degree + out-degree). */
  samples: string[][];
  /** Total edge count along this path. Higher = more travelled. */
  weight: number;
}

export interface EntitySummary {
  path: string;
  /** Number of in-project files that import this entity file. */
  referrers: number;
  /** Sample referrer paths (top 3 by total degree). */
  sampleReferrers: string[];
}

export interface FlowResult {
  /** Every file with its tier + degree. */
  files: ReadonlyMap<string, FlowFile>;
  /** Per-tier file counts. Tiers with zero files are omitted. */
  tierCounts: ReadonlyMap<Tier, number>;
  /** Aggregated tier → tier edge counts. Self-loops (intra-tier edges)
   *  included separately for legend purposes. */
  tierEdges: ReadonlyArray<TierEdge>;
  /** Sample data-flow paths through the tier graph, ranked by total
   *  edge weight. Useful for the "Top flows" callouts. */
  paths: ReadonlyArray<FlowPath>;
  /** Files classified as `data` with their referrer rollup. The
   *  "entities" view's primary input. */
  entities: ReadonlyArray<EntitySummary>;
}

/**
 * Build the full flow analysis from dataset inputs. Pure function —
 * caller adapts Dataset → FlowInputs at the route layer.
 */
export function analyzeFlow(input: FlowInputs): FlowResult {
  const routeHandlerSet = new Set<string>(input.routes.map((r) => r.handlerFile).filter(Boolean));
  const entryHandlerSet = new Set<string>(input.entryPoints.map((e) => e.handlerFile).filter(Boolean));

  /* Per-file classification + degree. */
  const files = new Map<string, FlowFile>();
  for (const f of input.files) {
    files.set(f.path, {
      ...f,
      tier: classifyFile(f.path, routeHandlerSet, entryHandlerSet),
      inDegree: 0,
      outDegree: 0,
    });
  }

  /* Restrict edges to in-project files (drop dangling references). */
  const validEdges: FlowEdgeInput[] = [];
  for (const e of input.edges) {
    if (!files.has(e.from) || !files.has(e.to)) continue;
    validEdges.push(e);
    files.get(e.from)!.outDegree++;
    files.get(e.to)!.inDegree++;
  }

  /* Tier counts. */
  const tierCounts = new Map<Tier, number>();
  for (const f of files.values()) {
    tierCounts.set(f.tier, (tierCounts.get(f.tier) ?? 0) + 1);
  }

  /* Tier × tier edge aggregation. */
  const tierEdgeMap = new Map<string, TierEdge>();
  for (const e of validEdges) {
    const from = files.get(e.from)!.tier;
    const to = files.get(e.to)!.tier;
    const key = `${from}|${to}`;
    const existing = tierEdgeMap.get(key);
    if (existing) existing.count++;
    else tierEdgeMap.set(key, { from, to, count: 1 });
  }
  const tierEdges = Array.from(tierEdgeMap.values()).sort((a, b) => b.count - a.count);

  /* Sample flow paths — find the top-3 highest-weight chains through
     distinct tiers. Build a directed multigraph on tiers (skip
     self-loops, since a path that revisits the same tier doesn't
     teach the reader anything new), then enumerate paths of length 2-5
     via DFS, ranking by sum of edge weights.

     Note: a tier graph has at most 10 nodes (TIER_ORDER.length), so
     full enumeration is fine. */
  const paths = enumerateFlowPaths(tierEdges, files);

  /* Entity inventory. */
  const entities = buildEntityInventory(files, validEdges);

  return { files, tierCounts, tierEdges, paths, entities };
}

/** DFS enumeration of distinct-tier paths in the tier-edge graph. */
function enumerateFlowPaths(
  tierEdges: ReadonlyArray<TierEdge>,
  files: ReadonlyMap<string, FlowFile>,
): FlowPath[] {
  /* Build adjacency: only inter-tier edges. */
  const adj = new Map<Tier, Array<{ to: Tier; count: number }>>();
  for (const e of tierEdges) {
    if (e.from === e.to) continue;
    const arr = adj.get(e.from) ?? [];
    arr.push({ to: e.to, count: e.count });
    adj.set(e.from, arr);
  }

  /* DFS up to depth 5 from every starting tier; collect all distinct-tier
     paths with their summed weight. */
  const candidates: FlowPath[] = [];
  function dfs(node: Tier, visited: Set<Tier>, pathTiers: Tier[], weight: number) {
    if (pathTiers.length >= 2) {
      candidates.push({
        tiers: pathTiers.slice(),
        weight,
        samples: pathTiers.map((t) => sampleFilesForTier(t, files, 2)),
      });
    }
    if (pathTiers.length >= 5) return;
    for (const next of adj.get(node) ?? []) {
      if (visited.has(next.to)) continue;
      visited.add(next.to);
      pathTiers.push(next.to);
      dfs(next.to, visited, pathTiers, weight + next.count);
      pathTiers.pop();
      visited.delete(next.to);
    }
  }
  for (const start of TIER_ORDER) {
    if (!adj.has(start)) continue;
    dfs(start, new Set([start]), [start], 0);
  }

  /* Dedupe by tier-sequence string; keep highest-weight version. */
  const best = new Map<string, FlowPath>();
  for (const c of candidates) {
    const key = c.tiers.join('>');
    const existing = best.get(key);
    if (!existing || c.weight > existing.weight) best.set(key, c);
  }
  /* Rank by weight desc; keep top 5. */
  return Array.from(best.values()).sort((a, b) => b.weight - a.weight).slice(0, 5);
}

/** Pick top-N files in a tier by total degree (in + out). */
function sampleFilesForTier(
  tier: Tier,
  files: ReadonlyMap<string, FlowFile>,
  limit: number,
): string[] {
  const inTier: FlowFile[] = [];
  for (const f of files.values()) {
    if (f.tier === tier) inTier.push(f);
  }
  inTier.sort((a, b) => (b.inDegree + b.outDegree) - (a.inDegree + a.outDegree));
  return inTier.slice(0, limit).map((f) => f.path);
}

function buildEntityInventory(
  files: ReadonlyMap<string, FlowFile>,
  edges: ReadonlyArray<FlowEdgeInput>,
): EntitySummary[] {
  /* Referrer index: target → list of source paths. */
  const referrers = new Map<string, string[]>();
  for (const e of edges) {
    const arr = referrers.get(e.to) ?? [];
    arr.push(e.from);
    referrers.set(e.to, arr);
  }

  const out: EntitySummary[] = [];
  for (const f of files.values()) {
    if (f.tier !== 'data') continue;
    const refs = referrers.get(f.path) ?? [];
    /* Pick top-3 referrers by their own total degree — gives the
       reader the most-central callers, not just an arbitrary three. */
    const ranked = refs
      .map((p) => ({ path: p, deg: (files.get(p)?.inDegree ?? 0) + (files.get(p)?.outDegree ?? 0) }))
      .sort((a, b) => b.deg - a.deg)
      .slice(0, 3)
      .map((x) => x.path);
    out.push({ path: f.path, referrers: refs.length, sampleReferrers: ranked });
  }
  out.sort((a, b) => b.referrers - a.referrers);
  return out;
}
