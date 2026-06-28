/**
 * Panel UI kit — the impeccable, narrow-first vocabulary.
 *
 * Plain functions returning RemixNodes (not stateful components): all state
 * lives in App.tsx, so these stay pure and cheap. Everything styles through
 * css() constructable stylesheets — zero inline style= — so the strict MV3
 * extension CSP (style-src 'self') is satisfied, dynamic bar widths included.
 *
 * Aesthetic: Bloomberg-navy + safety-orange (dark-first), hairlines over
 * cards, JetBrains Mono tabular numerals for every metric, Mona Sans for prose.
 */
import { css, on } from 'remix/ui';
import type { RemixNode } from 'remix/ui';

/* ─────────── tone helpers ─────────── */

export function sevTone(sev: string): string {
  switch (sev.toLowerCase()) {
    case 'critical': return 'var(--danger)';
    case 'high': return 'var(--danger)';
    case 'medium': case 'moderate': return 'var(--warn)';
    case 'low': return 'var(--fg-muted)';
    default: return 'var(--fg-faint)';
  }
}

export function gradeTone(grade?: string): string {
  switch ((grade ?? '').toUpperCase()) {
    case 'A': case 'B': return 'var(--ok)';
    case 'C': return 'var(--warn)';
    case 'D': case 'F': return 'var(--danger)';
    default: return 'var(--fg-muted)';
  }
}

/* ─────────── static classes ─────────── */

const kickerCls = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
});

export function kicker(text: string): RemixNode {
  return <div mix={kickerCls}>{text}</div>;
}

const sectionLabelCls = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  gap: 'var(--space-2)',
  padding: '0 var(--space-4)',
  marginTop: 'var(--space-6)',
  marginBottom: 'var(--space-2)',
});

export function sectionLabel(left: string, right?: string): RemixNode {
  return (
    <div mix={sectionLabelCls}>
      <span>{left}</span>
      {right !== undefined && <span>{right}</span>}
    </div>
  );
}

const emptyCls = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  color: 'var(--fg-faint)',
  padding: 'var(--space-5) var(--space-4)',
  borderTop: '1px solid var(--hairline)',
  borderBottom: '1px solid var(--hairline)',
});

export function emptyNote(text: string): RemixNode {
  return <div mix={emptyCls}>{text}</div>;
}

/* ─────────── shared layout ─────────── */

const scrollCls = css({
  flex: '1',
  overflowY: 'auto',
  overflowX: 'hidden',
  overscrollBehavior: 'contain',
  paddingBottom: 'var(--space-12)',
});

const blockCls = css({ padding: '0 var(--space-4)' });

const titleCls = css({
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-24)',
  fontWeight: '600',
  letterSpacing: '-0.02em',
  lineHeight: '1.14',
  color: 'var(--fg)',
  margin: 'var(--space-2) 0 var(--space-3)',
});

const ledeCls = css({
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-13)',
  color: 'var(--fg-muted)',
  lineHeight: '1.5',
  margin: '0 0 var(--space-4)',
});

/** Scrollable content region (the route body below the top bar). */
export function scrollRegion(body: RemixNode): RemixNode {
  return <div mix={scrollCls}>{body}</div>;
}

/** Full-bleed block with the standard horizontal inset. */
export function block(body: RemixNode): RemixNode {
  return <div mix={blockCls}>{body}</div>;
}

/** Route header: title + lede. */
export function head(title: string, lede: string): RemixNode {
  return (
    <div mix={blockCls}>
      <h1 mix={titleCls}>{title}</h1>
      <p mix={ledeCls}>{lede}</p>
    </div>
  );
}

/** Home hero header: mono kicker + title. */
export function heroHead(kickerText: string, title: string): RemixNode {
  return (
    <div mix={blockCls}>
      {kicker(kickerText)}
      <h1 mix={titleCls}>{title}</h1>
    </div>
  );
}

/** A lede-styled paragraph (accepts inline markup). */
export function para(body: RemixNode): RemixNode {
  return <p mix={ledeCls}>{body}</p>;
}

/* ─────────── proportional bar ─────────── */

const barTrack = css({
  height: '3px',
  background: 'var(--surface-3)',
  borderRadius: 'var(--r-pill)',
  overflow: 'hidden',
  marginTop: 'var(--space-1)',
});

export function bar(fraction: number, color = 'var(--accent)'): RemixNode {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  // Dynamic width via css() (a generated class), never inline style — CSP-clean.
  // Round to whole-% so the generated-class set is bounded at ≤101 (× a handful
  // of colors) and reused across rows/datasets, instead of churning a new class
  // per fractional width. Sub-pixel precision is invisible on a 3px bar.
  const fill = css({ height: '100%', borderRadius: 'var(--r-pill)', width: `${pct.toFixed(0)}%`, background: color });
  return (
    <div mix={barTrack}>
      <div mix={fill} />
    </div>
  );
}

/* ─────────── list row ─────────── */

const rowBtn = css({
  display: 'block',
  width: '100%',
  textAlign: 'left',
  border: 'none',
  borderBottom: '1px solid var(--hairline)',
  background: 'transparent',
  cursor: 'pointer',
  padding: 'var(--space-3) var(--space-4)',
  transition: 'background var(--dur-instant) var(--ease-out-quart)',
  '&:hover': { background: 'var(--highlight-faint, var(--accent-soft))' },
  '&:focus-visible': { background: 'var(--accent-soft)', outline: '2px solid var(--accent)', outlineOffset: '-2px' },
  '&:last-child': { borderBottom: 'none' },
});

const rowStatic = css({
  display: 'block',
  borderBottom: '1px solid var(--hairline)',
  padding: 'var(--space-3) var(--space-4)',
  '&:last-child': { borderBottom: 'none' },
});

const rowTop = css({
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 'var(--space-3)',
});

const rowName = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  color: 'var(--fg)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: '0',
});

const rowValue = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--fg-muted)',
  whiteSpace: 'nowrap',
  flexShrink: '0',
});

const rowSub = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  color: 'var(--fg-faint)',
  marginTop: '2px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

export interface ListRowOpts {
  name: string;
  value?: string;
  valueColor?: string;
  sub?: string;
  title?: string;
  fraction?: number;
  barColor?: string;
  onClick?: () => void;
  /** Stable key for keyed-list reconciliation when rendered inside a .map(). */
  key?: string;
}

export function listRow(o: ListRowOpts): RemixNode {
  const body = (
    <>
      <div mix={rowTop}>
        <span mix={rowName} {...(o.title ? { title: o.title } : {})}>{o.name}</span>
        {o.value !== undefined && (
          <span mix={[rowValue, ...(o.valueColor ? [css({ color: o.valueColor })] : [])]}>{o.value}</span>
        )}
      </div>
      {o.sub && <div mix={rowSub}>{o.sub}</div>}
      {o.fraction !== undefined && bar(o.fraction, o.barColor)}
    </>
  );
  return o.onClick
    ? <button type="button" key={o.key} mix={[rowBtn, on('click', o.onClick)]}>{body}</button>
    : <div key={o.key} mix={rowStatic}>{body}</div>;
}

/* ─────────── stat grid ─────────── */

const statGridCls = css({
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: '1px',
  background: 'var(--hairline)',
  border: '1px solid var(--hairline)',
  margin: '0 var(--space-4)',
});

const statCell = css({
  background: 'var(--bg)',
  padding: 'var(--space-3) var(--space-4)',
});

const statLabel = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
});

const statValue = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-20)',
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--fg)',
  lineHeight: '1.1',
  marginTop: '2px',
});

export interface Stat { label: string; value: string; tone?: string | undefined; }

export function statGrid(stats: Stat[]): RemixNode {
  return (
    <div mix={statGridCls}>
      {stats.map((s) => (
        <div mix={statCell} key={s.label}>
          <div mix={statLabel}>{s.label}</div>
          <div mix={[statValue, ...(s.tone ? [css({ color: s.tone })] : [])]}>{s.value}</div>
        </div>
      ))}
    </div>
  );
}

/* ─────────── pill ─────────── */

const pillCls = css({
  display: 'inline-block',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  padding: '2px 7px',
  borderRadius: 'var(--r-sm)',
  border: '1px solid var(--hairline)',
  color: 'var(--fg-muted)',
  whiteSpace: 'nowrap',
});

export function pill(text: string, tone?: string): RemixNode {
  return <span mix={[pillCls, ...(tone ? [css({ color: tone, borderColor: tone })] : [])]}>{text}</span>;
}

/* ─────────── buttons ─────────── */

const btnBase = css({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 'var(--space-2)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  height: '34px',
  padding: '0 var(--space-4)',
  borderRadius: 'var(--r-md)',
  cursor: 'pointer',
  border: '1px solid var(--border-strong)',
  background: 'transparent',
  color: 'var(--fg-muted)',
  transition: 'opacity var(--dur-instant), background var(--dur-instant), color var(--dur-instant)',
  '&:hover:not(:disabled)': { color: 'var(--fg)', background: 'var(--accent-soft)' },
  '&:disabled': { opacity: '0.45', cursor: 'not-allowed' },
});

const btnPrimary = css({
  border: '1px solid var(--accent)',
  background: 'var(--accent)',
  color: 'var(--accent-fg)',
  '&:hover:not(:disabled)': { opacity: '0.9', background: 'var(--accent)', color: 'var(--accent-fg)' },
});

export interface BtnOpts {
  label: RemixNode;
  onClick: () => void;
  kind?: 'primary' | 'ghost';
  full?: boolean;
  disabled?: boolean;
  title?: string;
}

export function btn(o: BtnOpts): RemixNode {
  return (
    <button
      type="button"
      {...(o.disabled ? { disabled: true } : {})}
      {...(o.title ? { title: o.title } : {})}
      mix={[
        btnBase,
        ...(o.kind === 'primary' ? [btnPrimary] : []),
        ...(o.full ? [css({ width: '100%' })] : []),
        on('click', () => { if (!o.disabled) o.onClick(); }),
      ]}
    >
      {o.label}
    </button>
  );
}

/* ─────────── spinner / progress ─────────── */

const spinKf = css({
  width: '14px',
  height: '14px',
  borderRadius: '50%',
  border: '2px solid var(--border-strong)',
  borderTopColor: 'var(--accent)',
  display: 'inline-block',
  animation: 'factstack-spin 0.7s linear infinite',
});

export function spinner(): RemixNode {
  return <span mix={spinKf} aria-hidden="true" />;
}

const progWrap = css({ padding: 'var(--space-5) var(--space-4)' });
const progLabel = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg-muted)',
  marginBottom: 'var(--space-3)',
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

export function progressBlock(label: string, fraction: number): RemixNode {
  return (
    <div mix={progWrap}>
      <div mix={progLabel}>{spinner()}<span>{label}</span></div>
      {bar(fraction)}
    </div>
  );
}
