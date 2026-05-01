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

const wrap = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-3)',
  flex: '1',
  overflowX: 'auto',
  scrollbarWidth: 'none',
});

const link = css({
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'baseline',
  gap: 'var(--space-2)',
  padding: 'var(--space-3) 0',
  textDecoration: 'none',
  color: 'var(--fg-muted)',
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-12)',
  fontWeight: '500',
  letterSpacing: '0.04em',
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

const portingMark = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  color: 'var(--fg-faint)',
  marginLeft: 'var(--space-1)',
  /* Vertical-align baseline so the ° sits like a footnote marker. */
  verticalAlign: 'super',
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
                <span aria-label="porting" mix={portingMark}>°</span>
              )}
              {isActive && <span aria-hidden="true" mix={ruleActive} />}
            </a>
          );
        })}
      </nav>
    );
  };
}
