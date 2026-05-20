/**
 * HubsTable — top-N files by in + out degree.
 *
 * High in-degree = lots of code depends on this file (refactor with
 * caution; rename safely). High out-degree = this file pulls in lots
 * of stuff (often a barrel re-export or an orchestrator).
 *
 * The "Total" column is the sum, sorted descending — gives a single
 * "centrality" score the reader can scan without doing the addition.
 */
import type { Handle } from '@remix-run/ui';
import { css } from '@remix-run/ui';
import type { HubEntry } from '../../lib/graphAnalysis.ts';
import { Section } from '../Section.tsx';
import { RuledTable, RuledRow, RuledCell } from '../RuledColumn.tsx';

interface HubsTableProps {
  hubs: ReadonlyArray<HubEntry>;
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

function splitDirAndName(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/');
  if (i < 0) return { dir: '', name: path };
  return { dir: path.slice(0, i), name: path.slice(i + 1) };
}

export function HubsTable(_h: Handle<HubsTableProps>) {
  return ({ hubs }: HubsTableProps) => {
    if (hubs.length === 0) return null;
    return (
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
    );
  };
}
