/**
 * Theme persistence + apply, shared between ThemeToggle, Config, and
 * the global ⌘J shortcut.
 *
 * One source of truth for the storage key, the cycle order, and the
 * applied DOM side-effects. Keeps the three call sites from drifting.
 */

export type Theme = 'system' | 'light' | 'dark';
export const THEME_STORE_KEY = 'facts-theme';

/* Cycle order for ⌘J: system → light → dark → system. Picking
   system as the start of the cycle puts the OS-default at the easy-
   to-reach position; users who want to lock can press ⌘J once or
   twice from there. */
const ORDER: readonly Theme[] = ['system', 'light', 'dark'] as const;

export function readStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_STORE_KEY);
    if (v === 'light' || v === 'dark') return v;
    return 'system';
  } catch { return 'system'; }
}

export function persistTheme(t: Theme): void {
  try {
    if (t === 'system') localStorage.removeItem(THEME_STORE_KEY);
    else localStorage.setItem(THEME_STORE_KEY, t);
  } catch { /* private mode — silently no-op */ }
}

export function applyTheme(t: Theme): 'light' | 'dark' {
  const html = document.documentElement;
  const effective: 'light' | 'dark' =
    t === 'system'
      ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : t;
  html.dataset.theme = effective;
  html.style.colorScheme = effective;
  return effective;
}

export function nextTheme(curr: Theme): Theme {
  const i = ORDER.indexOf(curr);
  return ORDER[(i + 1) % ORDER.length]!;
}

/**
 * One-shot wrapper used by ⌘J. Reads → advances → persists → applies →
 * dispatches a `factstack:theme` CustomEvent so ThemeToggle / Config
 * can re-render their segmented controls without re-reading storage.
 */
export function cycleThemeShortcut(): void {
  const next = nextTheme(readStoredTheme());
  persistTheme(next);
  applyTheme(next);
  window.dispatchEvent(new CustomEvent<Theme>('factstack:theme', { detail: next }));
}
