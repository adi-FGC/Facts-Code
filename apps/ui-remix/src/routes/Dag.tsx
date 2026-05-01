/**
 * DAG — directed-acyclic dependency view.
 *
 * Computes two things from `data.edges` + the file index:
 *
 *   1. **Cycles** — strongly connected components with > 1 node, or
 *      a single-node SCC with a self-loop. Tarjan's algorithm runs
 *      in O(V + E) and returns them grouped. Each cycle is bad news
 *      (forces the whole loop into one undo-able rebuild unit), so
 *      we surface them at the top and warn loudly.
 *
 *   2. **Layers** — longest-path layering of the DAG (after cycle
 *      removal). Layer 0 = entry points (files with no in-project
 *      callers). Each subsequent layer depends on the previous.
 *      Reading the table top-down is reading the codebase from
 *      "loaded last" to "loaded first" — the natural dependency
 *      reading order.
 *
 * No SVG, no force-directed graph. The reader-friendly thing to ship
 * first is the *information*: where the cycles are, how deep the
 * project layers, which layer carries the most token weight. Pretty
 * pictures come in v0.4.4 with the symbol-graph.
 */
import type { Handle } from '@remix-run/ui';
import { css } from '@remix-run/ui';
import type { Dataset, DatasetFile, DatasetTreeNode } from '../lib/loadArtifacts.ts';
import { ContentWithMargin, MarginColumn } from '../ui/MarginColumn.tsx';
import { Section } from '../ui/Section.tsx';
import { LabelNumber, LabelNumberRow } from '../ui/LabelNumber.tsx';
import { RuledTable, RuledRow, RuledCell } from '../ui/RuledColumn.tsx';
import { FootnoteChip } from '../ui/FootnoteChip.tsx';

interface DagProps {
  data: Dataset;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 10_000)    return (n / 1_000).toFixed(1) + 'K';
  if (n >= 1_000)     return (n / 1_000).toFixed(2) + 'K';
  return n.toLocaleString('en-US');
}

function flattenFiles(node: DatasetTreeNode): DatasetFile[] {
  const out: DatasetFile[] = [];
  (function walk(n: DatasetTreeNode) {
    for (const f of n.files) out.push(f);
    for (const c of n.children) walk(c);
  })(node);
  return out;
}

function splitDirAndName(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/');
  if (i < 0) return { dir: '', name: path };
  return { dir: path.slice(0, i), name: path.slice(i + 1) };
}

/**
 * Tarjan's strongly-connected-components, iterative version. Returns
 * SCCs as arrays of node ids. Iterative because some monorepos have
 * dependency depths >10K which blow the call stack on the recursive
 * variant in V8.
 */
function tarjanSCC(nodes: string[], adj: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  type Frame = { node: string; iter: number };
  for (const start of nodes) {
    if (index.has(start)) continue;
    const work: Frame[] = [{ node: start, iter: 0 }];
    index.set(start, counter);
    lowlink.set(start, counter);
    counter++;
    stack.push(start);
    onStack.add(start);

    while (work.length > 0) {
      const top = work[work.length - 1]!;
      const succ = adj.get(top.node) ?? [];
      if (top.iter < succ.length) {
        const w = succ[top.iter]!;
        top.iter++;
        if (!index.has(w)) {
          index.set(w, counter);
          lowlink.set(w, counter);
          counter++;
          stack.push(w);
          onStack.add(w);
          work.push({ node: w, iter: 0 });
        } else if (onStack.has(w)) {
          lowlink.set(top.node, Math.min(lowlink.get(top.node)!, index.get(w)!));
        }
      } else {
        // All successors visited — finalize this node.
        if (lowlink.get(top.node) === index.get(top.node)) {
          const comp: string[] = [];
          while (true) {
            const w = stack.pop()!;
            onStack.delete(w);
            comp.push(w);
            if (w === top.node) break;
          }
          sccs.push(comp);
        }
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1]!;
          lowlink.set(parent.node, Math.min(lowlink.get(parent.node)!, lowlink.get(top.node)!));
        }
      }
    }
  }
  return sccs;
}

/**
 * Longest-path layering: layer(v) = 1 + max(layer(u)) over all u → v.
 * Source nodes (no incoming edges) are layer 0. Cycles must be removed
 * first; we collapse each SCC to a representative node before layering.
 */
function layerByLongestPath(nodes: string[], adj: Map<string, string[]>): Map<string, number> {
  const indeg = new Map<string, number>(nodes.map((n) => [n, 0]));
  for (const [, succ] of adj) for (const w of succ) indeg.set(w, (indeg.get(w) ?? 0) + 1);

  // Kahn's topological order.
  const queue: string[] = [];
  for (const n of nodes) if ((indeg.get(n) ?? 0) === 0) queue.push(n);
  const order: string[] = [];
  const local = new Map<string, number>(indeg);
  while (queue.length > 0) {
    const v = queue.shift()!;
    order.push(v);
    for (const w of adj.get(v) ?? []) {
      const d = (local.get(w) ?? 0) - 1;
      local.set(w, d);
      if (d === 0) queue.push(w);
    }
  }

  // If order didn't include every node, the graph still has cycles
  // (caller should have collapsed SCCs). Skip leftovers.
  const layer = new Map<string, number>();
  for (const v of order) {
    let max = -1;
    for (const u of nodes) {
      // We need predecessors → walk all edges. Cheap enough for small
      // codebases; for huge ones, a reverse-adjacency map would help.
      const succ = adj.get(u) ?? [];
      if (succ.includes(v)) {
        const lu = layer.get(u);
        if (lu != null && lu > max) max = lu;
      }
    }
    layer.set(v, max + 1);
  }
  return layer;
}

const kicker = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
  marginBottom: 'var(--space-5)',
});

const headline = css({
  fontFamily: 'var(--font-display)',
  fontSize: 'var(--fs-display-sm)',
  fontWeight: '600',
  letterSpacing: '-0.025em',
  lineHeight: '1.04',
  color: 'var(--fg)',
  marginBottom: 'var(--space-6)',
  fontVariationSettings: '"opsz" 64',
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
  marginBottom: 'var(--space-12)',
});

const fileLink = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  color: 'var(--fg)',
  '&:hover': { color: 'var(--accent)', textDecoration: 'underline', textUnderlineOffset: '3px' },
});

const dirText = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg-subtle)',
});

const cycleHeader = css({
  display: 'flex',
  alignItems: 'baseline',
  gap: 'var(--space-3)',
  paddingBlock: 'var(--space-3)',
  borderBottom: '1px solid var(--hairline)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--danger)',
});

const cycleList = css({
  listStyle: 'none',
  margin: '0',
  padding: '0',
  paddingLeft: 'var(--space-4)',
  borderLeft: '2px solid var(--danger)',
  marginTop: 'var(--space-3)',
  marginBottom: 'var(--space-5)',
});

const cycleItem = css({
  paddingBlock: '4px',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
});

export function Dag(_h: Handle<DagProps>) {
  return ({ data }: DagProps) => {
    const all = flattenFiles(data.tree);
    const byPath = new Map<string, DatasetFile>(all.map((f) => [f.path, f]));
    const edges = data.edges ?? [];

    /* Build adjacency restricted to in-project files (drop edges
       pointing at node_modules-like targets — they bloat layers
       without adding signal). */
    const inProject = new Set<string>(all.map((f) => f.path));
    const adj = new Map<string, string[]>();
    for (const e of edges) {
      if (!inProject.has(e.from) || !inProject.has(e.to)) continue;
      const arr = adj.get(e.from) ?? [];
      arr.push(e.to);
      adj.set(e.from, arr);
    }

    const nodes = Array.from(inProject);
    const sccs = tarjanSCC(nodes, adj);
    const cycles = sccs.filter((c) => {
      if (c.length > 1) return true;
      const v = c[0]!;
      const succ = adj.get(v) ?? [];
      return succ.includes(v);
    });

    /* For layering, collapse each cycle to its representative node so
       the longest-path computation is well-defined. */
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

    /* Project the rep-layer back onto every original node. */
    const layerOf = new Map<string, number>();
    for (const n of nodes) layerOf.set(n, repLayer.get(repOf.get(n)!) ?? 0);

    const maxLayer = Math.max(0, ...Array.from(layerOf.values()));
    const totalEdges = edges.filter((e) => inProject.has(e.from) && inProject.has(e.to)).length;

    /* Group files by layer for the table. */
    const byLayer = new Map<number, DatasetFile[]>();
    for (const n of nodes) {
      const f = byPath.get(n);
      if (!f) continue;
      const L = layerOf.get(n) ?? 0;
      const arr = byLayer.get(L) ?? [];
      arr.push(f);
      byLayer.set(L, arr);
    }

    return (
      <ContentWithMargin>
        <div mix={css({ gridColumn: '1' })}>
          <div mix={kicker}>DAG · {fmt(nodes.length)} nodes</div>
          <h1 mix={headline}>How the codebase layers.</h1>
          <p mix={lede}>
            Files grouped by longest-path depth from entry points. Layer 0
            is loaded first; the highest layer is loaded last. Cycles
            break the layering — they're called out at the top.
          </p>

          <LabelNumberRow>
            <LabelNumber label="Nodes"  value={fmt(nodes.length)} />
            <LabelNumber label="Edges"  value={fmt(totalEdges)} />
            <LabelNumber label="Layers" value={fmt(maxLayer + 1)} />
            <LabelNumber label="Cycles" value={cycles.length} hint={cycles.length === 0 ? 'clean DAG' : 'must resolve'} last />
          </LabelNumberRow>

          {cycles.length > 0 && (
            <Section label="Cycles" title={`${cycles.length} dependency loop${cycles.length === 1 ? '' : 's'}`}>
              <p mix={css({ color: 'var(--fg-muted)', maxWidth: '60ch', marginBottom: 'var(--space-5)', lineHeight: '1.6' })}>
                Each cycle below means the listed files mutually import each
                other. Loops force the whole group to rebuild together and
                make the layer a fiction. Break the weakest link first.
              </p>
              {cycles.map((c, i) => (
                <div key={i}>
                  <div mix={cycleHeader}>
                    Cycle {i + 1} · {c.length} {c.length === 1 ? 'node (self-loop)' : 'nodes'}
                  </div>
                  <ul mix={cycleList}>
                    {c.map((p) => (
                      <li key={p} mix={cycleItem}>
                        <a href={`/files?p=${encodeURIComponent(p)}`} mix={fileLink}>{p}</a>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </Section>
          )}

          <Section label="Layers" title="Files at each depth">
            <RuledTable cols="60px auto auto auto minmax(0, 1fr)">
              <RuledRow header>
                <RuledCell header align="right">Layer</RuledCell>
                <RuledCell header align="right">Files</RuledCell>
                <RuledCell header align="right">Lines</RuledCell>
                <RuledCell header align="right">Tokens</RuledCell>
                <RuledCell header>Sample</RuledCell>
              </RuledRow>
              {Array.from({ length: maxLayer + 1 }, (_, L) => {
                const files = byLayer.get(L) ?? [];
                const loc = files.reduce((s, f) => s + f.loc, 0);
                const tokens = files.reduce((s, f) => s + f.tokens, 0);
                /* Three sample names sorted by token weight — gives the
                   reader a foothold without dumping the whole layer. */
                const sample = files
                  .slice()
                  .sort((a, b) => b.tokens - a.tokens)
                  .slice(0, 3);
                return (
                  <RuledRow key={L}>
                    <RuledCell mono align="right">L{L}</RuledCell>
                    <RuledCell mono align="right">{fmt(files.length)}</RuledCell>
                    <RuledCell mono align="right">{fmt(loc)}</RuledCell>
                    <RuledCell mono align="right">{fmt(tokens)}</RuledCell>
                    <RuledCell>
                      {sample.map((f, i) => {
                        const { name, dir } = splitDirAndName(f.path);
                        return (
                          <span key={f.path}>
                            <a href={`/files?p=${encodeURIComponent(f.path)}`} mix={fileLink}>{name}</a>
                            {dir && <span mix={dirText}> · {dir}</span>}
                            {i < sample.length - 1 && <span mix={css({ color: 'var(--fg-faint)', marginInline: '6px' })}>·</span>}
                          </span>
                        );
                      })}
                      {files.length > 3 && (
                        <span mix={css({ color: 'var(--fg-faint)', marginLeft: '6px', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-11)' })}>
                          + {files.length - 3} more
                        </span>
                      )}
                    </RuledCell>
                  </RuledRow>
                );
              })}
            </RuledTable>
          </Section>
        </div>

        <MarginColumn>
          <FootnoteChip label="Layer 0" tone="accent">
            Files no other in-project file imports. Usually entry points,
            CLI bins, top-level routes.
          </FootnoteChip>
          <FootnoteChip label="Highest layer">
            Loaded last in dependency order. The leaves of the import
            tree — utilities, types, schemas.
          </FootnoteChip>
          <FootnoteChip label="Cycles" tone={cycles.length === 0 ? 'ok' : 'danger'}>
            {cycles.length === 0
              ? 'None detected. Pure DAG.'
              : `${cycles.length} dependency loop${cycles.length === 1 ? '' : 's'} — see top of page.`}
          </FootnoteChip>
          <FootnoteChip label="Algorithm">
            Tarjan's SCC for cycles, Kahn's topological order + longest-path layering. O(V+E).
          </FootnoteChip>
        </MarginColumn>
      </ContentWithMargin>
    );
  };
}
