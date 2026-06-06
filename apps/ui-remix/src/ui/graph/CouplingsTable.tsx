/**
 * CouplingsTable — top-N cross-folder dependency edges, ranked.
 *
 * The "if I touch X, what else moves?" list. Sourced from the same
 * heatmap matrix the visualization uses, but linearized: every
 * off-diagonal cell becomes a row sorted by edge count.
 *
 * Diagonal cells (intra-folder coupling) are excluded — those don't
 * tell you anything about *cross-cutting* dependencies, which is
 * what this table is for.
 */
import type { Handle } from 'remix/ui';
import { css } from 'remix/ui';
import type { Coupling } from '../../lib/graphAnalysis.ts';
import { Section } from '../Section.tsx';
import { RuledTable, RuledRow, RuledCell } from '../RuledColumn.tsx';

interface CouplingsTableProps {
  couplings: ReadonlyArray<Coupling>;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 10_000) return (n / 1_000).toFixed(1) + 'K';
  if (n >= 1_000) return (n / 1_000).toFixed(2) + 'K';
  return n.toLocaleString('en-US');
}

const arrow = css({
  color: 'var(--fg-faint)',
});

export function CouplingsTable(handle: Handle<CouplingsTableProps>) {
  return () => {
    const { couplings } = handle.props;
    if (couplings.length === 0) return null;
    return (
      <Section label="Heaviest couplings" title="Cross-module edges, ranked">
        <RuledTable minWidth="28rem" cols="minmax(0, 1fr) 32px minmax(0, 1fr) auto">
          <RuledRow header>
            <RuledCell header>From</RuledCell>
            <RuledCell header>{' '}</RuledCell>
            <RuledCell header>To</RuledCell>
            <RuledCell header align="right">Edges</RuledCell>
          </RuledRow>
          {couplings.map((c, i) => (
            <RuledRow key={i}>
              <RuledCell mono>{c.from}</RuledCell>
              <RuledCell muted align="center"><span mix={arrow}>→</span></RuledCell>
              <RuledCell mono>{c.to}</RuledCell>
              <RuledCell mono align="right">{fmt(c.count)}</RuledCell>
            </RuledRow>
          ))}
        </RuledTable>
      </Section>
    );
  };
}
