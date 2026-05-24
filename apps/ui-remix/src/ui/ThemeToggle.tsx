/**
 * ThemeToggle — single-button cycle (sun → moon → split-disc → sun).
 *
 * Was a 3-segment radio (SYS · LGT · DRK). The labels burned ~120px
 * of header real estate to express something a single icon already
 * communicates: "what mode are we in?" The cycle order is the same
 * one ⌘J uses (`lib/theme.ts → nextTheme()`), so the keyboard
 * shortcut and the click both call the same advance.
 *
 *   - LIGHT  → ☼ sun (rays)
 *   - DARK   → ☾ crescent moon
 *   - SYSTEM → ◐ split disc (half-and-half — matches OS-pref intent)
 *
 * Icons are inline 14px SVGs drawn with stroke only (no fills) so
 * they read in the editorial monochrome language. The active state
 * pulls accent color through `currentColor`.
 *
 * Tooltip rotates with state: shows the next mode the click will
 * advance to, e.g. "Light · click for Dark".
 */
import type { Handle } from 'remix/ui';
import { css, on } from 'remix/ui';
import { applyTheme, nextTheme, persistTheme, readStoredTheme, type Theme } from '../lib/theme.ts';

const wrap = css({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1px solid var(--border)',
  background: 'transparent',
  width: '28px',
  height: '28px',
  cursor: 'pointer',
  color: 'var(--fg-muted)',
  padding: '0',
  /* Editorial detail: a tiny inset hairline on hover hints "this is
     a button" without box-shadow noise. Color shift signals the
     active interaction state. */
  transition: 'color var(--dur-quick) var(--ease-out-quart), background var(--dur-quick) var(--ease-out-quart), border-color var(--dur-quick) var(--ease-out-quart)',
  '&:hover': {
    color: 'var(--accent)',
    background: 'var(--accent-soft)',
    borderColor: 'var(--border-strong, var(--accent))',
  },
  '&:focus-visible': {
    outline: '2px solid var(--accent)',
    outlineOffset: '2px',
  },
});

/* Inline SVG icons. Stroke-only; 14px on a 16px viewbox so they sit
   comfortably inside the 28px button without crowding. We render
   them inline (not as component functions) because Remix v3
   components require the `(handle) => (props) => RemixElement`
   shape — a plain function returning JSX is rejected by the
   JSX-component signature check. Inline keeps the JSX simple. */

function renderSun() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <circle cx="8" cy="8" r="3" />
      <line x1="8" y1="1.5" x2="8" y2="3" />
      <line x1="8" y1="13" x2="8" y2="14.5" />
      <line x1="1.5" y1="8" x2="3" y2="8" />
      <line x1="13" y1="8" x2="14.5" y2="8" />
      <line x1="3.4" y1="3.4" x2="4.5" y2="4.5" />
      <line x1="11.5" y1="11.5" x2="12.6" y2="12.6" />
      <line x1="3.4" y1="12.6" x2="4.5" y2="11.5" />
      <line x1="11.5" y1="4.5" x2="12.6" y2="3.4" />
    </svg>
  );
}

function renderMoon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 9.5A6 6 0 0 1 6.5 3a0.5 0.5 0 0 0-0.7-0.5A6.5 6.5 0 1 0 13.5 10.2 0.5 0.5 0 0 0 13 9.5z" />
    </svg>
  );
}

function renderSystem() {
  /* Split disc — left half outlined, right half filled. Communicates
     "auto / two modes" without resembling a hard light/dark choice. */
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5 a5.5 5.5 0 0 1 0 11 z" fill="currentColor" stroke="none" />
    </svg>
  );
}

const NEXT_LABEL: Record<Theme, string> = {
  system: 'Light',
  light: 'Dark',
  dark: 'System',
};
const CURRENT_LABEL: Record<Theme, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

export function ThemeToggle(handle: Handle) {
  let current: Theme = readStoredTheme();

  /* Live OS-pref tracking — when in system mode, swap the rendered
     theme as the user toggles their OS appearance. The icon doesn't
     change (system stays system) but the page palette flips. */
  const mql = matchMedia('(prefers-color-scheme: dark)');
  const onMqlChange = () => {
    if (current === 'system') applyTheme('system');
  };
  mql.addEventListener('change', onMqlChange);
  handle.signal.addEventListener('abort', () => mql.removeEventListener('change', onMqlChange));

  /* ⌘J cycles theme through `lib/theme.ts → cycleThemeShortcut()`,
     which dispatches a `factstack:theme` event. The toggle listens
     so its icon stays in sync regardless of which entry point fired
     the cycle. */
  const onThemeShortcut = (e: Event) => {
    const next = (e as CustomEvent<Theme>).detail;
    if (next === 'light' || next === 'dark' || next === 'system') {
      current = next;
      void handle.update();
    }
  };
  window.addEventListener('factstack:theme', onThemeShortcut);
  handle.signal.addEventListener('abort', () => window.removeEventListener('factstack:theme', onThemeShortcut));

  function advance() {
    current = nextTheme(current);
    persistTheme(current);
    applyTheme(current);
    void handle.update();
  }

  return () => {
    const icon =
      current === 'light' ? renderSun() :
      current === 'dark'  ? renderMoon() :
                            renderSystem();
    const title = `${CURRENT_LABEL[current]} · click for ${NEXT_LABEL[current]}`;
    return (
      <button
        type="button"
        aria-label={`Theme: ${CURRENT_LABEL[current]}. Click to switch to ${NEXT_LABEL[current]}.`}
        title={title}
        mix={[wrap, on('click', advance)]}
      >
        {icon}
      </button>
    );
  };
}
