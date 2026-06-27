/**
 * Graph — merged dependency view (heatmap + diagram + layers).
 *
 * Structure:
 *   ┌─────────────────────────────────────────────────────┐
 *   │  Kicker · headline · lede                           │
 *   │  Stats row (Modules · Files · Edges · Cross)        │
 *   │  ViewModeToggle [Heatmap | Diagram | Layers]        │
 *   ├─────────────────────────────────────────────────────┤
 *   │  Primary view (one of three, driven by toggle)      │
 *   │    Heatmap  → Heatmap component                     │
 *   │    Diagram  → SugiyamaDag                           │
 *   │    Layers   → CyclesPanel + LayerSummary            │
 *   ├─────────────────────────────────────────────────────┤
 *   │  Cycles section (always shown when present)         │
 *   │  Heaviest couplings table                           │
 *   │  Hubs table                                         │
 *   └─────────────────────────────────────────────────────┘
 *
 * Why "always show cycles" even though the Layers view also has them:
 *   Cycles are bad news the reader needs at the top regardless of which
 *   visualization they pick. A cycle in Diagram mode shows as nodes in
 *   the same SCC sharing a layer; a cycle in Heatmap shows as a heavy
 *   diagonal cell — neither is as immediately readable as a named list.
 *
 * Why keep Couplings + Hubs always visible:
 *   They're the "what should I look at?" tables that anchor every
 *   visualization with concrete file/folder names. The diagram is
 *   beautiful but not navigable on its own; the Hubs table gives the
 *   reader a "click here next" affordance.
 *
 * History:
 *   - v0.3 had separate /graph (heatmap) and /dag (layer table) tabs.
 *   - v0.4 merges them: same data, three lenses, one URL.
 *   - The Sugiyama diagram is the new third lens — it answers the
 *     "how does dependency flow?" question that neither heatmap nor
 *     table addressed well.
 */
import type { Handle } from 'remix/ui';
import { css } from 'remix/ui';
import type { Dataset, DatasetFile, DatasetTreeNode } from '../lib/loadArtifacts.ts';
import {
  buildCouplings,
  buildHeatmap,
  buildHubs,
  buildSugiyamaLayout,
  capHeatmap,
  findCycles,
  layerByLongestPath,
  moduleOf,
  tarjanSCC,
  type HeatmapResult,
} from '../lib/graphAnalysis.ts';
import { ContentWithMargin, MarginColumn } from '../ui/MarginColumn.tsx';
import { Section } from '../ui/Section.tsx';
import { LabelNumber, LabelNumberRow } from '../ui/LabelNumber.tsx';
import { FootnoteChip } from '../ui/FootnoteChip.tsx';
import { Heatmap } from '../ui/graph/Heatmap.tsx';
import { CyclesPanel } from '../ui/graph/CyclesPanel.tsx';
import { LayerSummary } from '../ui/graph/LayerSummary.tsx';
import { HubsTable } from '../ui/graph/HubsTable.tsx';
import { CouplingsTable } from '../ui/graph/CouplingsTable.tsx';
import { SugiyamaDag } from '../ui/graph/SugiyamaDag.tsx';
import { DagControls, type Granularity } from '../ui/graph/DagControls.tsx';
import { SankeyDiagram } from '../ui/SankeyDiagram.tsx';
import { ExportMermaidButton } from '../ui/graph/ExportMermaidButton.tsx';
import {
  ViewModeToggle,
  readStoredMode,
  type GraphViewMode,
} from '../ui/graph/ViewModeToggle.tsx';

interface GraphProps {
  data: Dataset;
}

/* ─────────── styles ─────────── */

const kicker = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
  marginBottom: 'var(--space-5)',
});

const headline = css({
  /* Same change as Overview: switched from --font-display (Fraunces)
     to --font-body (Mona Sans). Display-size sans reads as dashboard
     hero; the serif read as old-broadsheet headline at this size. */
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-display-sm)',
  fontWeight: '600',
  letterSpacing: '-0.03em',
  lineHeight: '1.08',
  color: 'var(--fg)',
  marginBottom: 'var(--space-6)',
});

const lede = css({
  fontFamily: 'var(--font-display)',
  fontSize: 'var(--fs-20)',
  fontWeight: '400',
  letterSpacing: '-0.005em',
  lineHeight: '1.45',
  color: 'var(--fg-muted)',
  fontVariationSettings: '"opsz" 24',
  maxWidth: '56ch',
  marginBottom: 'var(--space-8)',
});

const toggleRow = css({
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 'var(--space-3)',
  marginTop: 'var(--space-6)',
  marginBottom: 'var(--space-4)',
  paddingBottom: 'var(--space-3)',
  borderBottom: '1px solid var(--hairline)',
});

const toggleHint = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
});

/* ─────────── helpers ─────────── */

function flattenFiles(node: DatasetTreeNode): DatasetFile[] {
  const out: DatasetFile[] = [];
  (function walk(n: DatasetTreeNode) {
    for (const f of n.files) out.push(f);
    for (const c of n.children) walk(c);
  })(node);
  return out;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 10_000) return (n / 1_000).toFixed(1) + 'K';
  if (n >= 1_000) return (n / 1_000).toFixed(2) + 'K';
  return n.toLocaleString('en-US');
}

/* Past this many modules the bipartite layout becomes an unreadable wall, so
   the Sankey keeps the top N by cross-module throughput and the title says
   "top N of M". 18 leaves both columns legible at the default height. */
const MODULE_SANKEY_CAP = 18;

/* The heatmap is an N×N grid; past this many modules the rotated column labels
   and cell density stop being readable, so it shows the top N by total degree
   (a no-op on smaller repos) with a "top N of M" title. */
const HEATMAP_MODULE_CAP = 24;

interface ModuleSankey {
  nodes: Array<{ id: string; label: string; column: number; color?: string }>;
  links: Array<{ source: string; target: string; value: number }>;
  /** Modules actually drawn (≤ cap). */
  shownModules: number;
  /** Modules with any cross-module coupling (the honest denominator). */
  totalModules: number;
  /** Cross-module import edges among the drawn modules. */
  shownEdges: number;
  /** All cross-module import edges (matrix off-diagonal sum). */
  totalCrossEdges: number;
}

/* Module-coupling Sankey adapter. Bipartite: every module can be both an
   importer (left column, `src:`) and an import target (right column, `dst:`),
   so each gets two node ids. Intra-module edges (the matrix diagonal) are
   skipped — that's the Heatmap's tinted diagonal, and as a ribbon it would
   only be a flat self-band. Modules carrying NO cross-module flow are dropped
   entirely (a leaf util that nobody imports across a boundary adds nothing to
   a coupling diagram), and on large repos only the top `cap` by throughput
   are kept so the picture stays readable. */
function moduleFlowSankey(coupling: HeatmapResult, cap = MODULE_SANKEY_CAP): ModuleSankey {
  const { folders, matrix } = coupling;

  /* Cross-module throughput per module = off-diagonal row + column sums
     (everything it imports across a boundary + everything that imports it). */
  const throughput = folders.map((_, i) => {
    let t = 0;
    for (let j = 0; j < folders.length; j++) {
      if (j === i) continue;
      t += matrix[i]![j]! + matrix[j]![i]!;
    }
    return t;
  });

  const coupled = folders
    .map((f, i) => ({ f, i, t: throughput[i]! }))
    .filter((m) => m.t > 0);
  const kept = coupled
    .slice()
    .sort((a, b) => b.t - a.t || (a.f < b.f ? -1 : a.f > b.f ? 1 : 0))
    .slice(0, cap);

  const nodes = [
    ...kept.map((m, k) => ({
      id: `src:${m.f}`,
      label: m.f,
      column: 0,
      /* Distinct hue per importer; stepping by 33° spreads up to ~11 before
         hues repeat, which is plenty once the cap and zero-flow drop bite. */
      color: `oklch(64% 0.13 ${(248 + k * 33) % 360})`,
    })),
    ...kept.map((m) => ({ id: `dst:${m.f}`, label: m.f, column: 1, color: 'var(--fg-subtle)' })),
  ];

  const links: ModuleSankey['links'] = [];
  let shownEdges = 0;
  for (const a of kept) {
    for (const b of kept) {
      if (a.i === b.i) continue;
      const v = matrix[a.i]![b.i]!;
      if (v > 0) {
        links.push({ source: `src:${a.f}`, target: `dst:${b.f}`, value: v });
        shownEdges += v;
      }
    }
  }

  return {
    nodes,
    links,
    shownModules: kept.length,
    totalModules: coupled.length,
    shownEdges,
    totalCrossEdges: coupling.crossEdges,
  };
}

/* Node count cap for the SVG diagram. Past this, the layout becomes
 * unreadable yarn even with the layered drawing. We rank by total
 * degree and keep the top N — the chrome footer says "N of M nodes".
 * 60 chosen empirically: a 1440px screen at default font size renders
 * ~10 columns × 6 layers comfortably. */
const SUGIYAMA_NODE_CAP = 60;

export function GraphRoute(handle: Handle<GraphProps>) {
  /* View-mode state in the closure. Hydrate from localStorage on mount
     so a user who picked "Diagram" yesterday lands back on Diagram. */
  let viewMode: GraphViewMode = readStoredMode();
  /* Diagram sub-state — only meaningful in Diagram mode but kept at
     route scope so flipping back to Diagram preserves the user's last
     choice. */
  let granularity: Granularity = 'files';
  let showAll = false;
  let zoomedOrPanned = false;
  
  /* Neo-DAG style mode: classic or neo */
  let styleMode: 'classic' | 'neo' = 'neo';
  if (typeof localStorage !== 'undefined') {
    const s = localStorage.getItem('factstack:graph-style-mode');
    if (s === 'classic' || s === 'neo') styleMode = s;
  }

  /* F5 secondary surface — color the diagram nodes by community
     (label-propagation cluster). Default OFF to preserve the editorial
     monochrome look; persisted like styleMode so a user who turns it on
     stays on across visits. */
  let colorByCommunity = false;
  if (typeof localStorage !== 'undefined') {
    colorByCommunity = localStorage.getItem('factstack:graph-color-by-community') === '1';
  }

  /* Imperative reset handle that the SugiyamaDag exposes to us via
     the resetSink prop. We call this from the DagControls Reset
     button. Set on first SugiyamaDag mount; survives across renders. */
  let dagReset: (() => void) | null = null;

  function setViewMode(next: GraphViewMode) {
    if (next === viewMode) return;
    viewMode = next;
    void handle.update();
  }
  function setGranularity(next: Granularity) {
    if (next === granularity) return;
    granularity = next;
    /* Granularity flip drops zoom/pan — different graph, different
       coordinate space. The SugiyamaDag does this internally on
       layout-change too, but flipping the local flag here syncs the
       Reset button's enabled state. */
    zoomedOrPanned = false;
    void handle.update();
  }
  function setStyleMode(next: 'classic' | 'neo') {
    if (next === styleMode) return;
    styleMode = next;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('factstack:graph-style-mode', next);
    }
    void handle.update();
  }
  function setColorByCommunity(next: boolean) {
    if (next === colorByCommunity) return;
    colorByCommunity = next;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('factstack:graph-color-by-community', next ? '1' : '0');
    }
    void handle.update();
  }
  function setShowAll(next: boolean) {
    if (next === showAll) return;
    showAll = next;
    zoomedOrPanned = false;
    void handle.update();
  }
  function setZoomedOrPanned(next: boolean) {
    if (next === zoomedOrPanned) return;
    zoomedOrPanned = next;
    void handle.update();
  }
  function captureResetApi(api: { reset: () => void; isIdentity: () => boolean }) {
    dagReset = api.reset;
  }
  function triggerReset() {
    dagReset?.();
  }

  return () => {
    const { data } = handle.props;
    const all = flattenFiles(data.tree);
    const inProject = new Set<string>(all.map((f) => f.path));
    const edges = (data.edges ?? []).filter((e) => inProject.has(e.from) && inProject.has(e.to));

    /* Coupling math at MODULE granularity (apps/ui-remix, packages/spec, …),
       shared by the Heatmap, Couplings table, Sankey, and the stats row. Not
       top-level (apps vs packages): on a monorepo that collapses everything
       into a 2-bucket matrix. `dropIsolated` removes doc/config dirs that have
       files but no imports, so every row/column is a real participant. */
    const heatmap = buildHeatmap(all, edges, moduleOf, { dropIsolated: true });

    /* Count of modules participating in the import graph (stats row + kicker). */
    const folderCount = heatmap.folders.length;

    /* Cycles + layers — needed by both Layers view AND the always-visible
       CyclesPanel. Computed once. */
    const adj = new Map<string, string[]>();
    for (const e of edges) {
      const arr = adj.get(e.from) ?? [];
      arr.push(e.to);
      adj.set(e.from, arr);
    }
    const nodes = Array.from(inProject);
    const sccs = tarjanSCC(nodes, adj);
    const cycles = findCycles(sccs, adj);

    /* Layer assignment is reused by both the Layers view AND the
       Sugiyama diagram. The diagram needs the full layout (ordering
       + edges); the Layers view needs the file groupings. */
    const repOf = new Map<string, string>();
    for (const c of sccs) {
      const rep = c[0]!;
      for (const n of c) repOf.set(n, rep);
    }
    const collapsedNodes = Array.from(new Set(repOf.values()));
    const collapsedAdj = new Map<string, string[]>();
    for (const [from, succ] of adj) {
      const cFrom = repOf.get(from)!;
      const arr = collapsedAdj.get(cFrom) ?? [];
      for (const to of succ) {
        const cTo = repOf.get(to)!;
        if (cTo !== cFrom) arr.push(cTo);
      }
      collapsedAdj.set(cFrom, arr);
    }
    const repLayer = layerByLongestPath(collapsedNodes, collapsedAdj);
    const layerOf = new Map<string, number>();
    for (const n of nodes) layerOf.set(n, repLayer.get(repOf.get(n)!) ?? 0);
    const maxLayer = Math.max(0, ...Array.from(layerOf.values()));
    const byPath = new Map<string, DatasetFile>(all.map((f) => [f.path, f]));
    const byLayer = new Map<number, DatasetFile[]>();
    for (const n of nodes) {
      const f = byPath.get(n);
      if (!f) continue;
      const L = layerOf.get(n) ?? 0;
      const arr = byLayer.get(L) ?? [];
      arr.push(f);
      byLayer.set(L, arr);
    }

    /* Symbol-edges feature gate. The analyzer's v0.4.4 work adds an
       `agent.symbolEdges` field carrying function/class-level
       dependencies. Until that lands, the Symbols mode renders an
       explanatory empty state — the toggle in DagControls is disabled
       until `symbolsAvailable` flips true. */
    const symbolsAvailable = Array.isArray(
      (data as { symbolEdges?: unknown[] }).symbolEdges,
    );

    /* F5 — path → community map for the optional node coloring overlay.
       Sourced from data.nodeMetrics (the same metrics the Modules tab
       consumes), keyed by path which IS the diagram's node id at file
       granularity. Only entries that carry a community are included;
       `communitiesAvailable` gates the DagControls toggle. Community is
       a visual encoding only — it never feeds buildSugiyamaLayout, which
       lays out purely from edges. */
    const communityOf = new Map<string, number>();
    for (const m of data.nodeMetrics ?? []) {
      if (m.community !== undefined) communityOf.set(m.path, m.community);
    }
    const communitiesAvailable = communityOf.size > 0;

    /* Sugiyama layout — only computed when the user is on the diagram
       view (the barycenter sweeps cost ~5ms on 250 nodes; not
       expensive enough to lazy-load but cheap enough to skip when
       not needed). Honors granularity (Files vs Symbols) and the
       Show-all toggle. */
    const sugiyamaLayout = (() => {
      if (viewMode !== 'diagram') return null;
      /* Symbol granularity gating: requires upstream artifact support.
         When unavailable, return an empty layout so the SugiyamaDag's
         empty state surfaces with a meaningful explanation. */
      if (granularity === 'symbols' && !symbolsAvailable) {
        return { nodes: new Map(), edges: [], layerCount: 0, maxLayerWidth: 0 };
      }

      /* Rank nodes by total degree (in + out across the FULL edge set,
         not the filtered set — a node should rank by its real
         centrality, not by what we already pruned). */
      const deg = new Map<string, number>();
      for (const n of nodes) deg.set(n, 0);
      for (const e of edges) {
        deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
        deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
      }
      const ranked = nodes.slice().sort((a, b) => (deg.get(b) ?? 0) - (deg.get(a) ?? 0));
      /* Show-all: lift the top-N cap. Reads as "render every node",
         which on a 250-file project is 250 nodes — dense but
         legible inside the zoom-and-pan UI. */
      const visibleIds = showAll ? ranked : ranked.slice(0, SUGIYAMA_NODE_CAP);
      const visible = new Set<string>(visibleIds);
      const visibleEdges = edges.filter((e) => visible.has(e.from) && visible.has(e.to));
      return buildSugiyamaLayout(visibleIds, visibleEdges);
    })();

    /* Sibling tables — always visible regardless of view mode. */
    const hubs = buildHubs(all, edges, 10);
    const couplings = buildCouplings(heatmap, 20);

    return (
      <ContentWithMargin>
        {/* `minWidth: 0` is the crucial bit: CSS grid `1fr` columns
            default to `minmax(auto, 1fr)`, so a wide child (like the
            Sugiyama SVG when "show all nodes" is on) would otherwise
            grow the column past the viewport and trigger horizontal
            scroll on <body>. The 0 floor lets the grid honor its
            fractional share, and the SugiyamaDag wrap's own
            `overflow: auto` then becomes the scroll surface. */}
        <div mix={css({ gridColumn: '1', minWidth: '0' })}>
          <div mix={kicker}>
            Graph · {fmt(folderCount)} {folderCount === 1 ? 'module' : 'modules'} · {fmt(maxLayer + 1)} layer{maxLayer === 0 ? '' : 's'}
          </div>
          <h1 mix={headline}>Where the dependency lives.</h1>
          <p mix={lede}>
            Three lenses on the same import graph. Heatmap shows where the weight
            is concentrated, diagram shows how the dependency flows, layers shows
            what runs at each depth. Cycles, heaviest couplings, and the central
            hubs surface below regardless of view.
          </p>

          <LabelNumberRow>
            <LabelNumber label="Modules" value={fmt(folderCount)} />
            <LabelNumber label="Files"   value={fmt(all.length)} />
            <LabelNumber label="Edges"   value={fmt(edges.length)} />
            <LabelNumber label="Layers"  value={fmt(maxLayer + 1)} />
            <LabelNumber label="Cycles"  value={cycles.length} hint={cycles.length === 0 ? 'clean DAG' : 'must resolve'} last />
          </LabelNumberRow>

          <div mix={toggleRow}>
            <ViewModeToggle value={viewMode} onChange={setViewMode} />
            <span mix={toggleHint}>
              {viewMode === 'heatmap' && 'Module × module coupling'}
              {viewMode === 'diagram' && `Top ${SUGIYAMA_NODE_CAP} by degree`}
              {viewMode === 'sankey'  && 'Module → module import flow'}
              {viewMode === 'layers'  && 'Files grouped by depth'}
            </span>
          </div>

          {/* The primary view changes with the toggle. */}
          {viewMode === 'heatmap' && (() => {
            const grid = capHeatmap(heatmap, HEATMAP_MODULE_CAP);
            const capped = grid.folders.length < heatmap.folders.length;
            const title = capped
              ? `top ${grid.folders.length} of ${heatmap.folders.length} modules · ${heatmap.crossEdges} cross-module imports`
              : `${heatmap.folders.length} modules · ${heatmap.crossEdges} cross-module imports`;
            return (
              <Section label="Heatmap" title={title}>
                <Heatmap data={grid} />
              </Section>
            );
          })()}

          {viewMode === 'diagram' && sugiyamaLayout && (
            <Section label="Diagram" title={`${sugiyamaLayout.layerCount} layers, ${sugiyamaLayout.nodes.size} nodes`}>
              <DagControls
                granularity={granularity}
                onGranularityChange={setGranularity}
                symbolsAvailable={symbolsAvailable}
                showAll={showAll}
                onShowAllChange={setShowAll}
                nodeCap={SUGIYAMA_NODE_CAP}
                totalNodes={nodes.length}
                zoomedOrPanned={zoomedOrPanned}
                onResetZoom={triggerReset}
                styleMode={styleMode}
                onStyleModeChange={setStyleMode}
                colorByCommunity={colorByCommunity}
                onColorByCommunityChange={setColorByCommunity}
                communitiesAvailable={communitiesAvailable}
              />
              {/* Export the *full* in-project edge set (not the capped
                  Sugiyama subset) — the Mermaid renderer applies its own
                  package-level aggregation + node cap, so it wants the raw
                  edges to summarize from. */}
              <div mix={css({ marginBottom: 'var(--space-3)' })}>
                <ExportMermaidButton edges={edges} />
              </div>
              <SugiyamaDag
                layout={sugiyamaLayout}
                totalNodeCount={nodes.length}
                resetSink={captureResetApi}
                onTransformChange={setZoomedOrPanned}
                styleMode={styleMode}
                communityOf={colorByCommunity && communitiesAvailable ? communityOf : undefined}
              />
            </Section>
          )}

          {viewMode === 'sankey' && (() => {
            /* Reuses the shared module-level `heatmap` (apps/ui-remix,
               packages/spec, …). moduleFlowSankey drops the diagonal + any
               module with no cross-module flow, so this is the import-coupling
               half of the same matrix the Heatmap draws. */
            const sankey = moduleFlowSankey(heatmap);
            const truncated = sankey.shownModules < sankey.totalModules;
            const title = sankey.totalCrossEdges === 0
              ? 'no cross-module imports'
              : truncated
                ? `top ${sankey.shownModules} of ${sankey.totalModules} modules · ${sankey.totalCrossEdges} cross-module imports`
                : `${sankey.shownModules} modules · ${sankey.totalCrossEdges} cross-module imports`;
            return (
              <Section label="Sankey" title={title}>
                <SankeyDiagram
                  nodes={sankey.nodes}
                  links={sankey.links}
                  formatValue={fmt}
                  height={Math.max(320, Math.min(900, Math.max(sankey.shownModules, 1) * 52))}
                  ariaLabel={`Module-to-module import flow across ${sankey.shownModules} modules`}
                />
              </Section>
            );
          })()}

          {viewMode === 'layers' && (
            <Section label="Layers" title="Files at each depth">
              <LayerSummary byLayer={byLayer} maxLayer={maxLayer} />
            </Section>
          )}

          {/* Always-visible: cycles (when present), couplings, hubs.
              These anchor every visualization with concrete file/folder
              names — the diagram is beautiful but not navigable on its
              own. */}
          <CyclesPanel cycles={cycles} />
          <CouplingsTable couplings={couplings} />
          <HubsTable hubs={hubs} />
        </div>

        <MarginColumn>
          <FootnoteChip label="Three views" tone="accent">
            Heatmap = "where's the weight?" · Diagram = "how does it flow?"
            · Layers = "what runs when?". Same graph, different questions.
          </FootnoteChip>
          <FootnoteChip label="Diagonal">
            Heatmap diagonal = self-coupling within a module. Tinted
            differently to read as "internal".
          </FootnoteChip>
          <FootnoteChip label="Layer 0">
            Diagram top row + Layers L0 = entry points, files no other
            in-project file imports.
          </FootnoteChip>
          <FootnoteChip label="Cycles" tone={cycles.length === 0 ? 'ok' : 'danger'}>
            {cycles.length === 0
              ? 'None detected. Pure DAG.'
              : `${cycles.length} dependency loop${cycles.length === 1 ? '' : 's'} — see panel below.`}
          </FootnoteChip>
          <FootnoteChip label="Algorithm">
            Tarjan SCC for cycles, Kahn topological + longest-path for layers,
            barycenter heuristic for in-layer order. O(V+E).
          </FootnoteChip>
        </MarginColumn>
      </ContentWithMargin>
    );
  };
}
