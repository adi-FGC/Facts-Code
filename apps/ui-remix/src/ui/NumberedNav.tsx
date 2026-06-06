/**
 * NumberedNav — the broadsheet-style global tab row.
 *
 *   01 OVERVIEW · 02 GRAPH · 03 DAG · 04 FILES · …
 *
 * The numbering references classified-document section indices. The
 * active section's number flips to the accent color; the active label
 * picks up an underline rule. Tabs are flagged "porting" with a
 * trailing degree-mark "°" instead of a colored dot — quieter, reads
 * as editorial annotation rather than a status badge.
 */
import type { Handle } from 'remix/ui';
import { css, ref } from 'remix/ui';
import { TABS, activeTab } from '../lib/routes.ts';

/**
 * Wrap is horizontally-scrollable below the breakpoint where all 11
 * tabs fit. The scrollbar is intentionally hidden — it eats vertical
 * space inside the 56px nav row and the global app.css styled scrollbar
 * is too heavy for chrome. Scroll still works via swipe / wheel /
 * keyboard. The leading className lets the WebKit ::-webkit-scrollbar
 * suppression in app.css target this element specifically.
 */
const wrap = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2)',     /* tightened from --space-3 (12 → 8px) */
  flex: '1',
  /* Audit M5 fix: without min-width: 0, the flex child refuses to
     shrink below its content width, which lets the project chip push
     into the active tab and clip its label (visible as "06 ROUTE"
     instead of "06 ROUTES" at 1280px). min-width:0 lets the nav
     yield first; the scroll affordance handles the overflow. */
  minWidth: '0',
  overflowX: 'auto',
  /* CSS spec quirk: setting overflow-x: auto while overflow-y is its
     default (visible) causes the browser to compute overflow-y to auto
     — surfacing a sliver of vertical scrollbar when the active tab's
     `bottom: -1px` underline rule pushes the box's painted bounds past
     the container by ~1px. Pinning overflow-y to hidden suppresses it
     without losing the horizontal scroll affordance. */
  overflowY: 'hidden',
  scrollbarWidth: 'none',     /* Firefox */
  /* WebKit: pseudo-element selector escape hatch for the css() runtime. */
  '&::-webkit-scrollbar': { display: 'none', width: '0', height: '0' },
  /* Phone: the scrollbar is hidden, so fade both edges to signal the row
     scrolls. QA ISSUE-2 affordance — pairs with scroll-active-into-view. */
  '@media (max-width: 599px)': {
    maskImage: 'linear-gradient(to right, transparent, #000 14px, #000 calc(100% - 14px), transparent)',
    WebkitMaskImage: 'linear-gradient(to right, transparent, #000 14px, #000 calc(100% - 14px), transparent)',
  },
});

const link = css({
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'baseline',
  gap: '6px',                          /* was var(--space-2) (8px) */
  paddingTop: 'var(--space-3)',
  paddingBottom: 'var(--space-3)',
  paddingLeft: '4px',                  /* small tap target padding */
  paddingRight: '4px',
  textDecoration: 'none',
  color: 'var(--fg-muted)',
  fontFamily: 'var(--font-body)',
  /* Reduced from --fs-12 + uppercase to --fs-11 + sentence case.
     Uppercase made the nav read as "broadsheet section index" — the
     editorial typographic register, but loud at 11 tabs. Sentence
     case lets the labels read as labels and pairs better with the
     03 / 04 / 05 numerals (which already supply the "section index"
     metaphor). Letter-spacing drops in tandem: uppercase needs ~0.03em
     to stay legible; sentence case at the same tracking looks
     accidentally spaced out. */
  fontSize: 'var(--fs-11)',
  fontWeight: '500',
  letterSpacing: '0',
  textTransform: 'none',
  whiteSpace: 'nowrap',
  minHeight: '40px',
  transition: 'color var(--dur-quick) var(--ease-out-quart)',
});

const linkActive = css({
  color: 'var(--fg)',
});

const number = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  fontWeight: '500',
  letterSpacing: '0.06em',
  color: 'var(--fg-faint)',
  fontVariantNumeric: 'tabular-nums',
});
const numberActive = css({
  color: 'var(--accent)',
});

const ruleActive = css({
  position: 'absolute',
  left: '0',
  right: '0',
  bottom: '-1px',
  height: '2px',
  background: 'var(--accent)',
});

/* Porting indicator. Audit fix #2: a 4px dot sitting at the baseline,
   accent-tinted at low opacity, reads as a status flag rather than a
   typographic curio. The previous superscript ° was too small to
   register at the nav's text size. */
const portingMark = css({
  display: 'inline-block',
  width: '4px',
  height: '4px',
  borderRadius: '50%',
  background: 'color-mix(in oklab, var(--accent) 55%, transparent)',
  marginLeft: '6px',
  alignSelf: 'center',
  flex: 'none',
});

export function NumberedNav(handle: Handle<{}>) {
  /* Follow client-side navigation so the active-tab number + underline track
     the URL. The app no longer re-renders from the root on nav (that blanked
     the tree); instead each pathname-reading component owns its own nav
     subscription + handle.update(). See App.tsx RouteView. */
  let navEl: HTMLElement | null = null;

  /* Keep the active tab visible when the row overflows (phones): center
     it in the scroll container so its neighbours stay one swipe away. On
     desktop the row fits, so scrollIntoView is a no-op. */
  function scrollActiveIntoView() {
    if (!navEl) return;
    const active = navEl.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!active) return;
    /* Center the active tab inside the nav's OWN horizontal scroll by
       setting scrollLeft directly. scrollIntoView() would also scroll the
       page vertically (it nudges every scrollable ancestor), which pushed
       the brand + controls row off the top on phones. The browser clamps
       scrollLeft to its valid range, so no manual bounds needed. */
    const navRect = navEl.getBoundingClientRect();
    const tabRect = active.getBoundingClientRect();
    navEl.scrollLeft += (tabRect.left - navRect.left) - (navRect.width - tabRect.width) / 2;
  }

  const onNav = () => {
    void handle.update();
    /* rAF so the patched DOM (new active tab) exists before we scroll. */
    requestAnimationFrame(scrollActiveIntoView);
  };
  window.addEventListener('popstate', onNav);
  window.addEventListener('factstack:nav', onNav);
  handle.signal.addEventListener('abort', () => {
    window.removeEventListener('popstate', onNav);
    window.removeEventListener('factstack:nav', onNav);
  });
  return () => {
    const current = activeTab(location.pathname);
    return (
      <nav
        role="tablist"
        aria-label="Primary navigation"
        mix={[wrap, ref<HTMLElement>((node) => { navEl = node; scrollActiveIntoView(); })]}
      >
        {TABS.map((t, i) => {
          const isActive = t.key === current;
          const idx = String(i + 1).padStart(2, '0');
          return (
            <a
              key={t.key}
              href={t.href}
              role="tab"
              aria-selected={isActive ? 'true' : 'false'}
              aria-current={isActive ? 'page' : undefined}
              title={t.ported ? t.label : `${t.label} — porting from legacy prototype`}
              mix={[link, isActive ? linkActive : null]}
            >
              <span mix={[number, isActive ? numberActive : null]}>{idx}</span>
              <span>{t.label}</span>
              {!t.ported && (
                <span aria-label="porting" role="img" mix={portingMark} />
              )}
              {isActive && <span aria-hidden="true" mix={ruleActive} />}
            </a>
          );
        })}
      </nav>
    );
  };
}
