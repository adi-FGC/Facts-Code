/**
 * CommandPalette — ⌘K / Ctrl+K quick-jump.
 *
 * Pattern: a slide-down panel anchored under the Header (NOT a centered
 * modal — design_spec rule #14 says modals are lazy). Typing filters
 * a unified result list of:
 *
 *   - **Tabs** (10 routes from `lib/routes.ts`) — quick navigation.
 *   - **Files** (every file in `data.tree`) — opens Files detail view
 *     via `/files?p={path}`.
 *
 * Keyboard:
 *   - ⌘K / Ctrl+K     → open
 *   - Esc              → close
 *   - ArrowUp/Down     → move selection
 *   - Enter            → navigate to selection
 *
 * Closes on outside click, route change, or Escape.
 *
 * The component lives outside the main grid so it can overlay the
 * content area without disturbing layout. Uses pure DOM events (the
 * global ⌘K listener is attached at module-scope from `mount()` so it
 * works regardless of which route is active).
 */
import type { Handle } from 'remix/ui';
import { css, on, ref } from 'remix/ui';
import type { Dataset, DatasetFile, DatasetTreeNode } from '../lib/loadArtifacts.ts';
import { TABS, ICON_TABS } from '../lib/routes.ts';
import { navigate } from '../lib/navigate.ts';

/* Quick-jump targets: the 7 numbered tabs plus the right-side icon
   routes (Config, About) so ⌘K still reaches them after they left the
   numbered nav. */
const NAV_TARGETS = [...TABS, ...ICON_TABS];

interface PaletteProps {
  data: Dataset;
}

interface Result {
  type: 'tab' | 'file';
  label: string;
  detail: string;       // path or kicker line
  href: string;
  /** Sort weight (higher = better match). */
  score: number;
}

function flattenFiles(node: DatasetTreeNode): DatasetFile[] {
  const out: DatasetFile[] = [];
  (function walk(n: DatasetTreeNode) {
    for (const f of n.files) out.push(f);
    for (const c of n.children) walk(c);
  })(node);
  return out;
}

/** Cheap fuzzy match: lowercase substring with a small bonus for
 *  matching the start of the basename. Good enough for ≤500 entries
 *  on a single keystroke. */
function score(query: string, text: string, basename?: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const i = t.indexOf(q);
  if (i < 0) return -1;
  let s = 100 - i; // earlier match → higher score
  if (basename) {
    const b = basename.toLowerCase();
    if (b.startsWith(q)) s += 50;
    if (b === q) s += 100;
  }
  return s;
}

function rank(query: string, data: Dataset): Result[] {
  if (!query.trim()) {
    // Default suggestions: every tab + icon route.
    return NAV_TARGETS.map((t) => ({
      type: 'tab' as const,
      label: t.label,
      detail: t.href,
      href: t.href,
      score: 0,
    }));
  }
  const out: Result[] = [];
  // Tabs
  for (const t of NAV_TARGETS) {
    const s = score(query, t.label, t.label);
    if (s >= 0) out.push({ type: 'tab', label: t.label, detail: t.href, href: t.href, score: s + 25 /* slight tab boost */ });
  }
  // Files
  for (const f of flattenFiles(data.tree)) {
    const s = score(query, f.path, f.name);
    if (s >= 0) {
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      out.push({
        type: 'file',
        label: f.name,
        detail: dir || '·',
        href: `/files?p=${encodeURIComponent(f.path)}`,
        score: s,
      });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 50);
}

/* ─────────────────────────────────────────────────────────────────
 * Visual treatment.
 * ─────────────────────────────────────────────────────────────── */
const overlay = css({
  position: 'fixed',
  inset: '0',
  zIndex: '60',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  paddingTop: 'calc(var(--nav-h) + var(--space-4))',
  background: 'color-mix(in oklab, var(--bg) 64%, transparent)',
  backdropFilter: 'blur(4px)',
  WebkitBackdropFilter: 'blur(4px)',
});

/* The panel itself: a fixed-width column anchored top-center. Same
   editorial language as the rest of the system: hairlines, mono input,
   no rounded corners, soft glass surface. */
const panel = css({
  width: 'min(92vw, 640px)',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  /* Subtle elevation via a single hairline shadow — no card-y shadow. */
  boxShadow: '0 1px 0 var(--hairline), 0 12px 24px color-mix(in oklab, var(--fg) 8%, transparent)',
  display: 'flex',
  flexDirection: 'column',
  maxHeight: '70vh',
});

const inputWrap = css({
  display: 'flex',
  alignItems: 'baseline',
  gap: 'var(--space-3)',
  paddingInline: 'var(--space-5)',
  paddingBlock: 'var(--space-4)',
  borderBottom: '1px solid var(--hairline)',
});

const inputPrompt = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
});

const inputEl = css({
  flex: '1',
  border: 'none',
  outline: 'none',
  background: 'transparent',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-16)',
  color: 'var(--fg)',
  caretColor: 'var(--accent)',
  '&::placeholder': {
    color: 'var(--fg-faint)',
    fontStyle: 'italic',
  },
});

const hintRow = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
  display: 'inline-flex',
  gap: 'var(--space-3)',
});

const list = css({
  listStyle: 'none',
  margin: '0',
  padding: '0',
  overflowY: 'auto',
  flex: '1',
});

const row = css({
  display: 'grid',
  gridTemplateColumns: '52px minmax(0, 1fr) auto',
  alignItems: 'baseline',
  gap: 'var(--space-3)',
  paddingInline: 'var(--space-5)',
  paddingBlock: 'var(--space-3)',
  borderBottom: '1px solid var(--hairline)',
  cursor: 'pointer',
  '&:hover': { background: 'var(--highlight-faint)' },
});

const rowActive = css({
  background: 'var(--highlight-soft)',
  boxShadow: 'inset 2px 0 0 0 var(--accent)',
});

const typeTag = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  fontWeight: '500',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
});

const tagFile = css({ color: 'var(--fg-muted)' });
const tagTab = css({ color: 'var(--accent)' });

const labelCell = css({
  display: 'block',
  fontFamily: 'var(--font-display)',
  fontSize: 'var(--fs-14)',
  fontWeight: '500',
  color: 'var(--fg)',
});

const detailCell = css({
  display: 'block',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg-subtle)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  marginTop: '2px',
});

const kbdCell = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  color: 'var(--fg-faint)',
  letterSpacing: '0.06em',
});

const empty = css({
  paddingInline: 'var(--space-5)',
  paddingBlock: 'var(--space-6)',
  textAlign: 'center',
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-13)',
  color: 'var(--fg-muted)',
});

const footRow = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingInline: 'var(--space-5)',
  paddingBlock: 'var(--space-3)',
  borderTop: '1px solid var(--hairline)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
});

const kbd = css({
  paddingInline: '6px',
  paddingBlock: '2px',
  border: '1px solid var(--border)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  marginInline: '4px',
});

/* Stable ids wiring the combobox/listbox relationship (W3C APG
   autocomplete-list pattern). The input is the `combobox`, the result
   <ul> is the `listbox`, and each <li> is an `option` whose id the
   input points at via `aria-activedescendant` (virtual focus — real
   DOM focus stays in the input). Only one palette exists at a time, so
   module-static ids are unambiguous. */
const LISTBOX_ID = 'cmdk-listbox';
const optionId = (i: number) => `cmdk-option-${i}`;

export function CommandPalette(handle: Handle<PaletteProps>) {
  // Closure state.
  let open = false;
  let query = '';
  let selectedIdx = 0;
  let inputRef: HTMLInputElement | null = null;
  let cachedResults: Result[] = [];

  function recompute() {
    cachedResults = rank(query, handle.props.data);
    if (selectedIdx >= cachedResults.length) selectedIdx = 0;
  }

  function show() {
    if (open) return;
    open = true;
    query = '';
    selectedIdx = 0;
    void handle.update();
    // Focus input on next tick (after render).
    setTimeout(() => inputRef?.focus(), 0);
  }

  function hide() {
    if (!open) return;
    open = false;
    void handle.update();
  }

  function commit(idx?: number) {
    const i = idx ?? selectedIdx;
    const r = cachedResults[i];
    if (!r) return;
    hide();
    navigate(r.href);
  }

  function onGlobalKey(e: KeyboardEvent) {
    if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (open) hide();
      else show();
      return;
    }
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      hide();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (cachedResults.length === 0) return;
      selectedIdx = (selectedIdx + 1) % cachedResults.length;
      void handle.update();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (cachedResults.length === 0) return;
      selectedIdx = (selectedIdx - 1 + cachedResults.length) % cachedResults.length;
      void handle.update();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
      return;
    }
  }

  document.addEventListener('keydown', onGlobalKey);
  handle.signal.addEventListener('abort', () => document.removeEventListener('keydown', onGlobalKey));

  // Close when route changes (so the palette doesn't linger after Enter).
  const onNav = () => hide();
  window.addEventListener('factstack:nav', onNav);
  handle.signal.addEventListener('abort', () => window.removeEventListener('factstack:nav', onNav));

  return () => {
    if (!open) return null;
    recompute();
    return (
      <div
        role="dialog"
        aria-label="Command palette"
        mix={[
          overlay,
          on<HTMLDivElement>('click', (e) => {
            // Close when clicking the dimmed backdrop, not the panel.
            if (e.target === e.currentTarget) hide();
          }),
        ]}
      >
        <div mix={panel}>
          <div mix={inputWrap}>
            <span aria-hidden="true" mix={inputPrompt}>{'>'}</span>
            <input
              type="text"
              role="combobox"
              placeholder="Jump to a tab or a file…"
              value={query}
              aria-label="Search"
              aria-autocomplete="list"
              aria-expanded={cachedResults.length > 0 ? 'true' : 'false'}
              aria-controls={cachedResults.length > 0 ? LISTBOX_ID : undefined}
              aria-activedescendant={cachedResults.length > 0 ? optionId(selectedIdx) : undefined}
              autocomplete="off"
              spellcheck={false}
              mix={[
                inputEl,
                /* `ref()` mixin captures the node + an AbortSignal so
                   the binding clears automatically when the input
                   unmounts (every palette close). */
                ref<HTMLInputElement>((node) => { inputRef = node; }),
                on<HTMLInputElement>('input', (e) => {
                  const t = e.currentTarget;
                  query = t?.value ?? '';
                  selectedIdx = 0;
                  void handle.update();
                }),
              ]}
            />
            <span mix={hintRow}>
              <span>{cachedResults.length} {cachedResults.length === 1 ? 'match' : 'matches'}</span>
            </span>
          </div>

          {cachedResults.length === 0 ? (
            <div mix={empty}>
              No tabs or files match{' '}
              <span mix={css({ fontFamily: 'var(--font-mono)' })}>"{query}"</span>.
              Try a partial filename, a folder name, or one of the tab names.
            </div>
          ) : (
            <ul id={LISTBOX_ID} role="listbox" aria-label="Results" mix={list}>
              {cachedResults.map((r, i) => (
                <li
                  key={`${r.type}:${r.href}:${i}`}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === selectedIdx ? 'true' : 'false'}
                  mix={[
                    row,
                    i === selectedIdx ? rowActive : null,
                    on('click', () => commit(i)),
                  ]}
                >
                  <span mix={[typeTag, r.type === 'tab' ? tagTab : tagFile]}>
                    {r.type === 'tab' ? 'TAB' : 'FILE'}
                  </span>
                  <div mix={css({ minWidth: '0' })}>
                    <span mix={labelCell}>{r.label}</span>
                    <span mix={detailCell}>{r.detail}</span>
                  </div>
                  <span mix={kbdCell}>{i === selectedIdx ? '↵' : ''}</span>
                </li>
              ))}
            </ul>
          )}

          <div mix={footRow}>
            <span><span mix={kbd}>↑</span><span mix={kbd}>↓</span> navigate</span>
            <span><span mix={kbd}>↵</span> open</span>
            <span><span mix={kbd}>Esc</span> close</span>
          </div>
        </div>
      </div>
    );
  };
}
