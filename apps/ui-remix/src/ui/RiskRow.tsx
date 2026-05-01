/**
 * RiskRow — single row in the Risks panel.
 *
 * Layout: severity-marker | message + meta | jump-to-source
 * No card box; rows live inside `<RuledTable>`-style hairlines.
 *
 * The "leading severity rule" is a short colored vertical bar at the
 * left, NOT a colored fill or rounded badge. Reads like a margin mark
 * on a copy-edited document.
 */
import type { Handle } from '@remix-run/ui';
import { css } from '@remix-run/ui';

type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

interface RiskRowProps {
  severity: Severity;
  /** Stable rule id, e.g. `aws-access-key`. */
  rule: string;
  /** Category, e.g. `secret`, `license`, `broken-import`. */
  category: string;
  /** Plain-English summary. */
  message: string;
  /** Optional `path:line` source pointer. */
  source?: string | undefined;
  /** Optional redacted preview, mono. */
  preview?: string | undefined;
}

const SEV_COLOR: Record<Severity, string> = {
  critical: 'var(--danger)',
  high:     'var(--warn)',
  medium:   'var(--info)',
  low:      'var(--fg-muted)',
  info:     'var(--fg-subtle)',
};

const wrap = css({
  display: 'grid',
  gridTemplateColumns: '4px 1fr auto',
  columnGap: 'var(--space-4)',
  paddingBlock: 'var(--space-4)',
  borderBottom: '1px solid var(--hairline)',
  alignItems: 'baseline',
});

const bar = (color: string) => css({
  alignSelf: 'stretch',
  background: color,
  width: '4px',
  marginTop: '4px',
  marginBottom: '4px',
});

const messageCol = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-1)',
  minWidth: '0',
});

const messageStyle = css({
  fontSize: 'var(--fs-14)',
  fontWeight: '500',
  color: 'var(--fg)',
  lineHeight: '1.4',
});

const metaStyle = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg-muted)',
  letterSpacing: '0.02em',
});

const previewStyle = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg-subtle)',
  background: 'var(--code-bg)',
  paddingInline: 'var(--space-2)',
  paddingBlock: '2px',
  marginTop: 'var(--space-1)',
  display: 'inline-block',
  alignSelf: 'flex-start',
});

const sevTag = (color: string) => css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color,
  fontWeight: '500',
  whiteSpace: 'nowrap',
  paddingTop: 'var(--space-1)',
});

export function RiskRow(_h: Handle<RiskRowProps>) {
  return ({ severity, rule, category, message, source, preview }: RiskRowProps) => {
    const c = SEV_COLOR[severity];
    return (
      <div mix={wrap}>
        <div mix={bar(c)} aria-hidden="true" />
        <div mix={messageCol}>
          <span mix={messageStyle}>{message}</span>
          <span mix={metaStyle}>
            {category} · {rule}
            {source && (
              <>
                {' · '}
                <span mix={css({ color: 'var(--fg-subtle)' })}>{source}</span>
              </>
            )}
          </span>
          {preview && <code mix={previewStyle}>{preview}</code>}
        </div>
        <div mix={sevTag(c)}>{severity}</div>
      </div>
    );
  };
}
