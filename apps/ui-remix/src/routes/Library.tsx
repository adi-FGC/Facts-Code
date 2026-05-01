/**
 * Library — top-level package browser.
 *
 * Renders the project's first-level directory structure as a
 * hairline-ruled list with rollup stats: how many files, lines, and
 * tokens each package owns. Acts as the project's table of contents
 * before the v0.4.6 symbol-level browse ships.
 *
 * Symbol-level Library (Components / Hooks / Pages / Utilities / Server APIs)
 * is tracked in TASKS.md; this page populates the moment v0.3.5 symbol
 * graph + role classification land.
 */
import type { Handle } from '@remix-run/ui';
import { css } from '@remix-run/ui';
import type { Dataset, DatasetTreeNode } from '../lib/loadArtifacts.ts';
import { ContentWithMargin, MarginColumn } from '../ui/MarginColumn.tsx';
import { Section } from '../ui/Section.tsx';
import { LabelNumber, LabelNumberRow } from '../ui/LabelNumber.tsx';
import { RuledTable, RuledRow, RuledCell } from '../ui/RuledColumn.tsx';
import { FootnoteChip } from '../ui/FootnoteChip.tsx';

interface LibraryProps {
  data: Dataset;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

/** Shallow-walk: count files (recursive) per top-level child. */
function aggregate(node: DatasetTreeNode): { files: number; loc: number; tokens: number } {
  let files = node.files.length;
  let loc = node.files.reduce((s, f) => s + (f.loc || 0), 0);
  let tokens = node.files.reduce((s, f) => s + (f.tokens || 0), 0);
  for (const c of node.children) {
    const sub = aggregate(c);
    files += sub.files;
    loc += sub.loc;
    tokens += sub.tokens;
  }
  return { files, loc, tokens };
}

/** Heuristic: is this top-level dir likely an "app" / "package" / "doc"?
 *  Used to slot rows into editorial sections. The hint reads small
 *  beneath the row name. */
function classify(name: string): { kind: 'app' | 'package' | 'config' | 'docs' | 'tests' | 'other'; hint: string } {
  if (name === 'apps' || name === 'app')         return { kind: 'app', hint: 'application code' };
  if (name === 'packages' || name === 'libs')    return { kind: 'package', hint: 'shared libraries' };
  if (name === 'plugins')                        return { kind: 'package', hint: 'extension plugins' };
  if (name === 'examples' || name === 'example') return { kind: 'docs', hint: 'reference fixtures' };
  if (name === 'docs' || name === 'documentation') return { kind: 'docs', hint: 'documentation' };
  if (name === 'tests' || name === 'test' || name === 'spec' || name === '__tests__') return { kind: 'tests', hint: 'test suite' };
  if (name.startsWith('.'))                      return { kind: 'config', hint: 'config / metadata' };
  if (name === 'prototype' || name === 'legacy') return { kind: 'docs', hint: 'reference / legacy code' };
  if (name === 'scripts' || name === 'tools')    return { kind: 'config', hint: 'build / tooling' };
  return { kind: 'other', hint: 'project files' };
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

const nameStyle = css({
  fontFamily: 'var(--font-display)',
  fontSize: 'var(--fs-14)',
  fontWeight: '600',
  color: 'var(--fg)',
});

const hintStyle = css({
  display: 'block',
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-11)',
  fontWeight: '400',
  color: 'var(--fg-muted)',
  marginTop: '2px',
});

export function Library(_h: Handle<LibraryProps>) {
  return ({ data }: LibraryProps) => {
    const top = data.tree.children
      .map((c) => {
        const agg = aggregate(c);
        const cls = classify(c.name);
        return { name: c.name, ...cls, ...agg };
      })
      // Drop empty groups and sort by tokens desc (tokens correlates with
      // engineering surface better than file count or LOC).
      .filter((g) => g.files > 0)
      .sort((a, b) => b.tokens - a.tokens);

    const sectionOrder: Array<'app' | 'package' | 'config' | 'docs' | 'tests' | 'other'> = [
      'app', 'package', 'docs', 'tests', 'config', 'other',
    ];
    const sectionLabels: Record<string, string> = {
      app:     'Applications',
      package: 'Packages',
      docs:    'Documentation & references',
      tests:   'Tests',
      config:  'Config & tooling',
      other:   'Other',
    };
    const grouped = new Map<string, typeof top>();
    for (const t of top) {
      if (!grouped.has(t.kind)) grouped.set(t.kind, []);
      grouped.get(t.kind)!.push(t);
    }

    const totalTokens = top.reduce((s, g) => s + g.tokens, 0);
    const totalFiles  = top.reduce((s, g) => s + g.files, 0);
    const totalLoc    = top.reduce((s, g) => s + g.loc, 0);

    return (
      <ContentWithMargin>
        <div mix={css({ gridColumn: '1' })}>
          <div mix={kicker}>Library · {top.length} surfaces</div>
          <h1 mix={headline}>The project's table of contents.</h1>
          <p mix={lede}>
            Top-level directories grouped by role. Each row is one slice
            of the codebase you can read independently. The bigger the
            token figure, the bigger the surface area you'd ask an AI
            agent to load.
          </p>

          <LabelNumberRow>
            <LabelNumber label="Surfaces" value={top.length} />
            <LabelNumber label="Files"    value={fmt(totalFiles)} />
            <LabelNumber label="Lines"    value={fmt(totalLoc)} />
            <LabelNumber label="Tokens"   value={fmt(totalTokens)} unit="cl100k" last />
          </LabelNumberRow>

          {sectionOrder.map((k) => {
            const list = grouped.get(k);
            if (!list?.length) return null;
            return (
              <Section key={k} label={k} title={sectionLabels[k]}>
                <RuledTable cols="minmax(0, 1fr) auto auto auto">
                  <RuledRow header>
                    <RuledCell header>Name</RuledCell>
                    <RuledCell header align="right">Files</RuledCell>
                    <RuledCell header align="right">Lines</RuledCell>
                    <RuledCell header align="right">Tokens</RuledCell>
                  </RuledRow>
                  {list.map((g) => (
                    <RuledRow key={g.name}>
                      <RuledCell>
                        <span mix={nameStyle}>{g.name}</span>
                        <span mix={hintStyle}>{g.hint}</span>
                      </RuledCell>
                      <RuledCell mono align="right">{fmt(g.files)}</RuledCell>
                      <RuledCell mono align="right">{fmt(g.loc)}</RuledCell>
                      <RuledCell mono align="right">{fmt(g.tokens)}</RuledCell>
                    </RuledRow>
                  ))}
                </RuledTable>
              </Section>
            );
          })}
        </div>

        <MarginColumn>
          <FootnoteChip label="Coming with v0.4.6" tone="accent">
            Symbol-level browse: components, hooks, pages, utilities,
            server APIs, types — each row links to its outline + call
            sites.
          </FootnoteChip>
          <FootnoteChip label="Today" aside="package-level rollup only">
            Per-directory file count + LOC + token cost. Click a row in
            the file tree (left) for individual file metadata.
          </FootnoteChip>
        </MarginColumn>
      </ContentWithMargin>
    );
  };
}
