/**
 * SourceChip — header affordance that shows the project currently
 * driving the dashboard, and opens the picker on click.
 *
 * Display rules:
 *   1. If there's a "current" source recorded in recents (set whenever
 *      the in-browser scanner publishes a fresh dataset), show the
 *      source's glyph (◆ / ↗) and label.
 *   2. Otherwise — typical for the static deploy + the CLI dev server
 *      first-load case — fall back to the project's name + root path,
 *      same as the previous static chip.
 *
 * Clicking the chip dispatches `factstack:open` which the OpenModal
 * picks up. That makes the chip a discoverable entry point for the
 * Open / Recents flow without repeating the OpenButton's label —
 * the chip already says "you're looking at X", clicking on X to
 * change it is intuitive.
 *
 * Visual language:
 *   - 1-px left border separates from the nav (matches old projectChip).
 *   - Mono caption + subtle path line under the name (when present).
 *   - Hover: accent-soft background + border becomes accent.
 *   - Active scan in flight: pulse the glyph.
 *
 * Hidden under 1280px because the header is too dense at md/sm; the
 * OpenButton in the right cluster covers the same intent there.
 */
import type { Handle } from 'remix/ui';
import { css, on } from 'remix/ui';
import {
  getCurrentSourceId,
  listRecents,
  onCurrentSourceChange,
  recentGlyph,
  recentLabel,
  type Recent,
} from '../lib/recents.ts';

interface SourceChipProps {
  /** Fallback display when there's no current source — the project
   *  name and root path baked into the dataset. */
  projectName: string;
  projectRoot: string;
}

/* Same keyframe-injection pattern as OpenModal — one <style> tag at
 * module scope, gated on `prefers-reduced-motion: no-preference`. The
 * "flash" is a one-shot border + background pulse that fires whenever
 * the active source changes; signals to the user "the dashboard
 * you're looking at is now THIS source." */
const FLASH_KEYFRAMES_ID = 'source-chip-keyframes';
function ensureFlashKeyframes() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(FLASH_KEYFRAMES_ID)) return;
  const s = document.createElement('style');
  s.id = FLASH_KEYFRAMES_ID;
  s.textContent = `
    @media (prefers-reduced-motion: no-preference) {
      @keyframes source-chip-flash {
        0%   { background: var(--accent-soft); border-left-color: var(--accent) }
        100% { background: transparent;        border-left-color: var(--border)  }
      }
    }
  `;
  document.head.appendChild(s);
}

const wrap = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
  paddingInline: 'var(--space-3)',
  paddingBlock: 'var(--space-1)',
  borderLeft: '1px solid var(--border)',
  borderRight: '1px solid transparent',
  borderTop: '1px solid transparent',
  borderBottom: '1px solid transparent',
  minWidth: '0',
  maxWidth: '36ch',
  background: 'transparent',
  cursor: 'pointer',
  font: 'inherit',
  textAlign: 'left',
  color: 'var(--fg-muted)',
  transition: 'color var(--dur-quick) var(--ease-out-quart), background var(--dur-quick) var(--ease-out-quart), border-color var(--dur-quick) var(--ease-out-quart)',
  '&:hover': {
    color: 'var(--fg)',
    background: 'var(--accent-soft)',
    borderLeftColor: 'var(--accent)',
  },
  '&:focus-visible': {
    outline: '2px solid var(--accent)',
    outlineOffset: '-2px',
  },
  '@media (max-width: 1279px)': {
    display: 'none',
  },
});

/* Applied conditionally in render when the source ID changes. The
 * 800ms duration is long enough to register peripherally without
 * dragging on; ease-out-quart so it fades quickly and lingers briefly. */
const wrapFlash = css({
  animation: 'source-chip-flash 800ms var(--ease-out-quart)',
});

const glyphCell = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  color: 'var(--accent)',
  /* Pad the glyph so the optical center sits with the label baseline.
     Mono "◆" sits a hair lower than mono "↗" — split the difference. */
  lineHeight: '1',
  flex: 'none',
});

const stack = css({
  display: 'flex',
  flexDirection: 'column',
  minWidth: '0',
  /* Two stacked lines (name + path) — keep them tight so the chip
     fits in the 28-px header row without bleeding into the nav. */
  lineHeight: '1.15',
});

const sourceName = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});

const sourceSub = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  color: 'var(--fg-faint)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});

export function SourceChip(handle: Handle<SourceChipProps>) {
  ensureFlashKeyframes();

  /* Closure state: cache the active recent + reload it whenever the
     current-source pointer changes. listRecents is async + IDB-backed
     so we can't read it synchronously; cache + invalidate works fine.
     Initial load happens once on mount. */
  let activeRecent: Recent | null = null;
  /* `flashKey` increments on every source change. The render branches
     on (lastRenderedKey !== flashKey) to apply the flash class for one
     render, then bumps the rendered key so subsequent renders don't
     re-apply (which would replay the animation on every unrelated
     re-render — like hover on the OpenButton). */
  let flashKey = 0;
  let lastRenderedKey = 0;

  async function refresh() {
    const id = getCurrentSourceId();
    let next: Recent | null = null;
    if (id) {
      try {
        const all = await listRecents();
        next = all.find((r) => r.id === id) ?? null;
      } catch {
        next = null;
      }
    }
    /* Fire the flash only on actual source change — not on the initial
       mount (when activeRecent goes null → first value with no prior
       state to "swap from"). Compare ids: equal ids = no flash; any
       difference = flash. */
    const prevId = activeRecent?.id ?? null;
    const nextId = next?.id ?? null;
    if (prevId !== nextId && prevId !== null) flashKey++;
    activeRecent = next;
    void handle.update();
  }

  void refresh();
  const unsub = onCurrentSourceChange(() => { void refresh(); });
  handle.signal.addEventListener('abort', unsub);

  function openPicker() {
    /* Always opens in Local mode by default. The user can toggle to
       GitHub inside the modal; the header chip's job is just to say
       "open the picker", not to remember which mode the recent used. */
    window.dispatchEvent(new CustomEvent('factstack:open', { detail: { mode: 'local' } }));
  }

  return ({ projectName, projectRoot }: SourceChipProps) => {
    /* When we have an active recent, show its glyph + label.
       Otherwise fall back to the project name + a path subline. */
    const glyph = activeRecent ? recentGlyph(activeRecent) : '·';
    const label = activeRecent ? recentLabel(activeRecent) : projectName;
    const subline = activeRecent
      ? (activeRecent.kind === 'local' ? 'Local folder' : 'GitHub repo')
      : projectRoot;
    const titleAttr = `Currently showing: ${label}${subline ? ` — ${subline}` : ''}. Click to open another project.`;
    const shouldFlash = flashKey > lastRenderedKey;
    /* Mark this key as rendered AFTER reading shouldFlash. Next render
       sees flashKey == lastRenderedKey and skips the flash class. */
    if (shouldFlash) lastRenderedKey = flashKey;

    return (
      <button
        type="button"
        /* `key` includes flashKey so the runtime treats this as a
           "new" element on flash, restarting the CSS animation. Without
           the key bump, applying the same animation class on the same
           element wouldn't replay it. */
        key={`source-${flashKey}`}
        title={titleAttr}
        aria-label={titleAttr}
        mix={[wrap, shouldFlash ? wrapFlash : null, on<HTMLButtonElement, 'click'>('click', openPicker)]}
      >
        <span aria-hidden="true" mix={glyphCell}>{glyph}</span>
        <span mix={stack}>
          <span mix={sourceName}>{label}</span>
          {subline && <span mix={sourceSub} dir={activeRecent ? 'ltr' : 'rtl'}>{subline}</span>}
        </span>
      </button>
    );
  };
}
