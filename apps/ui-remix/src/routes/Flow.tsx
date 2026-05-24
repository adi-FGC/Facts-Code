/**
 * Flow — architectural data flow + entity relationships.
 *
 * Three lenses on the same flow analysis:
 *
 *   1. Swimlanes  → horizontal-lane SVG diagram. One lane per tier
 *      (Entry → UI → Route → Handler → Data → External → Lib …),
 *      with file counts inside and aggregated edge arrows between.
 *   2. Entities   → table of data-tier files (schemas/models) with
 *      referrer counts. The ER-diagram surface; symbol-level edges
 *      arrive with v0.4.4.
 *   3. Text       → swimlanes.io-style plain-text breakdown with a
 *      copy-to-clipboard button. Diff-able, paste-able, accessible.
 *
 * The tier-classification heuristic and edge aggregation live in
 * lib/flowAnalysis.ts. This route is a thin orchestrator.
 *
 * Why this tab exists:
 *   Graph answers "where's the dependency weight?" — structural.
 *   Flow answers "what does the app DO with data?" — behavioral.
 *   Different question, different lens. The data is the same (files
 *   + edges from the existing artifact) but the framing is different:
 *   instead of asking "which file is central?" we ask "which tier
 *   talks to which tier, and how often?"
 */
import type { Handle } from 'remix/ui';
import { css, on } from 'remix/ui';
import type { Dataset, DatasetFile, DatasetTreeNode } from '../lib/loadArtifacts.ts';
import {
  analyzeFlow,
  TIER_DESCRIPTION,
  TIER_LABEL,
  TIER_ORDER,
  type Tier,
} from '../lib/flowAnalysis.ts';
import { ContentWithMargin, MarginColumn } from '../ui/MarginColumn.tsx';
import { Section } from '../ui/Section.tsx';
import { LabelNumber, LabelNumberRow } from '../ui/LabelNumber.tsx';
import { FootnoteChip } from '../ui/FootnoteChip.tsx';
import { SwimlanesDiagram } from '../ui/flow/SwimlanesDiagram.tsx';
import { EntityList } from '../ui/flow/EntityList.tsx';
import { FlowText } from '../ui/flow/FlowText.tsx';
import { SequenceDiagram } from '../ui/flow/SequenceDiagram.tsx';
import { buildSequenceFlow, pickDefaultEntryPoint } from '../lib/sequenceFlow.ts';

interface FlowProps {
  data: Dataset;
}

/* ─────────── flow-view-mode (own localStorage key) ─────────── */

type FlowViewMode = 'swimlanes' | 'sequence' | 'entities' | 'text';

const VIEW_STORAGE_KEY = 'factstack:flow-view-mode';
const SEQ_ENTRY_STORAGE_KEY = 'factstack:flow-seq-entry';

function readStoredMode(): FlowViewMode {
  if (typeof localStorage === 'undefined') return 'swimlanes';
  try {
    const v = localStorage.getItem(VIEW_STORAGE_KEY);
    if (v === 'swimlanes' || v === 'sequence' || v === 'entities' || v === 'text') return v;
  } catch { /* swallow */ }
  return 'swimlanes';
}
function writeStoredMode(value: FlowViewMode): void {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(VIEW_STORAGE_KEY, value); } catch { /* swallow */ }
}

function readStoredSeqEntry(): string | null {
  if (typeof localStorage === 'undefined') return null;
  try { return localStorage.getItem(SEQ_ENTRY_STORAGE_KEY); } catch { return null; }
}
function writeStoredSeqEntry(value: string): void {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(SEQ_ENTRY_STORAGE_KEY, value); } catch { /* swallow */ }
}

/* ─────────── styles ─────────── */

const kicker = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
  marginBottom: 'var(--space-5)',
});

const headline = css({
  /* Matches the Overview + Graph headlines — sans display, tight tracking. */
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-display-sm)',
  fontWeight: '600',
  letterSpacing: '-0.03em',
  lineHeight: '1.08',
  color: 'var(--fg)',
  marginBottom: 'var(--space-6)',
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
  marginBottom: 'var(--space-8)',
});

const toggleRow = css({
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 'var(--space-3)',
  marginTop: 'var(--space-6)',
  marginBottom: 'var(--space-4)',
  paddingBottom: 'var(--space-3)',
  borderBottom: '1px solid var(--hairline)',
});

const toggleHint = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
});

/* Entry picker for the Sequence view. A bare `<select>` styled
 * editorially — no fancy combobox, just the native control with
 * mono + accent tokens. The select lists every route handler + the
 * top-degree non-route files so users can sequence "from anywhere
 * useful". */
const entryPickerRow = css({
  display: 'flex',
  alignItems: 'baseline',
  gap: 'var(--space-3)',
  marginBottom: 'var(--space-3)',
  paddingBlock: 'var(--space-2)',
});

const entryPickerLabel = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
});

const entryPickerSelect = css({
  flex: '1',
  background: 'var(--bg)',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  paddingInline: 'var(--space-2)',
  paddingBlock: '4px',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  outline: 'none',
  cursor: 'pointer',
  '&:hover': { borderColor: 'var(--accent)' },
  '&:focus-visible': { borderColor: 'var(--accent)', outline: '2px solid var(--accent)', outlineOffset: '-1px' },
});

/* Local segmented toggle — could reuse ui/graph/ViewModeToggle but its
 * types are bound to GraphViewMode. Inline copy is 30 lines and lets
 * the Flow tab evolve independently (different mode set, different
 * storage key). DRY isn't always the right answer for small UI atoms.
 */
const toggleWrap = css({
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'stretch',
  border: '1px solid var(--border)',
  height: '32px',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
});

const toggleSeg = css({
  display: 'inline-flex',
  alignItems: 'center',
  flex: '1 0 0',
  justifyContent: 'center',
  minWidth: '90px',
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

const toggleSegActive = css({
  color: 'var(--fg)',
  background: 'var(--accent-soft)',
});

const toggleRail = css({
  position: 'absolute',
  bottom: '0',
  left: '0',
  /* Width is 1/N where N is the number of modes. Updated from 1/3 to
     1/4 when the Sequence mode landed. The transform: translateX(idx*100%)
     formula auto-scales because it's relative to the rail's own width. */
  width: 'calc(100% / 4)',
  height: '2px',
  background: 'var(--accent)',
  transition: 'transform 240ms var(--ease-out-quart)',
  pointerEvents: 'none',
});

/* ─────────── helpers ─────────── */

function flattenFiles(node: DatasetTreeNode): DatasetFile[] {
  const out: DatasetFile[] = [];
  (function walk(n: DatasetTreeNode) {
    for (const f of n.files) out.push(f);
    for (const c of n.children) walk(c);
  })(node);
  return out;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 10_000) return (n / 1_000).toFixed(1) + 'K';
  if (n >= 1_000) return (n / 1_000).toFixed(2) + 'K';
  return n.toLocaleString('en-US');
}

const MODES: ReadonlyArray<{ key: FlowViewMode; label: string; hint: string }> = [
  { key: 'swimlanes', label: 'Swimlanes', hint: 'Horizontal-lane architecture diagram' },
  { key: 'sequence',  label: 'Sequence',  hint: 'swimlanes.io-style sequence: pick an entry, see what it imports in order' },
  { key: 'entities',  label: 'Entities',  hint: 'Data-tier files with referrer counts' },
  { key: 'text',      label: 'Text',      hint: 'swimlanes.io-style copy-pasteable breakdown' },
];

export function Flow(handle: Handle<FlowProps>) {
  let viewMode: FlowViewMode = readStoredMode();
  /* Sequence-view state: entry point persisted to localStorage so a
     reload doesn't reset the user's chosen path. null = use the
     auto-picked default for the current dataset. */
  let seqEntryOverride: string | null = readStoredSeqEntry();

  function setViewMode(next: FlowViewMode) {
    if (next === viewMode) return;
    viewMode = next;
    writeStoredMode(next);
    void handle.update();
  }
  function setSeqEntry(next: string) {
    seqEntryOverride = next;
    writeStoredSeqEntry(next);
    void handle.update();
  }

  return ({ data }: FlowProps) => {
    const all = flattenFiles(data.tree);
    const inProject = new Set<string>(all.map((f) => f.path));
    const edges = (data.edges ?? []).filter((e) => inProject.has(e.from) && inProject.has(e.to));

    const result = analyzeFlow({
      files: all.map((f) => ({ path: f.path, language: f.language?.id ?? null, ext: f.ext })),
      edges: edges.map((e) => ({ from: e.from, to: e.to })),
      routes: data.routes ?? [],
      entryPoints: (data.entryPoints ?? []).map((e) => ({
        path: e.path,
        handlerFile: e.handlerFile,
      })),
      frameworks: data.project.frameworks,
    });

    /* Stats for the LabelNumberRow — most of the work was done by
       analyzeFlow; we just extract the headline numbers. */
    const activeTiers = TIER_ORDER.filter((t) => (result.tierCounts.get(t) ?? 0) > 0);
    const crossEdges = result.tierEdges
      .filter((e) => e.from !== e.to)
      .reduce((s, e) => s + e.count, 0);
    const entityCount = result.entities.length;
    const topPath = result.paths[0];

    const activeIdx = MODES.findIndex((m) => m.key === viewMode);

    return (
      <ContentWithMargin>
        {/* `minWidth: 0` — see the parallel comment in GraphRoute.tsx.
            The SequenceDiagram + SwimlanesDiagram can both produce
            very wide SVGs; without this the grid's `1fr` column
            would grow to fit them and push <body> past 100vw. */}
        <div mix={css({ gridColumn: '1', minWidth: '0' })}>
          <div mix={kicker}>
            Flow · {activeTiers.length} tier{activeTiers.length === 1 ? '' : 's'} · {fmt(crossEdges)} cross-tier edge{crossEdges === 1 ? '' : 's'}
          </div>
          <h1 mix={headline}>How data moves through this system.</h1>
          <p mix={lede}>
            Files classified into architectural tiers — entry points, UI, routes,
            handlers, data, and external boundaries — with the import edges
            between them aggregated into a flow diagram. Click a lane to see the
            files in it; switch to Entities for the data layer, or Text for a
            copy-pasteable swimlanes.io-style breakdown.
          </p>

          <LabelNumberRow>
            <LabelNumber label="Tiers"      value={fmt(activeTiers.length)} />
            <LabelNumber label="Files"      value={fmt(all.length)} />
            <LabelNumber label="Cross-tier" value={fmt(crossEdges)} hint="edges between tiers" />
            <LabelNumber label="Entities"   value={fmt(entityCount)} hint="data-tier files" last />
          </LabelNumberRow>

          <div mix={toggleRow}>
            <div mix={toggleWrap} role="tablist" aria-label="Flow view mode">
              {MODES.map((m) => {
                const isActive = m.key === viewMode;
                return (
                  <button
                    key={m.key}
                    type="button"
                    role="tab"
                    aria-selected={isActive ? 'true' : 'false'}
                    title={m.hint}
                    mix={[toggleSeg, isActive ? toggleSegActive : null, on('click', () => setViewMode(m.key))]}
                  >
                    {m.label}
                  </button>
                );
              })}
              <span aria-hidden="true" mix={toggleRail} style={`transform: translateX(${activeIdx * 100}%)`} />
            </div>
            <span mix={toggleHint}>
              {viewMode === 'swimlanes' && 'Tier-grouped diagram'}
              {viewMode === 'sequence'  && 'swimlanes.io-style sequence'}
              {viewMode === 'entities'  && `${entityCount} data file${entityCount === 1 ? '' : 's'}`}
              {viewMode === 'text'      && 'Plain-text breakdown'}
            </span>
          </div>

          {viewMode === 'swimlanes' && (
            <Section label="Swimlanes" title={`${activeTiers.length} tiers, ${fmt(crossEdges)} edges`}>
              <SwimlanesDiagram result={result} />
            </Section>
          )}

          {viewMode === 'sequence' && renderSequence()}

          {viewMode === 'entities' && (
            <Section label="Entities" title={`${entityCount} data-tier file${entityCount === 1 ? '' : 's'}`}>
              <EntityList entities={result.entities} />
            </Section>
          )}

          {viewMode === 'text' && (
            <Section label="Text breakdown" title="Copy-pasteable">
              <FlowText result={result} />
            </Section>
          )}
        </div>

        <MarginColumn>
          <FootnoteChip label="Top flow" tone={topPath ? 'accent' : 'neutral'}>
            {topPath
              ? topPath.tiers.map((t) => TIER_LABEL[t]).join(' → ')
              : 'No cross-tier flows detected.'}
            {topPath && <><br/>weight {topPath.weight}</>}
          </FootnoteChip>
          {activeTiers.slice(0, 4).map((tier) => {
            const count = result.tierCounts.get(tier) ?? 0;
            return (
              <FootnoteChip key={tier} label={TIER_LABEL[tier]}>
                {count} file{count === 1 ? '' : 's'} · {TIER_DESCRIPTION[tier]}
              </FootnoteChip>
            );
          })}
          <FootnoteChip label="Classifier">
            Tier classification combines explicit signals (route handlers, entry
            points) with path-pattern heuristics. Files that don't match fall to
            <span class="mono"> other</span>.
          </FootnoteChip>
          <FootnoteChip label="Coming with v0.4.4">
            Symbol-level entity relationships — when the analyzer ships
            type → type edges, Entities gains a graph view of how schemas
            depend on each other.
          </FootnoteChip>
        </MarginColumn>
      </ContentWithMargin>
    );

    /* Sequence renderer. Captures the route-render scope (data, edges,
       inProject) and exposes the entry-picker + SequenceDiagram. Lives
       inside the render closure so re-renders pick up fresh data; the
       sequence is recomputed when the entry override changes. */
    function renderSequence() {
      const routeHandlers = (data.routes ?? []).map((r) => r.handlerFile).filter(Boolean);
      const defaultEntry = pickDefaultEntryPoint(inProject, edges, routeHandlers);
      const entry = seqEntryOverride && inProject.has(seqEntryOverride) ? seqEntryOverride : defaultEntry;

      if (!entry) {
        return (
          <Section label="Sequence" title="No entry candidates">
            <p mix={css({ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' })}>
              No file in this project has any outgoing in-project imports.
              The sequence view needs at least one importer to walk from.
            </p>
          </Section>
        );
      }

      /* Build the picker options: route handlers first (most useful
         entry points), then the top-degree non-route files. Capped at
         60 so the <select> doesn't become an essay. */
      const routeSet = new Set(routeHandlers.filter((p) => inProject.has(p)));
      const outDeg = new Map<string, number>();
      for (const e of edges) outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
      const nonRoutes = Array.from(inProject)
        .filter((p) => !routeSet.has(p) && (outDeg.get(p) ?? 0) > 0)
        .sort((a, b) => (outDeg.get(b) ?? 0) - (outDeg.get(a) ?? 0))
        .slice(0, 30);
      const routeOptions = Array.from(routeSet).slice(0, 30);

      const seqResult = buildSequenceFlow({
        files: inProject,
        edges,
        entryPoint: entry,
      });

      return (
        <Section label="Sequence" title={`From ${entry}`}>
          <div mix={entryPickerRow}>
            <label mix={entryPickerLabel} for="seq-entry">Entry</label>
            <select
              id="seq-entry"
              mix={[
                entryPickerSelect,
                on<HTMLSelectElement, 'change'>('change', (e) => {
                  const val = (e.currentTarget as HTMLSelectElement | null)?.value ?? '';
                  if (val) setSeqEntry(val);
                }),
              ]}
              value={entry}
            >
              {routeOptions.length > 0 && (
                <optgroup label="Routes">
                  {routeOptions.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </optgroup>
              )}
              {nonRoutes.length > 0 && (
                <optgroup label="High-fanout files">
                  {nonRoutes.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
          <SequenceDiagram result={seqResult} />
        </Section>
      );
    }
  };
}

/* Keep an unused reference to suppress unused-import warnings if any
 * tier becomes unused locally. Tree-shaken to nothing in prod. */
void (TIER_ORDER as readonly Tier[]);
