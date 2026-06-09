/**
 * DagControls — toolbar above the SugiyamaDag.
 *
 * Three controls in editorial mono pill style:
 *
 *   1. **Granularity toggle** [Files | Symbols] — picks file-level
 *      (default, always available) vs symbol-level (gated; only
 *      enabled when `agent.symbolEdges` lands in v0.4.4. Today
 *      Symbols renders an explanatory empty state so the affordance
 *      is discoverable before the data exists).
 *
 *   2. **Show all toggle** — lifts the top-N node cap. Caller passes
 *      `nodeCap` (e.g. 60) and `totalNodes` (e.g. 253); the toggle
 *      flips between the cap and "all". Only enabled when the project
 *      has more nodes than the cap (otherwise it's a no-op affordance).
 *
 *   3. **Reset zoom button** — only enabled when zoom != 1 or pan != 0.
 *      Clicking returns the SVG transform to identity.
 *
 * Controlled component: parent owns all state. The toolbar is a thin
 * presentation layer that emits onChange callbacks.
 */
import type { Handle } from 'remix/ui';
import { css, on } from 'remix/ui';

export type Granularity = 'files' | 'symbols';

interface DagControlsProps {
  granularity: Granularity;
  onGranularityChange: (next: Granularity) => void;
  /** True when symbol-level data is available in the current dataset.
   *  Gates the Symbols button when false (still visible, but disabled
   *  with a tooltip explaining why). */
  symbolsAvailable: boolean;

  showAll: boolean;
  onShowAllChange: (next: boolean) => void;
  /** Cap that "show all" lifts — used in the button label so the user
   *  knows what they're un-capping. */
  nodeCap: number;
  totalNodes: number;

  zoomedOrPanned: boolean;
  onResetZoom: () => void;

  styleMode: 'classic' | 'neo';
  onStyleModeChange: (next: 'classic' | 'neo') => void;

  /** Color the diagram nodes by community (F5 label-propagation cluster).
   *  Default off — preserves the editorial monochrome look. */
  colorByCommunity: boolean;
  onColorByCommunityChange: (next: boolean) => void;
  /** True when the dataset carries community metrics (`data.nodeMetrics`).
   *  Gates the toggle when false — visible but disabled, with a tooltip
   *  explaining why, so the affordance stays discoverable. */
  communitiesAvailable: boolean;
}

/* ─────────── styles ─────────── */

const wrap = css({
  display: 'flex',
  alignItems: 'stretch',
  flexWrap: 'wrap',
  gap: 'var(--space-3)',
  marginBottom: 'var(--space-3)',
});

const group = css({
  display: 'inline-flex',
  alignItems: 'stretch',
  border: '1px solid var(--border)',
  height: '28px',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
});

const segment = css({
  display: 'inline-flex',
  alignItems: 'center',
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
  '&:hover:not(:disabled)': {
    color: 'var(--accent)',
    background: 'var(--accent-soft)',
  },
  '&:focus-visible': {
    outline: '2px solid var(--accent)',
    outlineOffset: '-2px',
  },
  '&:disabled': {
    color: 'var(--fg-faint)',
    cursor: 'not-allowed',
  },
});

const segmentActive = css({
  color: 'var(--fg)',
  background: 'var(--accent-soft)',
  boxShadow: 'inset 0 -2px 0 0 var(--accent)',
});

/* Single button (not a segmented group). Same height + monospace
 * register so it sits cleanly next to the groups. */
const standalone = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  height: '28px',
  paddingInline: 'var(--space-3)',
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--fg-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  cursor: 'pointer',
  transition: 'color var(--dur-quick) var(--ease-out-quart), background var(--dur-quick) var(--ease-out-quart)',
  '&:hover:not(:disabled)': {
    color: 'var(--accent)',
    background: 'var(--accent-soft)',
  },
  '&:focus-visible': {
    outline: '2px solid var(--accent)',
    outlineOffset: '-2px',
  },
  '&:disabled': {
    color: 'var(--fg-faint)',
    cursor: 'not-allowed',
  },
});

const dimGlyph = css({
  fontFamily: 'var(--font-mono)',
  color: 'var(--fg-faint)',
});

export function DagControls(handle: Handle<DagControlsProps>) {
  return () => {
    const props = handle.props;
    const {
      granularity,
      onGranularityChange,
      symbolsAvailable,
      showAll,
      onShowAllChange,
      nodeCap,
      totalNodes,
      zoomedOrPanned,
      onResetZoom,
      styleMode,
      onStyleModeChange,
      colorByCommunity,
      onColorByCommunityChange,
      communitiesAvailable,
    } = props;

    /* "Show all" makes no sense when totalNodes ≤ nodeCap — disable
       the toggle but keep it visible so the affordance is discoverable. */
    const canShowAll = totalNodes > nodeCap;

    return (
      <div mix={wrap} role="toolbar" aria-label="Diagram controls">
        {/* Style selection: Classic | Neo */}
        <div mix={group}>
          <button
            type="button"
            aria-pressed={styleMode === 'classic' ? 'true' : 'false'}
            title="Monochrome, hairline borders, no arrowheads"
            mix={[segment, styleMode === 'classic' ? segmentActive : null, on('click', () => {
              if (styleMode !== 'classic') onStyleModeChange('classic');
            })]}
          >Classic</button>
          <button
            type="button"
            aria-pressed={styleMode === 'neo' ? 'true' : 'false'}
            title="Dynamic color-coded imports/exports, arrowheads, and horizontal guide lines"
            mix={[segment, styleMode === 'neo' ? segmentActive : null, on('click', () => {
              if (styleMode !== 'neo') onStyleModeChange('neo');
            })]}
          >Neo-DAG</button>
        </div>

        {/* Granularity: Files | Symbols */}
        <div mix={group}>
          <button
            type="button"
            aria-pressed={granularity === 'files' ? 'true' : 'false'}
            title="File-level dependency graph"
            mix={[segment, granularity === 'files' ? segmentActive : null, on('click', () => {
              if (granularity !== 'files') onGranularityChange('files');
            })]}
          >Files</button>
          <button
            type="button"
            disabled={!symbolsAvailable}
            aria-pressed={granularity === 'symbols' ? 'true' : 'false'}
            title={symbolsAvailable
              ? 'Symbol-level (function/class) dependency graph'
              : 'Symbol-level edges arrive in v0.4.4. The toggle lights up automatically when the analyzer ships them.'}
            mix={[segment, granularity === 'symbols' ? segmentActive : null, on('click', () => {
              if (symbolsAvailable && granularity !== 'symbols') onGranularityChange('symbols');
            })]}
          >Symbols</button>
        </div>

        {/* Show-all toggle */}
        <button
          type="button"
          disabled={!canShowAll}
          aria-pressed={showAll ? 'true' : 'false'}
          title={canShowAll
            ? showAll
              ? `Limit back to top ${nodeCap} by degree`
              : `Render all ${totalNodes} nodes (may be dense)`
            : `Project has ${totalNodes} nodes — already showing all of them`}
          mix={[standalone, showAll ? segmentActive : null, on('click', () => {
            if (canShowAll) onShowAllChange(!showAll);
          })]}
        >
          {showAll ? `Top ${nodeCap}` : `Show all ${totalNodes}`}
        </button>

        {/* Communities — color nodes by label-propagation cluster.
            Default off (monochrome); disabled when the dataset has no
            community metrics. Active state shown by the segmentActive
            inset accent, matching the Show-all toggle. */}
        <button
          type="button"
          disabled={!communitiesAvailable}
          aria-pressed={colorByCommunity ? 'true' : 'false'}
          title={communitiesAvailable
            ? colorByCommunity
              ? 'Back to monochrome nodes'
              : 'Color nodes by module (label-propagation community)'
            : 'No community metrics in this dataset — re-run `factstack analyze` to compute graph analytics.'}
          mix={[standalone, colorByCommunity ? segmentActive : null, on('click', () => {
            if (communitiesAvailable) onColorByCommunityChange(!colorByCommunity);
          })]}
        >
          <span aria-hidden="true" mix={dimGlyph}>◑</span>
          Communities
        </button>

        {/* Reset — clears zoom + pan + dragged-node positions to the
            layout default. Enabled whenever any of those drift from
            identity. The tooltip surfaces the Alt+drag affordance for
            discoverability — there's no visual cue at rest. */}
        <button
          type="button"
          disabled={!zoomedOrPanned}
          title={zoomedOrPanned
            ? 'Reset zoom, pan, and dragged-node positions'
            : 'View is at default · Hold Alt and drag a node to reposition it · Drag the background to pan · Ctrl/⌘ + wheel to zoom'}
          mix={[standalone, on('click', onResetZoom)]}
        >
          <span aria-hidden="true" mix={dimGlyph}>⊙</span>
          Reset
        </button>
      </div>
    );
  };
}
