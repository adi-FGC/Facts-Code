/**
 * Graph — module-level dependency view, rendered as a heatmap.
 *
 * Why not a force-directed dot-and-line graph? Because:
 *
 *   1. Force layouts on >100 nodes look like exploded yarn — pretty
 *      enough to ship, useless for understanding.
 *   2. A pure-JS force simulation in a React-free runtime is ~300 LOC
 *      of physics that nobody reads.
 *   3. The actual question the reader asks the graph is "where is the
 *      coupling concentrated?" — and an adjacency matrix answers that
 *      in a single eyeful.
 *
 * So we render three editorial blocks:
 *
 *   - **Heatmap** — folder × folder adjacency matrix. Each cell shows
 *     the count of edges (imports) from row→col. Color intensity is
 *     log-scaled so 1 edge ≠ 100 edges. Diagonal cells (intra-folder
 *     coupling) are tinted differently.
 *   - **Heaviest couplings** — top 20 cross-folder dependencies, the
 *     "if I touch X, what else moves?" list.
 *   - **Hubs** — top 10 files by in+out degree, the central nodes
 *     (almost always the things to refactor first).
 *
 * Symbol-level + clickable node-detail lands with v0.4.4 (force layout
 * comes only when the symbol graph makes it actually informative).
 */
import type { Handle } from '@remix-run/ui';
import { css } from '@remix-run/ui';
import type { Dataset, DatasetFile, DatasetTreeNode } from '../lib/loadArtifacts.ts';
import { ContentWithMargin, MarginColumn } from '../ui/MarginColumn.tsx';
import { Section } from '../ui/Section.tsx';
import { LabelNumber, LabelNumberRow } from '../ui/LabelNumber.tsx';
import { RuledTable, RuledRow, RuledCell } from '../ui/RuledColumn.tsx';
import { FootnoteChip } from '../ui/FootnoteChip.tsx';

interface GraphProps {
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

/** Get the top-level directory ("apps", "packages", "src") for a path. */
function topLevel(path: string): string {
  const i = path.indexOf('/');
  if (i < 0) return '·';
  return path.slice(0, i);
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

/* The matrix is a CSS grid: header row + col, then a square of cells.
   Column labels are rotated -45° so long folder names don't break the
   header. Border-collapse is faked via 1px hairlines between cells. */
const matrixWrap = css({
  marginTop: 'var(--space-4)',
  overflowX: 'auto',
  paddingBottom: 'var(--space-5)',
});

const matrix = css({
  display: 'grid',
  gridAutoColumns: 'minmax(44px, 1fr)',
  borderTop: '1px solid var(--hairline)',
  borderLeft: '1px solid var(--hairline)',
});

const colLabel = css({
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'center',
  paddingTop: 'var(--space-4)',
  paddingBottom: 'var(--space-2)',
  borderRight: '1px solid var(--hairline)',
  borderBottom: '1px solid var(--hairline)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  color: 'var(--fg-subtle)',
  letterSpacing: '0.04em',
  height: '88px',
  '> span': {
    transformOrigin: 'left bottom',
    transform: 'rotate(-45deg) translateY(-6px)',
    whiteSpace: 'nowrap',
  },
});

const rowLabel = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  paddingInline: 'var(--space-3)',
  borderRight: '1px solid var(--hairline)',
  borderBottom: '1px solid var(--hairline)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg)',
  letterSpacing: '0.04em',
  whiteSpace: 'nowrap',
});

const cell = css({
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRight: '1px solid var(--hairline)',
  borderBottom: '1px solid var(--hairline)',
  height: '36px',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  fontVariantNumeric: 'tabular-nums',
});

/* Diagonal cells (folder→same folder) get a subtle different tint to
   read as "self-coupling" without dominating the visual. */
const cellSelf = css({
  background: 'color-mix(in oklab, var(--fg-faint) 8%, transparent)',
});

const corner = css({
  borderRight: '1px solid var(--hairline)',
  borderBottom: '1px solid var(--hairline)',
  height: '88px',
});

const dirText = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg-subtle)',
});

const legendRow = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-4)',
  marginTop: 'var(--space-3)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
});

const legendSwatch = css({
  display: 'inline-block',
  width: '20px',
  height: '8px',
  marginRight: '6px',
  verticalAlign: 'middle',
});

function splitDirAndName(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/');
  if (i < 0) return { dir: '', name: path };
  return { dir: path.slice(0, i), name: path.slice(i + 1) };
}

export function GraphRoute(_h: Handle<GraphProps>) {
  return ({ data }: GraphProps) => {
    const all = flattenFiles(data.tree);
    const inProject = new Set<string>(all.map((f) => f.path));
    const edges = (data.edges ?? []).filter((e) => inProject.has(e.from) && inProject.has(e.to));

    /* Folder set: top-level dir of every in-project file. Sorted by
       appearance count desc so the heatmap reads "biggest folders
       upper-left", which matches matrix-reading conventions. */
    const folderCount = new Map<string, number>();
    for (const f of all) {
      const k = topLevel(f.path);
      folderCount.set(k, (folderCount.get(k) ?? 0) + 1);
    }
    const folders = Array.from(folderCount.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k);
    const folderIdx = new Map<string, number>(folders.map((f, i) => [f, i]));

    /* Build the count matrix. matrix[from][to] = number of edges. */
    const matrixData: number[][] = folders.map(() => folders.map(() => 0));
    for (const e of edges) {
      const i = folderIdx.get(topLevel(e.from));
      const j = folderIdx.get(topLevel(e.to));
      if (i == null || j == null) continue;
      matrixData[i]![j]!++;
    }

    /* Log-scale color intensity. Find max; render every cell as a
       background-color mix of accent at intensity ratio. We avoid pure
       linear scaling because one runaway edge count flattens everything
       else into invisibility. */
    let maxCell = 0;
    for (let i = 0; i < folders.length; i++)
      for (let j = 0; j < folders.length; j++)
        if (matrixData[i]![j]! > maxCell) maxCell = matrixData[i]![j]!;
    const logMax = Math.log10(maxCell + 1) || 1;

    function intensity(n: number): number {
      if (n === 0) return 0;
      return Math.log10(n + 1) / logMax;
    }

    /* Heaviest couplings: cross-folder pairs (i ≠ j) sorted by count. */
    const couplings: Array<{ from: string; to: string; count: number }> = [];
    for (let i = 0; i < folders.length; i++) {
      for (let j = 0; j < folders.length; j++) {
        if (i === j) continue;
        const c = matrixData[i]![j]!;
        if (c > 0) couplings.push({ from: folders[i]!, to: folders[j]!, count: c });
      }
    }
    couplings.sort((a, b) => b.count - a.count);
    const topCouplings = couplings.slice(0, 20);

    /* Hubs: file-level in+out degree. */
    const inDeg = new Map<string, number>();
    const outDeg = new Map<string, number>();
    for (const e of edges) {
      outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
      inDeg.set(e.to,    (inDeg.get(e.to)    ?? 0) + 1);
    }
    const hubs = Array.from(inProject)
      .map((p) => ({
        path: p,
        in: inDeg.get(p) ?? 0,
        out: outDeg.get(p) ?? 0,
        total: (inDeg.get(p) ?? 0) + (outDeg.get(p) ?? 0),
      }))
      .filter((h) => h.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);

    /* Cross-folder edge count = edges where i ≠ j. The diagonal sum
       is intra-folder coupling. */
    let crossEdges = 0;
    for (let i = 0; i < folders.length; i++)
      for (let j = 0; j < folders.length; j++)
        if (i !== j) crossEdges += matrixData[i]![j]!;

    return (
      <ContentWithMargin>
        <div mix={css({ gridColumn: '1' })}>
          <div mix={kicker}>Graph · {fmt(folders.length)} {folders.length === 1 ? 'module' : 'modules'}</div>
          <h1 mix={headline}>Where the coupling lives.</h1>
          <p mix={lede}>
            Module × module dependency heatmap. Each cell counts edges
            from row → column. The diagonal is internal coupling; the
            off-diagonal cells are where modules reach across.
          </p>

          <LabelNumberRow>
            <LabelNumber label="Modules" value={fmt(folders.length)} />
            <LabelNumber label="Files"   value={fmt(all.length)} />
            <LabelNumber label="Edges"   value={fmt(edges.length)} />
            <LabelNumber label="Cross"   value={fmt(crossEdges)} hint="module to module" last />
          </LabelNumberRow>

          <Section label="Heatmap" title={`${folders.length} modules, ${edges.length} edges`}>
            <div mix={matrixWrap}>
              <div
                mix={[matrix, css({ gridTemplateColumns: `160px repeat(${folders.length}, minmax(44px, 1fr))` })]}
              >
                {/* Top-left corner */}
                <div mix={corner} />
                {/* Column headers */}
                {folders.map((f) => (
                  <div key={`col-${f}`} mix={colLabel}><span>{f}</span></div>
                ))}
                {/* Each row */}
                {folders.map((rowName, i) => (
                  <>
                    <div key={`row-${rowName}`} mix={rowLabel}>{rowName}</div>
                    {folders.map((_, j) => {
                      const v = matrixData[i]![j]!;
                      const t = intensity(v);
                      return (
                        <div
                          key={`c-${i}-${j}`}
                          mix={[
                            cell,
                            i === j ? cellSelf : css({}),
                            css({
                              background: v === 0
                                ? 'transparent'
                                : `color-mix(in oklab, var(--accent) ${Math.round(t * 60)}%, transparent)`,
                              color: t > 0.55 ? 'var(--bg)' : 'var(--fg)',
                            }),
                          ]}
                          title={`${rowName} → ${folders[j]}: ${v} edge${v === 1 ? '' : 's'}`}
                        >
                          {v > 0 ? v : ''}
                        </div>
                      );
                    })}
                  </>
                ))}
              </div>
              <div mix={legendRow}>
                <span>
                  <span mix={[legendSwatch, css({ background: 'color-mix(in oklab, var(--accent) 12%, transparent)' })]} /> Few
                </span>
                <span>
                  <span mix={[legendSwatch, css({ background: 'color-mix(in oklab, var(--accent) 36%, transparent)' })]} /> Some
                </span>
                <span>
                  <span mix={[legendSwatch, css({ background: 'color-mix(in oklab, var(--accent) 60%, transparent)' })]} /> Many
                </span>
                <span style="margin-left:auto">log scale · max {fmt(maxCell)} edges</span>
              </div>
            </div>
          </Section>

          {topCouplings.length > 0 && (
            <Section label="Heaviest couplings" title="Cross-module edges, ranked">
              <RuledTable cols="minmax(0, 1fr) 32px minmax(0, 1fr) auto">
                <RuledRow header>
                  <RuledCell header>From</RuledCell>
                  <RuledCell header>{' '}</RuledCell>
                  <RuledCell header>To</RuledCell>
                  <RuledCell header align="right">Edges</RuledCell>
                </RuledRow>
                {topCouplings.map((c, i) => (
                  <RuledRow key={i}>
                    <RuledCell mono>{c.from}</RuledCell>
                    <RuledCell muted align="center">→</RuledCell>
                    <RuledCell mono>{c.to}</RuledCell>
                    <RuledCell mono align="right">{fmt(c.count)}</RuledCell>
                  </RuledRow>
                ))}
              </RuledTable>
            </Section>
          )}

          {hubs.length > 0 && (
            <Section label="Hubs" title="Top files by in + out degree">
              <RuledTable cols="minmax(0, 1.6fr) minmax(0, 1.4fr) auto auto auto">
                <RuledRow header>
                  <RuledCell header>File</RuledCell>
                  <RuledCell header>Folder</RuledCell>
                  <RuledCell header align="right">In</RuledCell>
                  <RuledCell header align="right">Out</RuledCell>
                  <RuledCell header align="right">Total</RuledCell>
                </RuledRow>
                {hubs.map((h) => {
                  const { dir, name } = splitDirAndName(h.path);
                  return (
                    <RuledRow key={h.path}>
                      <RuledCell>
                        <a href={`/files?p=${encodeURIComponent(h.path)}`} mix={fileLink}>{name}</a>
                      </RuledCell>
                      <RuledCell><span mix={dirText}>{dir || '·'}</span></RuledCell>
                      <RuledCell mono align="right">{h.in}</RuledCell>
                      <RuledCell mono align="right">{h.out}</RuledCell>
                      <RuledCell mono align="right">{h.total}</RuledCell>
                    </RuledRow>
                  );
                })}
              </RuledTable>
            </Section>
          )}
        </div>

        <MarginColumn>
          <FootnoteChip label="Why a heatmap" tone="accent">
            A force-directed graph on &gt;100 nodes is yarn. A matrix
            answers "where's the coupling?" in one glance.
          </FootnoteChip>
          <FootnoteChip label="Diagonal">
            Self-coupling — files within the same module importing each
            other. Tinted differently to read as "internal".
          </FootnoteChip>
          <FootnoteChip label="Hubs">
            High in-degree = lots of code depends on this file. Refactor
            with caution; rename safely.
          </FootnoteChip>
          <FootnoteChip label="Coming with v0.4.4">
            Symbol-level graph + click-to-focus on any cell or hub.
          </FootnoteChip>
        </MarginColumn>
      </ContentWithMargin>
    );
  };
}
