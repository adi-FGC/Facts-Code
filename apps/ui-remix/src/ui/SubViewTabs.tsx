/**
 * SubViewTabs — a secondary tab bar that switches between full route
 * components inside one top-level tab.
 *
 * The v0.9 IA consolidation collapsed 14 tabs into 7 by grouping related
 * pages: Architecture = Graph | Flow | Routes, Security = Risks | Secrets
 * | Vulnerabilities, Files = Files | Packages. Rather than merge the
 * bodies of those routes (each is a self-contained `(handle) => () =>
 * <ContentWithMargin>` page), this switcher hosts them as-is and flips
 * between them.
 *
 * Deep-link preservation: each view may declare a legacy `path`
 * (`/graph`, `/risks`, …). `activeTab()` in lib/routes.ts already maps
 * those old URLs onto the new parent tab; this component then reads
 * `location.pathname` on mount to pre-select the matching view, so an
 * old bookmark to `/credentials` still lands on the Secrets view inside
 * Security. After mount, the choice persists to localStorage.
 *
 * The bar aligns to the same `--content-max` + `--gutter` insets the
 * inner pages use, and a negative top-margin on the inner view tightens
 * the gap that the page's own `--space-12` block padding would leave.
 */
import type { Handle, RemixNode } from 'remix/ui';
import { css, on } from 'remix/ui';
import { moveRoving } from '../lib/roving.ts';
import type { Dataset } from '../lib/loadArtifacts.ts';

export interface SubView {
  key: string;
  label: string;
  /** Legacy deep-link path (e.g. '/graph') so old URLs select this view. */
  path?: string;
  render: (data: Dataset) => RemixNode;
}

interface SubViewTabsProps {
  data: Dataset;
  /** localStorage key for the remembered view. Unique per parent tab. */
  storageKey: string;
  ariaLabel: string;
  views: ReadonlyArray<SubView>;
}

function readStored(key: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStored(key: string, val: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, val);
  } catch {
    /* private mode / quota — non-fatal, the choice just won't persist */
  }
}

/* ─────────── styles ─────────── */

const bar = css({
  maxWidth: 'var(--content-max)',
  marginInline: 'auto',
  paddingInline: 'var(--gutter)',
  paddingTop: 'var(--space-6)',
  paddingBottom: 'var(--space-5)',
  borderBottom: '1px solid var(--hairline)',
});

/* Pull the inner page up so its --space-12 top padding doesn't leave a
   cavernous gap under the bar. Net gap ≈ --space-6. */
const innerLift = css({
  marginTop: 'calc(var(--space-6) - var(--space-12))',
});

const segWrap = css({
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'stretch',
  border: '1px solid var(--border)',
  height: '34px',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
});

const seg = css({
  display: 'inline-flex',
  alignItems: 'center',
  flex: '1 0 0',
  justifyContent: 'center',
  minWidth: '104px',
  paddingInline: 'var(--space-4)',
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

const segActive = css({ color: 'var(--fg)', background: 'var(--accent-soft)' });

const rail = css({
  position: 'absolute',
  bottom: '0',
  left: '0',
  height: '2px',
  background: 'var(--accent)',
  transition: 'transform 240ms var(--ease-out-quart)',
  pointerEvents: 'none',
});

/* ─────────── component ─────────── */

export function SubViewTabs(handle: Handle<SubViewTabsProps>) {
  const { views, storageKey } = handle.props;

  /* Initial view: legacy-path match wins (deep link), then the stored
     choice, then the first view. */
  const pathMatch =
    typeof location !== 'undefined'
      ? views.find((v) => v.path && v.path === location.pathname)?.key
      : undefined;
  const stored = readStored(storageKey);
  const validStored = views.some((v) => v.key === stored) ? (stored as string) : undefined;
  let active = pathMatch ?? validStored ?? views[0]!.key;

  function setActive(key: string) {
    if (key === active) return;
    active = key;
    writeStored(storageKey, key);
    void handle.update();
  }

  return () => {
    const { data, views, ariaLabel } = handle.props;
    const activeIdx = Math.max(0, views.findIndex((v) => v.key === active));
    const current = views[activeIdx] ?? views[0]!;
    return (
      <>
        <div mix={bar}>
          <div mix={[segWrap, on<HTMLDivElement>('keydown', (e) => { if (moveRoving((e as unknown as KeyboardEvent).key, e.currentTarget, views, active, setActive, 'tab')) e.preventDefault(); })]} role="tablist" aria-label={ariaLabel}>
            {views.map((v) => {
              const isActive = v.key === active;
              return (
                <button
                  key={v.key}
                  type="button"
                  role="tab"
                  aria-selected={isActive ? 'true' : 'false'}
                  tabIndex={isActive ? 0 : -1}
                  mix={[seg, isActive ? segActive : null, on('click', () => setActive(v.key))]}
                >
                  {v.label}
                </button>
              );
            })}
            <span
              aria-hidden="true"
              mix={[rail, css({ width: `calc(100% / ${views.length})`, transform: `translateX(${activeIdx * 100}%)` })]}
            />
          </div>
        </div>
        <div mix={innerLift}>{current.render(data)}</div>
      </>
    );
  };
}
