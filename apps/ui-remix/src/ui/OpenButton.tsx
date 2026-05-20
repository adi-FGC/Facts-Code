/**
 * OpenButton — header affordance that opens the OpenModal.
 *
 * Two shapes, picked by the visual context the design needs:
 *
 *   - Default ("Open"): editorial mono pill matching the existing
 *     ReanalyzeButton language. One click → opens the modal in Local
 *     mode. Shift-click → opens in GitHub mode (mirrors the ⌘O / ⌘⇧O
 *     keyboard shortcut shape).
 *
 * The button doesn't import the OpenModal directly. It dispatches a
 * `factstack:open` CustomEvent that the modal's global listener picks
 * up. Keeps the dependency graph one-way (button → event → modal) so
 * the bundler can chunk-split however it wants.
 *
 * Tooltip rotates with shift-state via the title attribute. Not the
 * deepest UX (title isn't reactive on hover-with-shift), but it's the
 * editorial voice the rest of the system uses.
 */
import type { Handle } from '@remix-run/ui';
import { css, on } from '@remix-run/ui';

const wrap = css({
  display: 'inline-flex',
  alignItems: 'stretch',
  height: '28px',
  border: '1px solid var(--border)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
});

const btn = css({
  display: 'inline-flex',
  alignItems: 'center',
  paddingInline: '12px',
  background: 'transparent',
  border: 'none',
  color: 'var(--fg-muted)',
  cursor: 'pointer',
  font: 'inherit',
  letterSpacing: 'inherit',
  textTransform: 'inherit',
  transition: 'color var(--dur-quick) var(--ease-out-quart), background var(--dur-quick) var(--ease-out-quart)',
  '&:hover': {
    color: 'var(--accent)',
    background: 'var(--accent-soft)',
  },
  '&:focus-visible': {
    outline: '2px solid var(--accent)',
    outlineOffset: '-2px',
  },
});

/* The ↗ glyph is the same arrow the editorial design language uses for
   "go to / opens elsewhere" (see footnote chip, external links). Quieter
   than a folder icon, and consistent with the broadsheet metaphor. */
const arrow = css({
  display: 'inline-block',
  marginLeft: '8px',
  fontFamily: 'var(--font-mono)',
  color: 'var(--fg-faint)',
});

export function OpenButton(_handle: Handle) {
  function fire(e: MouseEvent) {
    /* Shift+click = GitHub mode, plain click = Local. Mirrors the
       ⌘O / ⌘⇧O keyboard shape. */
    const mode = e.shiftKey ? 'github' : 'local';
    window.dispatchEvent(new CustomEvent('factstack:open', { detail: { mode } }));
  }
  return () => (
    <div mix={wrap}>
      <button
        type="button"
        title="Open a project to scan (⌘O · shift for GitHub URL)"
        aria-label="Open project"
        mix={[btn, on<HTMLButtonElement, 'click'>('click', fire)]}
      >
        Open<span aria-hidden="true" mix={arrow}>↗</span>
      </button>
    </div>
  );
}
