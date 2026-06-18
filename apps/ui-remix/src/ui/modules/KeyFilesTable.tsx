/**
 * KeyFilesTable — files ranked by graph importance (normalized PageRank). This
 * is "read these first", but weighted: a file imported by a few *important*
 * files outranks one imported by many trivial ones. Every row links to the file.
 */
import type { Handle } from 'remix/ui';
import { css } from 'remix/ui';
import type { KeyFile } from '../../lib/moduleAnalysis.ts';
import { Section } from '../Section.tsx';
import { RuledTable, RuledRow, RuledCell } from '../RuledColumn.tsx';
import { ImportanceBar } from './ImportanceBar.tsx';

interface KeyFilesTableProps {
  files: ReadonlyArray<KeyFile>;
}

const rankText = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg-subtle)',
  fontVariantNumeric: 'tabular-nums',
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

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

export function KeyFilesTable(handle: Handle<KeyFilesTableProps>) {
  return () => {
    const { files } = handle.props;
    if (files.length === 0) return null;
    return (
      <Section label="Importance" title="Key files by graph centrality">
        <RuledTable minWidth="38rem" cols="auto minmax(0, 1.5fr) minmax(0, 1.1fr) auto auto auto">
          <RuledRow header>
            <RuledCell header align="right">#</RuledCell>
            <RuledCell header>File</RuledCell>
            <RuledCell header>Folder</RuledCell>
            <RuledCell header align="right">In</RuledCell>
            <RuledCell header align="right">Tokens</RuledCell>
            <RuledCell header align="right">Importance</RuledCell>
          </RuledRow>
          {files.map((f, i) => (
            <RuledRow key={f.path}>
              <RuledCell align="right"><span mix={rankText}>{i + 1}</span></RuledCell>
              <RuledCell>
                <a href={`/files?p=${encodeURIComponent(f.path)}`} mix={fileLink}>{f.name}</a>
              </RuledCell>
              <RuledCell><span mix={dirText}>{f.dir || '·'}</span></RuledCell>
              <RuledCell mono align="right">{f.inDegree}</RuledCell>
              <RuledCell mono align="right">{fmtTokens(f.tokens)}</RuledCell>
              <RuledCell align="right"><ImportanceBar value={f.importance} /></RuledCell>
            </RuledRow>
          ))}
        </RuledTable>
      </Section>
    );
  };
}
