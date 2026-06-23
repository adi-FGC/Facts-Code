/**
 * Sankey layout — pure, deterministic flow-diagram geometry shared by every
 * Sankey surface in the app (Flow tier→tier, Architecture folder coupling,
 * Overview token economics, Vulnerabilities pkg→severity).
 *
 * Input is a column-assigned node set + weighted source→target links; output is
 * positioned node rects + cubic-bezier link ribbons, ready for a CSP-clean SVG
 * renderer (SankeyDiagram.tsx). No DOM, no clock, no randomness — same input
 * yields byte-identical geometry, so it is trivially unit-testable and the
 * diagrams stay stable across re-renders.
 *
 * Node "value" is the standard Sankey throughput: max(total inflow, total
 * outflow). Columns are caller-assigned (tiers have a natural order; bipartite
 * surfaces use 0 = source, 1 = target). A single vertical scale is shared
 * across columns so ribbon widths are comparable everywhere.
 */

export interface SankeyNodeInput {
  id: string;
  label: string;
  /** Column / layer index (0 = leftmost). */
  column: number;
  /** Optional fill colour (a CSS colour or var()); links inherit their source's. */
  color?: string;
}

export interface SankeyLinkInput {
  source: string;
  target: string;
  value: number;
  /** Optional ribbon colour. Overrides the source node's colour when set
   *  (lets a single source fan out into differently-tinted ribbons). */
  color?: string;
}

export interface SankeyOptions {
  width: number;
  height: number;
  /** Node rectangle width in px. Default 14. */
  nodeWidth?: number;
  /** Vertical gap between stacked nodes in a column, px. Default 14. */
  nodePadding?: number;
}

export interface SankeyNode {
  id: string;
  label: string;
  column: number;
  color?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  value: number;
}

export interface SankeyLink {
  source: string;
  target: string;
  value: number;
  /** Ribbon thickness in px (= value * scale). */
  width: number;
  /** Cubic-bezier path "d" between the source's right edge and the target's left edge. */
  path: string;
  /** Vertical centre of the ribbon at each end (for label/hit positioning). */
  sourceY: number;
  targetY: number;
  color?: string;
}

export interface SankeyLayout {
  nodes: SankeyNode[];
  links: SankeyLink[];
  width: number;
  height: number;
}

/** Stable code-unit comparator (locale-independent, deterministic). */
function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function computeSankey(
  nodeInputs: ReadonlyArray<SankeyNodeInput>,
  linkInputs: ReadonlyArray<SankeyLinkInput>,
  options: SankeyOptions,
): SankeyLayout {
  const width = options.width;
  const height = options.height;
  const nodeWidth = options.nodeWidth ?? 14;
  const nodePadding = options.nodePadding ?? 14;

  const links = linkInputs.filter((l) => l.value > 0 && l.source !== l.target);
  const nodeById = new Map<string, SankeyNodeInput>();
  for (const n of nodeInputs) nodeById.set(n.id, n);

  // Throughput per node = max(inflow, outflow).
  const inflow = new Map<string, number>();
  const outflow = new Map<string, number>();
  for (const l of links) {
    if (!nodeById.has(l.source) || !nodeById.has(l.target)) continue;
    outflow.set(l.source, (outflow.get(l.source) ?? 0) + l.value);
    inflow.set(l.target, (inflow.get(l.target) ?? 0) + l.value);
  }
  const valueOf = (id: string) => Math.max(inflow.get(id) ?? 0, outflow.get(id) ?? 0);

  // Keep only nodes that actually carry flow, preserving input order within a column.
  const live = nodeInputs.filter((n) => valueOf(n.id) > 0);
  if (live.length === 0) {
    return { nodes: [], links: [], width, height };
  }

  // Group live nodes by column (input order preserved → deterministic stacking).
  const columns = new Map<number, SankeyNodeInput[]>();
  for (const n of live) {
    const col = columns.get(n.column);
    if (col) col.push(n);
    else columns.set(n.column, [n]);
  }
  const colKeys = [...columns.keys()].sort((a, b) => a - b);
  const colIndex = new Map<number, number>();
  colKeys.forEach((k, i) => colIndex.set(k, i));
  const numCols = colKeys.length;

  // One shared value→px scale: the tightest column constraint wins so every
  // column fits within `height` (d3-sankey style).
  let scale = Infinity;
  for (const k of colKeys) {
    const ns = columns.get(k)!;
    const colVal = ns.reduce((s, n) => s + valueOf(n.id), 0);
    if (colVal <= 0) continue;
    const usable = Math.max(1, height - nodePadding * (ns.length - 1));
    scale = Math.min(scale, usable / colVal);
  }
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;

  const colX = (k: number) =>
    numCols <= 1 ? 0 : (colIndex.get(k)! * (width - nodeWidth)) / (numCols - 1);

  // Position nodes: stack within each column, centred vertically.
  const placed = new Map<string, SankeyNode>();
  for (const k of colKeys) {
    const ns = columns.get(k)!;
    const heights = ns.map((n) => Math.max(1, valueOf(n.id) * scale));
    const stackH = heights.reduce((s, h) => s + h, 0) + nodePadding * (ns.length - 1);
    let y = Math.max(0, (height - stackH) / 2);
    ns.forEach((n, i) => {
      const h = heights[i]!;
      placed.set(n.id, {
        id: n.id,
        label: n.label,
        column: n.column,
        ...(n.color !== undefined ? { color: n.color } : {}),
        x: colX(k),
        y,
        width: nodeWidth,
        height: h,
        value: valueOf(n.id),
      });
      y += h + nodePadding;
    });
  }

  // Order each node's links by the OTHER end's (column, id) so ribbons stack
  // in a stable, low-crossing order. Track running offsets per node edge.
  const linkSort = (a: SankeyLinkInput, b: SankeyLinkInput, key: 'target' | 'source') => {
    const na = placed.get(a[key])!;
    const nb = placed.get(b[key])!;
    return na.column - nb.column || na.y - nb.y || byId(a[key], b[key]);
  };
  const liveLinks = links.filter((l) => placed.has(l.source) && placed.has(l.target));
  const outByNode = new Map<string, SankeyLinkInput[]>();
  const inByNode = new Map<string, SankeyLinkInput[]>();
  for (const l of liveLinks) {
    (outByNode.get(l.source) ?? outByNode.set(l.source, []).get(l.source)!).push(l);
    (inByNode.get(l.target) ?? inByNode.set(l.target, []).get(l.target)!).push(l);
  }
  const srcOffset = new Map<string, number>();
  const tgtOffset = new Map<string, number>();
  for (const [id, ls] of outByNode) {
    ls.sort((a, b) => linkSort(a, b, 'target'));
    srcOffset.set(id, placed.get(id)!.y);
  }
  for (const [id, ls] of inByNode) {
    ls.sort((a, b) => linkSort(a, b, 'source'));
    tgtOffset.set(id, placed.get(id)!.y);
  }

  const outLayout: SankeyLink[] = [];
  for (const k of colKeys) {
    for (const n of columns.get(k)!) {
      for (const l of outByNode.get(n.id) ?? []) {
        const s = placed.get(l.source)!;
        const t = placed.get(l.target)!;
        const w = Math.max(0.75, l.value * scale);
        const sy0 = srcOffset.get(l.source)!;
        const ty0 = tgtOffset.get(l.target)!;
        srcOffset.set(l.source, sy0 + w);
        tgtOffset.set(l.target, ty0 + w);
        const x0 = s.x + s.width;
        const x1 = t.x;
        const sy = sy0 + w / 2;
        const ty = ty0 + w / 2;
        const cx = (x0 + x1) / 2;
        // A link's own colour wins over the source node's, so one source can
        // fan out into differently-tinted ribbons (e.g. artifact vs saved).
        const ribbonColor = l.color ?? s.color;
        outLayout.push({
          source: l.source,
          target: l.target,
          value: l.value,
          width: w,
          path: `M${x0},${sy} C${cx},${sy} ${cx},${ty} ${x1},${ty}`,
          sourceY: sy,
          targetY: ty,
          ...(ribbonColor !== undefined ? { color: ribbonColor } : {}),
        });
      }
    }
  }

  return { nodes: [...placed.values()], links: outLayout, width, height };
}
