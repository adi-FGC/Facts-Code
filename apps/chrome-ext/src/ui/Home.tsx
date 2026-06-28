/**
 * Home — the panel's launcher. A condensed Overview (health + lede stats)
 * above a single-column nav list whose rows carry live signals, so you can
 * triage without drilling.
 */
import type { RemixNode } from 'remix/ui';
import { css, on } from 'remix/ui';
import type { Dataset } from '../lib/types.ts';
import { fmtNum, fmtBytes } from '../lib/format.ts';
import { heroHead, sectionLabel, statGrid, listRow, gradeTone } from './kit.tsx';

const badge = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-4)',
  textAlign: 'left',
  margin: 'var(--space-2) var(--space-4) var(--space-5)',
  width: 'calc(100% - var(--space-8))',
  padding: 'var(--space-4)',
  border: '1px solid var(--hairline)',
  borderLeft: '3px solid var(--accent)',
  borderRadius: 'var(--r-lg)',
  background: 'var(--surface-1)',
  cursor: 'pointer',
  transition: 'background var(--dur-instant)',
  '&:hover': { background: 'var(--surface-2)' },
});

const badgeGrade = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-32)',
  fontWeight: '600',
  lineHeight: '1',
  fontVariantNumeric: 'tabular-nums',
});

const badgeScore = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  color: 'var(--fg-muted)',
  fontVariantNumeric: 'tabular-nums',
});

const badgeHead = css({
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-12)',
  color: 'var(--fg-faint)',
  marginTop: '2px',
  lineHeight: '1.4',
});

export function renderHome(data: Dataset, nav: (p: string) => void): RemixNode {
  const h = data.summary?.health;
  const stats = data.stats ?? { files: 0, loc: 0, tokens: 0, size: 0, gzip: 0 };
  const risks = data.risks?.length ?? 0;
  const vulns = data.vulnerabilities?.length ?? 0;
  const nodeMetrics = data.nodeMetrics ?? [];
  const keyFiles = nodeMetrics.filter((n) => (n.importance ?? 0) > 0).length;
  const history = data.history ?? [];
  const docs = data.docs?.length ?? 0;
  const grade = h?.grade;
  const tone = gradeTone(grade);

  return (
    <>
      {heroHead(data.project?.name ?? 'project', data.summary?.oneLiner ?? 'Codebase overview')}

      <button type="button" mix={[badge, on('click', () => nav('/security'))]}>
        <span mix={[badgeGrade, css({ color: tone })]}>{grade ?? '·'}</span>
        <span>
          <span mix={badgeScore}>{h?.score != null ? `${h.score} / 100` : 'health'}</span>
          <span mix={badgeHead}>{h?.headline ?? 'No health summary in this dataset.'}</span>
        </span>
      </button>

      {statGrid([
        { label: 'Files', value: fmtNum(stats.files) },
        { label: 'Lines', value: fmtNum(stats.loc) },
        { label: 'Tokens', value: fmtNum(stats.tokens) },
        { label: 'Size', value: fmtBytes(stats.size) },
      ])}

      {sectionLabel('Explore')}
      {listRow({ name: 'Modules', value: fmtNum(keyFiles), sub: 'ranked by importance', onClick: () => nav('/modules') })}
      {listRow({ name: 'Files', value: fmtNum(stats.files), sub: fmtBytes(stats.size), onClick: () => nav('/files') })}
      {listRow({
        name: 'Security',
        value: String(risks + vulns),
        valueColor: risks + vulns > 0 ? 'var(--danger)' : 'var(--ok)',
        sub: `${risks} risk${risks === 1 ? '' : 's'} · ${vulns} vuln${vulns === 1 ? '' : 's'}`,
        onClick: () => nav('/security'),
      })}
      {listRow({ name: 'History', value: fmtNum(history.length), sub: 'snapshots', onClick: () => nav('/history') })}
      {docs > 0 && listRow({ name: 'Docs', value: fmtNum(docs), sub: 'documents', onClick: () => nav('/about') })}
      {listRow({ name: 'About this panel', sub: 'data source · privacy', onClick: () => nav('/about') })}
    </>
  );
}
