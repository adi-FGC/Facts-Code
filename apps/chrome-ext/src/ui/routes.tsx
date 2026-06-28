/**
 * List-first route views. Each renders straight from VizArtifact fields as
 * ranked rows with inline proportional bars — legible at 320px, no diagram
 * libs, agent- and CXO-readable. (Glance/immersive diagram tiers are Phase 2.)
 */
import type { RemixNode } from 'remix/ui';
import type { VizFile, VizTreeNode } from '@factstack/emit/pure';
import type { Dataset } from '../lib/types.ts';
import { fmtNum, fmtBytes, basename, truncateMiddle } from '../lib/format.ts';
import { head, sectionLabel, block, para, listRow, statGrid, emptyNote, sevTone } from './kit.tsx';

const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;
function sevRank(s: string): number {
  const i = SEV_ORDER.indexOf(s.toLowerCase() as (typeof SEV_ORDER)[number]);
  return i < 0 ? SEV_ORDER.length : i;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : '·';
}

function flattenFiles(node: VizTreeNode, out: VizFile[] = []): VizFile[] {
  for (const f of node.files) out.push(f);
  for (const c of node.children) flattenFiles(c, out);
  return out;
}

/* ─────────── Modules (key files by importance) ─────────── */

export function renderModules(data: Dataset): RemixNode {
  const metrics = (data.nodeMetrics ?? []).filter((n) => (n.importance ?? 0) > 0);
  metrics.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
  const top = metrics.slice(0, 40);
  const max = top[0]?.importance ?? 1;
  const communities = new Set(metrics.map((n) => n.community).filter((c) => c !== undefined));

  return (
    <>
      {head(
        'Modules',
        `${fmtNum(metrics.length)} files ranked by importance (PageRank over the import graph)${
          communities.size ? ` · ${communities.size} communities` : ''
        }.`,
      )}
      {top.length === 0
        ? emptyNote('No graph metrics in this dataset.')
        : top.map((n) =>
            listRow({
              key: n.path,
              name: basename(n.path),
              title: n.path,
              value: String(Math.round(((n.importance ?? 0) / max) * 100)),
              sub: dirOf(n.path),
              fraction: (n.importance ?? 0) / max,
            }),
          )}
    </>
  );
}

/* ─────────── Security (risks + vulnerabilities) ─────────── */

export function renderSecurity(data: Dataset): RemixNode {
  const risks = [...(data.risks ?? [])].sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
  const vulns = [...(data.vulnerabilities ?? [])].sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
  const crit = [...risks, ...vulns].filter((x) => x.severity.toLowerCase() === 'critical').length;
  const high = [...risks, ...vulns].filter((x) => x.severity.toLowerCase() === 'high').length;

  return (
    <>
      {head('Security', 'Risks from the analyzer plus known CVEs cross-referenced against OSV.')}
      {statGrid([
        { label: 'Risks', value: fmtNum(risks.length) },
        { label: 'Vulns', value: fmtNum(vulns.length) },
        { label: 'Critical', value: fmtNum(crit), tone: crit ? 'var(--danger)' : undefined },
        { label: 'High', value: fmtNum(high), tone: high ? 'var(--danger)' : undefined },
      ])}

      {sectionLabel('Risks', fmtNum(risks.length))}
      {risks.length === 0
        ? emptyNote('No risks flagged. Clean.')
        : risks.slice(0, 60).map((r, i) =>
            listRow({
              key: `risk-${i}`,
              name: r.rule || r.category,
              value: r.severity,
              valueColor: sevTone(r.severity),
              sub: r.file ? `${truncateMiddle(r.file, 34)}${r.line ? ':' + r.line : ''}` : r.message,
              title: r.message,
            }),
          )}

      {sectionLabel('Vulnerabilities', fmtNum(vulns.length))}
      {vulns.length === 0
        ? emptyNote('No known CVEs at the scanned versions.')
        : vulns.slice(0, 60).map((v, i) =>
            listRow({
              key: `vuln-${i}`,
              name: `${v.package}`,
              value: v.severity,
              valueColor: sevTone(v.severity),
              sub: `${v.id}${v.summary ? ' — ' + v.summary : ''}`,
              title: v.summary ?? v.id,
            }),
          )}
    </>
  );
}

/* ─────────── Files (heaviest by token cost) ─────────── */

export function renderFiles(data: Dataset): RemixNode {
  const files = flattenFiles(data.tree);
  files.sort((a, b) => b.tokens - a.tokens);
  const top = files.slice(0, 50);
  const max = top[0]?.tokens ?? 1;

  return (
    <>
      {head('Files', `${fmtNum(files.length)} files · ${fmtBytes(data.stats?.size ?? 0)}. Heaviest by token cost.`)}
      {top.length === 0
        ? emptyNote('No files in this dataset.')
        : top.map((f) =>
            listRow({
              key: f.path,
              name: basename(f.path),
              title: f.path,
              value: `${fmtNum(f.tokens)} tok`,
              sub: `${dirOf(f.path)} · ${fmtNum(f.loc)} loc · ${fmtBytes(f.size)}`,
              fraction: f.tokens / max,
              barColor: f.status === 'broken' ? 'var(--danger)' : 'var(--accent)',
            }),
          )}
    </>
  );
}

/* ─────────── History (snapshots) ─────────── */

export function renderHistory(data: Dataset): RemixNode {
  const snaps = [...(data.history ?? [])].reverse(); // newest first
  return (
    <>
      {head('History', `${fmtNum(snaps.length)} snapshot${snaps.length === 1 ? '' : 's'} of this project over time.`)}
      {snaps.length === 0
        ? emptyNote('No history yet — snapshots accrue as the project is re-analyzed over time.')
        : snaps.map((s, i) =>
            listRow({
              key: `${s.at}-${i}`,
              name: s.at.slice(0, 10),
              value: `${fmtNum(s.loc)} loc`,
              sub: `${fmtNum(s.tokens)} tok · ${fmtNum(s.risks)} risks · ${fmtNum(s.todos)} todos`,
              title: s.at,
              ...(i === 0 ? { valueColor: 'var(--accent)' } : {}),
            }),
          )}
    </>
  );
}

/* ─────────── About ─────────── */

export function renderAbout(data: Dataset, sourceLabel: string): RemixNode {
  return (
    <>
      {head('FactStack panel', 'A narrow, client-side companion for understanding any codebase.')}
      {block(
        <>
          {para(
            <>
              This panel analyzes the GitHub repo open in your active tab — or a local folder — entirely in your
              browser, reusing the same <code>@factstack/core</code> analyzer as the FactStack CLI and dashboard.
            </>,
          )}
          {para(
            <>
              <strong>Privacy:</strong> local-folder analysis is network-free; nothing leaves your machine. GitHub
              analysis fetches the repo through the GitHub API into memory and analyzes it locally — only the repo
              contents you already have access to are read.
            </>,
          )}
        </>,
      )}
      {sectionLabel('Loaded')}
      {listRow({ name: 'Source', value: sourceLabel })}
      {listRow({ name: 'Project', value: data.project?.name ?? '—' })}
      {listRow({ name: 'Generated', value: (data.generatedAt ?? '').slice(0, 16).replace('T', ' ') || '—' })}
    </>
  );
}
