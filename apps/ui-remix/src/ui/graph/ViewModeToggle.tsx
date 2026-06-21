/**
 * ViewModeToggle — three-way switch for the merged Graph tab.
 *
 *   - Heatmap → folder × folder coupling matrix (best for "where's the weight?")
 *   - Diagram → Sugiyama layered DAG (best for "how does the dependency flow?")
 *   - Layers  → tabular layer summary + cycles (best for "what's at depth X?")
 *
 * Persists the choice to localStorage so reload-then-revisit goes back
 * to whatever the user picked. localStorage failures (Safari private mode,
 * quota) are silently swallowed — the in-session value still drives the UI.
 *
 * This is a controlled component: parent owns the value + onChange. The
 * persistence helpers (readStoredMode / writeStoredMode) are exported so
 * the parent can hydrate from localStorage on mount without duplicating
 * the storage key.
 */
import type { Handle } from 'remix/ui';
import { css, on } from 'remix/ui';

export type GraphViewMode = 'heatmap' | 'diagram' | 'layers';

const STORAGE_KEY = 'factstack:graph-view-mode';

interface ViewModeToggleProps {
  value: GraphViewMode;
  onChange: (next: GraphViewMode) => void;
}

const wrap = css({
  /* `position: relative` so the absolutely-positioned active rail
     beneath aligns to this container's box. */
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

const segment = css({
  display: 'inline-flex',
  alignItems: 'center',
  /* Equal-width segments so the sliding rail has a clean target.
     Without `flex: 1`, segments size to their text and the rail's
     `width: 33.333%` would overshoot/undershoot. */
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
  '&:hover': {
    color: 'var(--accent)',
    background: 'var(--accent-soft)',
  },
  '&:focus-visible': {
    outline: '2px solid var(--accent)',
    outlineOffset: '-2px',
  },
});

const segmentActive = css({
  color: 'var(--fg)',
  background: 'var(--accent-soft)',
});

/* The sliding rail. Absolutely positioned beneath the segments;
 * `transform: translateX` animated via the inline style so the rail
 * slides between active segments instead of the boxShadow appearing
 * on a different button each click. Width is a third of the wrap
 * (one segment) — works because segments are equal-width via `flex: 1`. */
const activeRail = css({
  position: 'absolute',
  bottom: '0',
  left: '0',
  width: 'calc(100% / 3)',
  height: '2px',
  background: 'var(--accent)',
  transition: 'transform 240ms var(--ease-out-quart)',
  pointerEvents: 'none',
});

const MODES: ReadonlyArray<{ key: GraphViewMode; label: string; hint: string }> = [
  { key: 'heatmap', label: 'Heatmap', hint: 'Folder × folder coupling matrix' },
  { key: 'diagram', label: 'Diagram', hint: 'Sugiyama layered DAG' },
  { key: 'layers',  label: 'Layers',  hint: 'Files grouped by depth + cycles' },
];

export function ViewModeToggle(handle: Handle<ViewModeToggleProps>) {
  return () => {
    const { value, onChange } = handle.props;
    /* Active-segment index drives the rail translation. translate by
       100% per segment because the rail's width is `calc(100% / 3)`
       (one-third of the wrap). Multiplying by index = sliding to the
       Nth slot. */
    const activeIdx = MODES.findIndex((m) => m.key === value);
    return (
      <div mix={wrap} role="tablist" aria-label="Graph view mode">
        {MODES.map((m) => {
          const isActive = m.key === value;
          return (
            <button
              key={m.key}
              type="button"
              role="tab"
              aria-selected={isActive ? 'true' : 'false'}
              title={m.hint}
              mix={[segment, isActive ? segmentActive : null, on('click', () => {
                if (isActive) return;
                onChange(m.key);
                writeStoredMode(m.key);
              })]}
            >
              {m.label}
            </button>
          );
        })}
        {/* The sliding rail. transform driven by activeIdx so it
            tweens between segments via the CSS transition above. */}
        <span aria-hidden="true" mix={[activeRail, css({ transform: `translateX(${activeIdx * 100}%)` })]} />
      </div>
    );
  };
}

/* ─────────── persistence ─────────── */

export function readStoredMode(): GraphViewMode {
  if (typeof localStorage === 'undefined') return 'heatmap';
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'heatmap' || v === 'diagram' || v === 'layers') return v;
  } catch {
    /* swallow */
  }
  return 'heatmap';
}

function writeStoredMode(value: GraphViewMode): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* swallow */
  }
}
