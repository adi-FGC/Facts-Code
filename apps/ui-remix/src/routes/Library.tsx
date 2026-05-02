/**
 * Library — top-level package browser.
 *
 * Renders the project's first-level directory structure as a single
 * hairline-ruled table sorted by token weight. Each row carries a
 * mono kind tag (APP / PKG / DOCS / TESTS / CFG / OTHER) so the
 * grouping reads at a glance without needing a Section header per
 * category — for projects where most categories have only 1-2 rows,
 * the section ceremony was overhead, not signal.
 *
 * The flat table reads top-down: biggest token surface first. That
 * answers "what would I have to load into agent context?" before
 * anything else.
 *
 * Symbol-level Library (Components / Hooks / Pages / Utilities /
 * Server APIs) is tracked in TASKS.md; that page populates the
 * moment v0.3.5 symbol graph + role classification land.
 */
import type { Handle } from '@remix-run/ui';
import { css, on } from '@remix-run/ui';
import type { Dataset, DatasetTreeNode } from '../lib/loadArtifacts.ts';
import { ContentWithMargin, MarginColumn } from '../ui/MarginColumn.tsx';
import { Section } from '../ui/Section.tsx';
import { LabelNumber, LabelNumberRow } from '../ui/LabelNumber.tsx';
import { RuledTable, RuledRow, RuledCell } from '../ui/RuledColumn.tsx';
import { FootnoteChip } from '../ui/FootnoteChip.tsx';

interface LibraryProps {
  data: Dataset;
}

/* Audit M2 fix: K-suffix transitions at 1000 (1 → 1.0K), but for
   table columns where both 270 and 62300 appear, the visual jitter
   between "270" and "62.3K" breaks the column rhythm. We render
   below-1K values with a grouping comma instead of bare digits so
   every cell at least uses the same numeric grammar — and use
   tabular-nums (already on RuledCell mono) to keep the columns true. */
function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 10_000)    return (n / 1_000).toFixed(1) + 'K';
  if (n >= 1_000)     return (n / 1_000).toFixed(2) + 'K';
  return n.toLocaleString('en-US');
}

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

type Kind = 'app' | 'pkg' | 'docs' | 'tests' | 'cfg' | 'other';

function classify(name: string): { kind: Kind; hint: string } {
  if (name === 'apps' || name === 'app')         return { kind: 'app',   hint: 'application code' };
  if (name === 'packages' || name === 'libs')    return { kind: 'pkg',   hint: 'shared libraries' };
  if (name === 'plugins')                        return { kind: 'pkg',   hint: 'extension plugins' };
  if (name === 'examples' || name === 'example') return { kind: 'docs',  hint: 'reference fixtures' };
  if (name === 'docs' || name === 'documentation') return { kind: 'docs', hint: 'documentation' };
  if (name === 'tests' || name === 'test' || name === 'spec' || name === '__tests__') return { kind: 'tests', hint: 'test suite' };
  if (name.startsWith('.'))                      return { kind: 'cfg',   hint: 'config / metadata' };
  if (name === 'prototype' || name === 'legacy') return { kind: 'docs',  hint: 'reference / legacy code' };
  if (name === 'scripts' || name === 'tools')    return { kind: 'cfg',   hint: 'build / tooling' };
  return { kind: 'other', hint: 'project files' };
}

const KIND_COLOR: Record<Kind, string> = {
  app:   'var(--accent)',
  pkg:   'var(--info)',
  docs:  'var(--fg-muted)',
  tests: 'var(--ok)',
  cfg:   'var(--fg-subtle)',
  other: 'var(--fg-faint)',
};

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

const kindTag = (kind: Kind) => css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  fontWeight: '500',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: KIND_COLOR[kind],
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

/* v0.3.11 H2: sort toggle for the Library table.
   - WEIGHT: tokens desc (current default; what AI cost-aware
     readers want)
   - KIND:   semantic grouping (apps → packages → tests → docs →
     cfg → other), then by name; what humans want when reading
     top-down
   - NAME:   pure alphabetical; what someone looking for a specific
     name wants
   The toggle uses the same segmented-control language as ThemeToggle
   so the UI grammar carries. */
type SortMode = 'weight' | 'kind' | 'name';

const KIND_ORDER: Record<Kind, number> = {
  app: 0, pkg: 1, tests: 2, docs: 3, cfg: 4, other: 5,
};

const sortBar = css({
  display: 'inline-flex',
  alignItems: 'stretch',
  border: '1px solid var(--border)',
  height: '28px',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  marginLeft: 'auto',
});

const sortSeg = css({
  display: 'inline-flex',
  alignItems: 'center',
  paddingInline: '12px',
  background: 'transparent',
  border: 'none',
  borderRight: '1px solid var(--border)',
  color: 'var(--fg-muted)',
  cursor: 'pointer',
  font: 'inherit',
  letterSpacing: 'inherit',
  textTransform: 'inherit',
  '&:last-child': { borderRight: 'none' },
  transition: 'color var(--dur-quick) var(--ease-out-quart), background var(--dur-quick) var(--ease-out-quart)',
});

const sortSegActive = css({
  color: 'var(--accent)',
  background: 'var(--accent-soft)',
});

const sortRow = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-3)',
  marginBottom: 'var(--space-3)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
});

const SORT_LABELS: Array<{ key: SortMode; label: string }> = [
  { key: 'weight', label: 'Weight' },
  { key: 'kind',   label: 'Kind' },
  { key: 'name',   label: 'Name' },
];

export function Library(handle: Handle<LibraryProps>) {
  let sortMode: SortMode = 'weight';
  function setSort(mode: SortMode) {
    if (mode === sortMode) return;
    sortMode = mode;
    void handle.update();
  }

  return ({ data }: LibraryProps) => {
    const rows = data.tree.children
      .map((c) => {
        const agg = aggregate(c);
        const cls = classify(c.name);
        return { name: c.name, ...cls, ...agg };
      })
      .filter((g) => g.files > 0);

    /* Apply the active sort. Each comparator is total + stable so
       the table doesn't shuffle between renders. */
    const top = rows.slice();
    if (sortMode === 'weight') {
      top.sort((a, b) => b.tokens - a.tokens);
    } else if (sortMode === 'name') {
      top.sort((a, b) => a.name.localeCompare(b.name));
    } else {
      top.sort((a, b) => {
        const k = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
        return k !== 0 ? k : a.name.localeCompare(b.name);
      });
    }

    const totalTokens = top.reduce((s, g) => s + g.tokens, 0);
    const totalFiles  = top.reduce((s, g) => s + g.files, 0);
    const totalLoc    = top.reduce((s, g) => s + g.loc, 0);

    return (
      <ContentWithMargin>
        <div mix={css({ gridColumn: '1' })}>
          <div mix={kicker}>
            Library · {top.length} {top.length === 1 ? 'package' : 'packages'}
          </div>
          <h1 mix={headline}>The project's table of contents.</h1>
          <p mix={lede}>
            Top-level packages — sortable by weight (token cost),
            kind (apps → packages → tests → docs), or name. The mono
            tag at the start of each row marks role at a glance.
          </p>

          <LabelNumberRow>
            <LabelNumber label="Packages" value={top.length} />
            <LabelNumber label="Files"    value={fmt(totalFiles)} />
            <LabelNumber label="Lines"    value={fmt(totalLoc)} />
            <LabelNumber label="Tokens"   value={fmt(totalTokens)} unit="cl100k" last />
          </LabelNumberRow>

          {/* v0.3.11 H2: sort-mode segmented control. Lives outside
              Section so the right-aligned bar can flex against a left
              "Sort by" label without disturbing Section's heading. */}
          <div mix={sortRow}>
            <span>Sort by</span>
            <div mix={sortBar} role="radiogroup" aria-label="Sort packages by">
              {SORT_LABELS.map((s) => {
                const active = s.key === sortMode;
                return (
                  <button
                    key={s.key}
                    type="button"
                    role="radio"
                    aria-checked={active ? 'true' : 'false'}
                    mix={[
                      sortSeg,
                      active ? sortSegActive : null,
                      on('click', () => setSort(s.key)),
                    ]}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* One flat table; the sort-toggle above picks the order.
              Default WEIGHT (tokens desc) is the AI-cost lens; KIND
              groups semantically; NAME is alphabetical. */}
          <Section label="Packages" title="What it's made of">
            {/* Audit follow-up: 56px → 88px for the KIND column. At
                fs-10 with 0.14em letter-spacing, "DOCS" / "OTHER" + the
                "KIND" header itself need ~85px just for glyphs + padding.
                The previous narrower column truncated to "DO..." / "KI...". */}
            <RuledTable cols="88px minmax(0, 1fr) auto auto auto">
              <RuledRow header>
                <RuledCell header>Kind</RuledCell>
                <RuledCell header>Name</RuledCell>
                <RuledCell header align="right">Files</RuledCell>
                <RuledCell header align="right">Lines</RuledCell>
                <RuledCell header align="right">Tokens</RuledCell>
              </RuledRow>
              {top.map((g) => (
                <RuledRow key={g.name}>
                  <RuledCell>
                    <span mix={kindTag(g.kind)}>{g.kind}</span>
                  </RuledCell>
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
