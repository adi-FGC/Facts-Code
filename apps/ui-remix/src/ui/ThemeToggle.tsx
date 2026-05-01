/**
 * ThemeToggle — three-state segmented control: SYS · LGT · DRK.
 *
 * - SYS  → unset localStorage; theme follows `prefers-color-scheme`
 * - LGT  → force light, persist
 * - DRK  → force dark, persist
 *
 * No skeuomorphic slider, no sun/moon icon — three uppercase mono
 * tokens grouped behind a single hairline border. Active label burns
 * safety-orange. Reads as a printer's mode toggle, not a UI switch.
 *
 * Event wiring uses Remix v3's `on()` mixin per element so we don't
 * fight the JSX-level click typing on `<button>`.
 */
import type { Handle } from '@remix-run/ui';
import { css, on } from '@remix-run/ui';

type Theme = 'system' | 'light' | 'dark';
const STORE_KEY = 'facts-theme';

function readStored(): Theme {
  try {
    const v = localStorage.getItem(STORE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
    return 'system';
  } catch { return 'system'; }
}

/**
 * Apply the theme to <html>. SYS reads the live media query; the
 * explicit modes set data-theme directly. We also write color-scheme
 * so native form controls + scrollbars adopt the right palette.
 */
function applyTheme(t: Theme) {
  const html = document.documentElement;
  let effective: 'light' | 'dark';
  if (t === 'system') {
    effective = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } else {
    effective = t;
  }
  html.dataset.theme = effective;
  html.style.colorScheme = effective;
}

function persist(t: Theme) {
  try {
    if (t === 'system') localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, t);
  } catch { /* private mode — no-op */ }
}

/* Audit fix #7: bumped to fs-11 / 28px height / 0.12em tracking.
   24px height was below WCAG 2.5.5 touch target guidance (44px is
   ideal but we use editorial micro-controls; 28px is the floor with
   adequate paddingInline). Tracking 0.16 → 0.12em improves
   readability of 3-letter labels. */
const wrap = css({
  display: 'inline-flex',
  alignItems: 'stretch',
  border: '1px solid var(--border)',
  borderRadius: '0',
  height: '28px',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
});

const seg = css({
  display: 'inline-flex',
  alignItems: 'center',
  paddingInline: '10px',         /* up from --space-2 (8px) */
  background: 'transparent',
  border: 'none',
  borderRight: '1px solid var(--border)',
  color: 'var(--fg-muted)',
  cursor: 'pointer',
  font: 'inherit',
  letterSpacing: 'inherit',
  textTransform: 'inherit',
  transition: 'color var(--dur-quick) var(--ease-out-quart), background var(--dur-quick) var(--ease-out-quart)',
});

const segLast = css({
  borderRight: 'none',
});

const segActive = css({
  color: 'var(--accent)',
  background: 'var(--accent-soft)',
});

const SEGMENTS: Array<{ key: Theme; label: string; title: string }> = [
  { key: 'system', label: 'Sys', title: 'Follow system preference' },
  { key: 'light',  label: 'Lgt', title: 'Force light' },
  { key: 'dark',   label: 'Drk', title: 'Force dark' },
];

export function ThemeToggle(handle: Handle) {
  let current: Theme = readStored();

  // When the user is in SYS mode, follow live OS-level preference
  // changes too. The MQL listener stays alive for the component's
  // lifetime; aborted on unmount via handle.signal.
  const mql = matchMedia('(prefers-color-scheme: dark)');
  const onMqlChange = () => {
    if (current === 'system') {
      applyTheme('system');
      void handle.update();
    }
  };
  mql.addEventListener('change', onMqlChange);
  handle.signal.addEventListener('abort', () => mql.removeEventListener('change', onMqlChange));

  /* ⌘J cycles theme via lib/theme.ts → dispatches `factstack:theme`.
     We sync the segmented control's `current` to the new theme so the
     active pill flips visually without us re-reading storage. */
  const onThemeShortcut = (e: Event) => {
    const next = (e as CustomEvent<Theme>).detail;
    if (next === 'light' || next === 'dark' || next === 'system') {
      current = next;
      void handle.update();
    }
  };
  window.addEventListener('factstack:theme', onThemeShortcut);
  handle.signal.addEventListener('abort', () => window.removeEventListener('factstack:theme', onThemeShortcut));

  function set(next: Theme) {
    if (next === current) {
      // Re-clicking the active segment is a no-op visually, but if it's
      // SYS we re-apply in case the OS pref drifted outside our listener.
      if (next === 'system') applyTheme('system');
      return;
    }
    current = next;
    persist(next);
    applyTheme(next);
    void handle.update();
  }

  return () => (
    <div role="radiogroup" aria-label="Theme" mix={wrap}>
      {SEGMENTS.map((s, i) => {
        const isActive = s.key === current;
        return (
          <button
            key={s.key}
            type="button"
            role="radio"
            aria-checked={isActive ? 'true' : 'false'}
            title={s.title}
            mix={[
              seg,
              i === SEGMENTS.length - 1 ? segLast : null,
              isActive ? segActive : null,
              on('click', () => set(s.key)),
            ]}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}
