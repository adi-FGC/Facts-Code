/**
 * Files — every file in the project, ranked + reachable by deep link.
 *
 * Two modes, picked from `location.search`:
 *
 *   1. Default (`/files`) — the **index**. Two hairline tables side by
 *      side in vertical flow:
 *        - Heaviest by token (top 25)
 *        - Needs attention (broken / stale / has-todos, top 25)
 *      Each row links to `/files?p={path}` for the detail view.
 *
 *   2. Selected (`/files?p=src/foo.ts`) — the **detail**. Crumbs +
 *      headline + LabelNumberRow (LOC / Tokens / Bytes / TODOs) +
 *      sections for TODO entries (the only outline data we have
 *      pre-symbol-graph), Imports, and Imported by — both pulled
 *      from `data.edges`.
 *
 * Why URL-driven instead of closure state? The design spec calls for
 * deep-linkable selection ("share-friendly URLs") — and `App.tsx`
 * remounts every page on URL change, so a `factstack:nav` event +
 * `?p=` query gives us free routing without pushing a state machine
 * into the route component.
 */
import type { Handle } from 'remix/ui';
import { css, on } from 'remix/ui';
import type { Dataset, DatasetFile, DatasetTreeNode } from '../lib/loadArtifacts.ts';
import { ContentWithMargin, MarginColumn } from '../ui/MarginColumn.tsx';
import { Section } from '../ui/Section.tsx';
import { LabelNumber, LabelNumberRow } from '../ui/LabelNumber.tsx';
import { RuledTable, RuledRow, RuledCell } from '../ui/RuledColumn.tsx';
import { StatusChip } from '../ui/StatusChip.tsx';
import { FootnoteChip } from '../ui/FootnoteChip.tsx';
import { Treemap } from '../ui/Treemap.tsx';
import { moveRoving } from '../lib/roving.ts';

interface FilesProps {
  data: Dataset;
}

/* ──────────────────────────────────────────────────────────────────
 * Formatters — matched to Library/Routes for visual consistency.
 * fmt() uses grouping comma below 1K so the column doesn't jitter
 * between "270" and "62.3K". fmtBytes uses binary-prefix.
 * ────────────────────────────────────────────────────────────────── */
function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 10_000)    return (n / 1_000).toFixed(1) + 'K';
  if (n >= 1_000)     return (n / 1_000).toFixed(2) + 'K';
  return n.toLocaleString('en-US');
}
function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  if (n >= 1024)        return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

/** Walk the tree and collect every file with its full path. */
function flattenFiles(node: DatasetTreeNode): DatasetFile[] {
  const out: DatasetFile[] = [];
  (function walk(n: DatasetTreeNode) {
    for (const f of n.files) out.push(f);
    for (const c of n.children) walk(c);
  })(node);
  return out;
}

/** Read the `?p=...` query param from the current URL. */
function selectedPath(): string | null {
  if (typeof location === 'undefined') return null;
  const qs = new URLSearchParams(location.search);
  const p = qs.get('p');
  return p && p.length > 0 ? p : null;
}

/* ──────────────────────────────────────────────────────────────────
 * Editorial typography — same kicker/headline/lede triplet used on
 * every page so the system reads as one publication.
 * ────────────────────────────────────────────────────────────────── */
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

/* Lets long unbroken file names wrap inside the headline. Replaces the
   inline style="word-break:break-all" so the CSP can drop style-src
   'unsafe-inline'. */
const headlineBreak = css({
  wordBreak: 'break-all',
});

/* Mono crumbs for the detail view header. Matches Routes' breadcrumb
   pattern (path-as-trail) so a user moving between tabs reads the same
   visual grammar. */
const crumbs = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg-subtle)',
  marginBottom: 'var(--space-3)',
  letterSpacing: '0.04em',
  wordBreak: 'break-all',
});

const backLink = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
  marginBottom: 'var(--space-5)',
  '&:hover': { textDecoration: 'underline', textUnderlineOffset: '3px' },
});

/* The clickable file-name cell. We render an anchor inside a RuledCell
   so the document-level linkClick handler upgrades the navigation to
   pushState. Underline-on-hover only — keeps the table scan-clean. */
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

/* Outline / TODO rows when in the detail view. Three columns: line
   number (mono right-aligned), kind chip, the comment text. */
const todoRow = css({
  display: 'grid',
  gridTemplateColumns: '52px 64px 1fr',
  gap: 'var(--space-3)',
  alignItems: 'baseline',
  paddingBlock: 'var(--space-3)',
  paddingInline: 'var(--space-3)',
  marginInline: 'calc(var(--space-3) * -1)',
  borderBottom: '1px solid var(--hairline)',
});

const todoLine = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--fg-faint)',
  textAlign: 'right',
});

const todoKind = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  fontWeight: '500',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
});

const todoText = css({
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-13)',
  lineHeight: '1.5',
  color: 'var(--fg)',
});

const TODO_KIND_COLOR: Record<string, string> = {
  TODO:  'var(--info)',
  FIXME: 'var(--warn)',
  HACK:  'var(--warn)',
  XXX:   'var(--danger)',
  NOTE:  'var(--fg-muted)',
};

/* ──────────────────────────────────────────────────────────────────
 * Helpers for splitting a path into linkable segments + nice display
 * crumbs. We keep the slash separators visible because mono path
 * conventions read better that way.
 * ────────────────────────────────────────────────────────────────── */
function splitDirAndName(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/');
  if (i < 0) return { dir: '', name: path };
  return { dir: path.slice(0, i), name: path.slice(i + 1) };
}

/* ──────────────────────────────────────────────────────────────────
 * Index view mode — the tables (default) or the treemap "Map". Persisted
 * so a reload returns to the chosen lens. The Map answers "where is the
 * weight, and what is it made of?" in one glance: tile area = token cost,
 * tile colour = language.
 * ────────────────────────────────────────────────────────────────── */
type IndexMode = 'tables' | 'map';
const INDEX_MODES: ReadonlyArray<{ key: IndexMode; label: string }> = [
  { key: 'tables', label: 'Tables' },
  { key: 'map', label: 'Map' },
];
/** Tiles shown in the treemap — the heaviest files; the long tail of tiny
 *  files would be unreadable slivers and only adds SVG nodes. */
const MAP_CAP = 90;
const INDEX_VIEW_KEY = 'factstack:files-index-view';
function readIndexMode(): IndexMode {
  if (typeof localStorage === 'undefined') return 'tables';
  try {
    const v = localStorage.getItem(INDEX_VIEW_KEY);
    if (v === 'tables' || v === 'map') return v;
  } catch { /* swallow */ }
  return 'tables';
}
function writeIndexMode(v: IndexMode): void {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(INDEX_VIEW_KEY, v); } catch { /* swallow */ }
}

/* Segmented control — same grammar as the Flow / Graph view toggles. */
const modeToggle = css({
  display: 'inline-flex',
  alignItems: 'stretch',
  border: '1px solid var(--border)',
  height: '30px',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  marginBottom: 'var(--space-6)',
});
const modeSeg = css({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: '76px',
  paddingInline: 'var(--space-3)',
  background: 'transparent',
  border: 'none',
  borderRight: '1px solid var(--border)',
  color: 'var(--fg-muted)',
  cursor: 'pointer',
  font: 'inherit',
  letterSpacing: 'inherit',
  textTransform: 'inherit',
  transition: 'color var(--dur-quick) var(--ease-out-quart), background var(--dur-quick) var(--ease-out-quart)',
  '&:last-child': { borderRight: 'none' },
  '&:hover': { color: 'var(--accent)', background: 'var(--accent-soft)' },
  '&:focus-visible': { outline: '2px solid var(--accent)', outlineOffset: '-2px' },
});
const modeSegActive = css({ color: 'var(--fg)', background: 'var(--accent-soft)' });

/* Language legend under the map. Swatch colours come from the dataset's
   per-language palette, injected via css() (adopted stylesheets, CSP-clean). */
const legendRow = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--space-2) var(--space-4)',
  marginTop: 'var(--space-4)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  color: 'var(--fg-subtle)',
});
const legendItem = css({ display: 'inline-flex', alignItems: 'center', gap: '6px' });
const legendSwatch = css({ width: '10px', height: '10px', borderRadius: '2px', flex: '0 0 auto' });

export function Files(handle: Handle<FilesProps>) {
  let indexMode: IndexMode = readIndexMode();
  function setIndexMode(next: IndexMode) {
    if (next === indexMode) return;
    indexMode = next;
    writeIndexMode(next);
    void handle.update();
  }
  return () => {
    const { data } = handle.props;
    const all = flattenFiles(data.tree);
    const sel = selectedPath();

    /* ───────────── Detail view ───────────── */
    if (sel) {
      const file = all.find((f) => f.path === sel);
      if (!file) {
        return (
          <ContentWithMargin>
            <div mix={css({ gridColumn: '1', minWidth: '0' })}>
              <a href="/files" mix={backLink}>← All files</a>
              <div mix={kicker}>Files · not found</div>
              <h1 mix={headline}>That path isn't in the index.</h1>
              <p mix={lede}>
                <span mix={css({ fontFamily: 'var(--font-mono)', fontSize: '0.92em' })}>{sel}</span>{' '}
                wasn't found in the latest snapshot. The tree may have been
                re-walked since the link was shared. Pick another file from
                the index, or re-run <span mix={css({ fontFamily: 'var(--font-mono)' })}>factstack analyze</span>.
              </p>
            </div>
            <MarginColumn>
              <FootnoteChip label="Snapshot">
                {new Date(data.generatedAt).toISOString().slice(0, 19).replace('T', ' ')}
              </FootnoteChip>
            </MarginColumn>
          </ContentWithMargin>
        );
      }

      const { dir, name } = splitDirAndName(file.path);
      // Edges that originate from this file → its imports.
      const imports = (data.edges ?? []).filter((e) => e.from === file.path);
      // Edges that point at this file → who imports it.
      const importedBy = (data.edges ?? []).filter((e) => e.to === file.path);

      return (
        <ContentWithMargin>
          <div mix={css({ gridColumn: '1', minWidth: '0' })}>
            <a href="/files" mix={backLink}>← All files</a>
            <div mix={kicker}>Files · {file.language?.label ?? 'Unknown'}</div>
            {dir && <div mix={crumbs}>{dir}/</div>}
            <h1 mix={[headline, headlineBreak]}>{name}</h1>
            <p mix={lede}>
              {file.language?.label ?? 'Unknown'} · {fmt(file.loc)} lines ·{' '}
              {fmt(file.tokens)} tokens · last touched{' '}
              {new Date(file.mtime).toISOString().slice(0, 10)}.
            </p>

            <LabelNumberRow>
              <LabelNumber label="Lines"  value={fmt(file.loc)} />
              <LabelNumber label="Tokens" value={fmt(file.tokens)} unit="cl100k" />
              <LabelNumber label="Bytes"  value={fmtBytes(file.size)} />
              <LabelNumber label="TODOs"  value={file.todos} last />
            </LabelNumberRow>

            {/* TODOs are the only outline-shaped data we have until the
                symbol graph lands. They earn their column because they
                map directly to action: each line is a known imperfection
                you (or an agent) can address. */}
            {file.todoEntries.length > 0 && (
              <Section label="TODOs" title="Comments to revisit">
                {file.todoEntries.map((t, i) => (
                  <div key={i} mix={todoRow}>
                    <span mix={todoLine}>L{t.line}</span>
                    <span mix={[todoKind, css({ color: TODO_KIND_COLOR[t.kind.toUpperCase()] ?? 'var(--fg-muted)' })]}>
                      {t.kind}
                    </span>
                    <span mix={todoText}>{t.text}</span>
                  </div>
                ))}
              </Section>
            )}

            {imports.length > 0 && (
              <Section label="Imports" title={`${imports.length} ${imports.length === 1 ? 'file' : 'files'} this depends on`}>
                <RuledTable cols="80px minmax(0, 1fr)">
                  <RuledRow header>
                    <RuledCell header>Kind</RuledCell>
                    <RuledCell header>Path</RuledCell>
                  </RuledRow>
                  {imports.map((e, i) => (
                    <RuledRow key={i}>
                      <RuledCell mono muted>{e.kind === 'type-import' ? 'TYPE' : e.kind === 'dynamic-import' ? 'DYN' : 'IMP'}</RuledCell>
                      <RuledCell>
                        <a href={`/files?p=${encodeURIComponent(e.to)}`} mix={fileLink}>{e.to}</a>
                      </RuledCell>
                    </RuledRow>
                  ))}
                </RuledTable>
              </Section>
            )}

            {importedBy.length > 0 && (
              <Section label="Imported by" title={`${importedBy.length} ${importedBy.length === 1 ? 'file depends' : 'files depend'} on this`}>
                <RuledTable cols="80px minmax(0, 1fr)">
                  <RuledRow header>
                    <RuledCell header>Kind</RuledCell>
                    <RuledCell header>Path</RuledCell>
                  </RuledRow>
                  {importedBy.map((e, i) => (
                    <RuledRow key={i}>
                      <RuledCell mono muted>{e.kind === 'type-import' ? 'TYPE' : e.kind === 'dynamic-import' ? 'DYN' : 'IMP'}</RuledCell>
                      <RuledCell>
                        <a href={`/files?p=${encodeURIComponent(e.from)}`} mix={fileLink}>{e.from}</a>
                      </RuledCell>
                    </RuledRow>
                  ))}
                </RuledTable>
              </Section>
            )}

            {imports.length === 0 && importedBy.length === 0 && file.todoEntries.length === 0 && (
              <Section label="Quiet file" title="Nothing else to report">
                <p mix={css({ color: 'var(--fg-muted)', maxWidth: '60ch', lineHeight: '1.6' })}>
                  No tracked imports, no callers, no TODOs. Either a leaf
                  asset (CSS, config, fixture) or freshly-added code the
                  graph hasn't crawled yet.
                </p>
              </Section>
            )}
          </div>

          <MarginColumn>
            <FootnoteChip label="Status" tone={file.status === 'ok' ? 'ok' : file.status === 'broken' || file.status === 'read_error' ? 'danger' : 'warn'}>
              {file.status.toUpperCase()}
            </FootnoteChip>
            {/* v0.3.8 — reading-time chip when present. Skipped/empty
                files emit 0 minutes from the analyzer; we render only
                when there's something honest to say. */}
            {typeof file.readingMinutes === 'number' && file.readingMinutes > 0 && (
              <FootnoteChip label="Reading time" aside="estimate">
                ~{file.readingMinutes} min
              </FootnoteChip>
            )}
            {/* v0.3.8 — owners section. Renders a hairline-divided list
                of top-3 contributors with display name, days-since,
                commit count. Hidden entirely when the analyzer didn't
                receive git history. */}
            {file.topContributors && file.topContributors.length > 0 && (
              <FootnoteChip label="Owners" aside="last 90 days">
                <ul mix={css({ listStyle: 'none', margin: '0', padding: '0' })}>
                  {file.topContributors.map((c) => {
                    const days = Math.round((Date.now() - c.lastTouchedMs) / 86_400_000);
                    const display = c.name || c.email.split('@')[0] || 'unknown';
                    return (
                      <li
                        key={c.email}
                        mix={css({
                          paddingBlock: '4px',
                          fontFamily: 'var(--font-mono)',
                          fontSize: 'var(--fs-11)',
                          color: 'var(--fg-muted)',
                        })}
                      >
                        <span mix={css({ color: 'var(--fg)' })}>{display}</span>
                        <span mix={css({ color: 'var(--fg-faint)' })}>
                          {' · '}{c.commits} commit{c.commits === 1 ? '' : 's'}
                          {' · '}{days}d ago
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </FootnoteChip>
            )}
            <FootnoteChip label="Path" aside="copy-friendly">
              <span mix={css({ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-11)', wordBreak: 'break-all' })}>
                {file.path}
              </span>
            </FootnoteChip>
            <FootnoteChip label="Snapshot">
              {new Date(data.generatedAt).toISOString().slice(0, 19).replace('T', ' ')}
            </FootnoteChip>
          </MarginColumn>
        </ContentWithMargin>
      );
    }

    /* ───────────── Index view ───────────── */
    const heaviest = [...all].sort((a, b) => b.tokens - a.tokens).slice(0, 25);
    const attention = all
      .filter((f) => f.status !== 'ok' || f.todos > 0)
      .sort((a, b) => {
        // Sort: broken/parse_error/read_error first, then stale, then by todo count desc.
        const sevOf = (s: string) => s === 'broken' || s === 'parse_error' || s === 'read_error' ? 2 : s === 'stale' ? 1 : 0;
        const sevA = sevOf(a.status);
        const sevB = sevOf(b.status);
        if (sevA !== sevB) return sevB - sevA;
        return b.todos - a.todos;
      })
      .slice(0, 25);

    const totalTokens = all.reduce((s, f) => s + f.tokens, 0);
    const totalLoc    = all.reduce((s, f) => s + f.loc, 0);
    const brokenCount = all.filter((f) => f.status === 'broken' || f.status === 'parse_error' || f.status === 'read_error').length;

    /* Treemap tiles: the heaviest files by token cost, coloured by language. */
    const mapItems = [...all]
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, MAP_CAP)
      .map((f) => ({
        id: f.path,
        label: f.name,
        value: f.tokens,
        color: f.language?.iconColor ?? 'var(--fg-muted)',
      }));
    const legend = [...data.project.languages].sort((a, b) => b.tokens - a.tokens).slice(0, 8);

    return (
      <ContentWithMargin>
        <div mix={css({ gridColumn: '1', minWidth: '0' })}>
          <div mix={kicker}>Files · {fmt(all.length)} {all.length === 1 ? 'file' : 'files'}</div>
          <h1 mix={headline}>Every file, ranked by weight.</h1>
          <p mix={lede}>
            Token cost is the price of asking an AI agent to load a file.
            The heaviest first. Files needing attention follow — broken,
            stale, or carrying open TODOs.
          </p>

          <LabelNumberRow>
            <LabelNumber label="All files" value={fmt(all.length)} />
            <LabelNumber label="Lines"   value={fmt(totalLoc)} />
            <LabelNumber label="Tokens"  value={fmt(totalTokens)} unit="cl100k" />
            <LabelNumber label="At risk" value={brokenCount + attention.filter(a => a.status === 'stale').length} last />
          </LabelNumberRow>

          <div
            mix={[modeToggle, on<HTMLDivElement>('keydown', (e) => {
              if (moveRoving((e as unknown as KeyboardEvent).key, e.currentTarget, INDEX_MODES, indexMode, setIndexMode, 'tab')) e.preventDefault();
            })]}
            role="tablist"
            aria-label="Files index view"
          >
            {INDEX_MODES.map((m) => {
              const active = m.key === indexMode;
              return (
                <button
                  key={m.key}
                  type="button"
                  role="tab"
                  aria-selected={active ? 'true' : 'false'}
                  tabIndex={active ? 0 : -1}
                  title={m.key === 'map' ? 'Treemap — area = tokens, colour = language' : 'Ranked tables'}
                  mix={[modeSeg, active ? modeSegActive : null, on('click', () => setIndexMode(m.key))]}
                >
                  {m.label}
                </button>
              );
            })}
          </div>

          {indexMode === 'map' && (
            <Section label="Code map" title={`${mapItems.length} heaviest files · area = tokens, colour = language`}>
              <Treemap
                items={mapItems}
                height={480}
                formatValue={fmt}
                linkFor={(id) => `/files?p=${encodeURIComponent(id)}`}
                ariaLabel={`Treemap of the ${mapItems.length} heaviest files by token cost, coloured by language`}
              />
              {legend.length > 0 && (
                <div mix={legendRow}>
                  {legend.map((l) => (
                    <span key={l.id} mix={legendItem}>
                      <span mix={[legendSwatch, css({ background: l.iconColor })]} aria-hidden="true" />
                      {l.label} · {fmt(l.tokens)}
                    </span>
                  ))}
                </div>
              )}
            </Section>
          )}

          {indexMode === 'tables' && (
            <>
          <Section label="Heaviest" title="Top 25 by token cost">
            <RuledTable minWidth="38rem" cols="minmax(0, 2fr) minmax(0, 1.5fr) auto auto auto auto">
              <RuledRow header>
                <RuledCell header>Name</RuledCell>
                <RuledCell header>Folder</RuledCell>
                <RuledCell header align="right">Lines</RuledCell>
                <RuledCell header align="right">Tokens</RuledCell>
                <RuledCell header align="right">TODOs</RuledCell>
                <RuledCell header align="right">Status</RuledCell>
              </RuledRow>
              {heaviest.map((f) => {
                const { dir, name } = splitDirAndName(f.path);
                return (
                  <RuledRow key={f.path}>
                    <RuledCell>
                      <a href={`/files?p=${encodeURIComponent(f.path)}`} mix={fileLink}>{name}</a>
                    </RuledCell>
                    <RuledCell><span mix={dirText}>{dir || '·'}</span></RuledCell>
                    <RuledCell mono align="right">{fmt(f.loc)}</RuledCell>
                    <RuledCell mono align="right">{fmt(f.tokens)}</RuledCell>
                    <RuledCell mono align="right">{f.todos > 0 ? f.todos : '—'}</RuledCell>
                    <RuledCell align="right">
                      <StatusChip kind={f.status} />
                    </RuledCell>
                  </RuledRow>
                );
              })}
            </RuledTable>
          </Section>

          {attention.length > 0 && (
            <Section label="Needs attention" title={`${attention.length} ${attention.length === 1 ? 'file' : 'files'} flagged`}>
              <RuledTable minWidth="32rem" cols="minmax(0, 2fr) minmax(0, 1.5fr) auto auto auto">
                <RuledRow header>
                  <RuledCell header>Name</RuledCell>
                  <RuledCell header>Folder</RuledCell>
                  <RuledCell header align="right">TODOs</RuledCell>
                  <RuledCell header align="right">Tokens</RuledCell>
                  <RuledCell header align="right">Status</RuledCell>
                </RuledRow>
                {attention.map((f) => {
                  const { dir, name } = splitDirAndName(f.path);
                  return (
                    <RuledRow key={f.path}>
                      <RuledCell>
                        <a href={`/files?p=${encodeURIComponent(f.path)}`} mix={fileLink}>{name}</a>
                      </RuledCell>
                      <RuledCell><span mix={dirText}>{dir || '·'}</span></RuledCell>
                      <RuledCell mono align="right">{f.todos > 0 ? f.todos : '—'}</RuledCell>
                      <RuledCell mono align="right">{fmt(f.tokens)}</RuledCell>
                      <RuledCell align="right">
                        <StatusChip kind={f.status} />
                      </RuledCell>
                    </RuledRow>
                  );
                })}
              </RuledTable>
            </Section>
          )}
            </>
          )}
        </div>

        <MarginColumn>
          <FootnoteChip label="Click any row" tone="accent">
            Drills into the file's outline, imports, callers, and TODOs.
          </FootnoteChip>
          <FootnoteChip label="Counts">
            Every file in the tree — configs, docs, and assets included,
            not just source. That's why this runs higher than the Overview's
            source-file headline.
          </FootnoteChip>
          <FootnoteChip label="Sort">
            Heaviest first by default. Symbol-level outline lands with v0.4.6.
          </FootnoteChip>
          <FootnoteChip label="Snapshot">
            {new Date(data.generatedAt).toISOString().slice(0, 19).replace('T', ' ')}
          </FootnoteChip>
        </MarginColumn>
      </ContentWithMargin>
    );
  };
}
