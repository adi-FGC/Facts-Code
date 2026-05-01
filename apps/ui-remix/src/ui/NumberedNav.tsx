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
import type { Handle } from '@remix-run/ui';
import { css } from '@remix-run/ui';
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
  overflowX: 'auto',
  scrollbarWidth: 'none',     /* Firefox */
  /* WebKit: pseudo-element selector escape hatch for the css() runtime. */
  '&::-webkit-scrollbar': { display: 'none', width: '0', height: '0' },
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
  fontSize: 'var(--fs-12)',
  fontWeight: '500',
  letterSpacing: '0.03em',             /* tighter than 0.04em */
  textTransform: 'uppercase',
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

export function NumberedNav(_h: Handle<{}>) {
  return () => {
    const current = activeTab(location.pathname);
    return (
      <nav role="tablist" aria-label="Primary navigation" mix={wrap}>
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
