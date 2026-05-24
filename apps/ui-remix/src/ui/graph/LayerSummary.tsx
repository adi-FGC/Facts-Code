/**
 * LayerSummary — files-per-layer rollup table.
 *
 * One row per Sugiyama layer. Columns: layer index, file count, total
 * lines, total tokens, and 3 sample file names (the highest-token
 * files in the layer — gives the reader a foothold without dumping
 * the whole layer).
 *
 * Layer 0 = entry points (no in-project predecessors). The highest
 * layer = leaves (loaded last in dependency order — utilities,
 * types, schemas).
 *
 * Component contract:
 *   Pure render of a pre-grouped Map<layer, files[]>. Computing the
 *   layer assignment lives in lib/graphAnalysis; this view focuses
 *   on presentation.
 */
import type { Handle } from 'remix/ui';
import { css } from 'remix/ui';
import type { DatasetFile } from '../../lib/loadArtifacts.ts';
import { RuledTable, RuledRow, RuledCell } from '../RuledColumn.tsx';

interface LayerSummaryProps {
  byLayer: ReadonlyMap<number, readonly DatasetFile[]>;
  maxLayer: number;
}

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

const sep = css({
  color: 'var(--fg-faint)',
  marginInline: '6px',
});

const moreText = css({
  color: 'var(--fg-faint)',
  marginLeft: '6px',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
});

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 10_000) return (n / 1_000).toFixed(1) + 'K';
  if (n >= 1_000) return (n / 1_000).toFixed(2) + 'K';
  return n.toLocaleString('en-US');
}

function splitDirAndName(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/');
  if (i < 0) return { dir: '', name: path };
  return { dir: path.slice(0, i), name: path.slice(i + 1) };
}

export function LayerSummary(_h: Handle<LayerSummaryProps>) {
  return ({ byLayer, maxLayer }: LayerSummaryProps) => (
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
        /* Three sample names sorted by token weight — gives the reader
           a foothold without dumping the whole layer. */
        const sample = files.slice().sort((a, b) => b.tokens - a.tokens).slice(0, 3);
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
                    {i < sample.length - 1 && <span mix={sep}>·</span>}
                  </span>
                );
              })}
              {files.length > 3 && (
                <span mix={moreText}>+ {files.length - 3} more</span>
              )}
            </RuledCell>
          </RuledRow>
        );
      })}
    </RuledTable>
  );
}
