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
import type { Handle } from 'remix/ui';
import { css } from 'remix/ui';

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
  /** v0.3.8 — original technical message before the CXO rewrite.
   *  Surfaces in a <details> disclosure so engineers can drop into
   *  rule-id-shaped grep without losing the editorial summary. */
  messageTechnical?: string | undefined;
}

const SEV_COLOR: Record<Severity, string> = {
  critical: 'var(--danger)',
  high:     'var(--warn)',
  medium:   'var(--info)',
  low:      'var(--fg-muted)',
  info:     'var(--fg-subtle)',
};

/* Audit fix #4: severity is encoded TWICE — colored bar on left + text
   tag on right — which is redundant. Dropped the right tag; the bar
   color + the section header above each group communicate severity
   already. Two columns now: bar | message. */
const wrap = css({
  display: 'grid',
  gridTemplateColumns: '4px 1fr',
  columnGap: 'var(--space-4)',
  paddingInline: 'var(--space-3)',
  marginInline: 'calc(var(--space-3) * -1)',
  paddingBlock: 'var(--space-4)',
  borderBottom: '1px solid var(--hairline)',
  alignItems: 'baseline',
  transition: 'background var(--dur-quick) var(--ease-out-quart)',
  '&:hover': {
    background: 'var(--highlight-faint)',
  },
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

export function RiskRow(_h: Handle<RiskRowProps>) {
  return ({ severity, rule, category, message, source, preview, messageTechnical }: RiskRowProps) => {
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
          {/* v0.3.8 — technical disclosure. Native <details> so it's
              keyboard-accessible and screen-reader friendly without
              needing closure state. Mono + dim so it doesn't compete
              with the CXO message. */}
          {messageTechnical && (
            <details
              mix={css({
                marginTop: 'var(--space-2)',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-10)',
                letterSpacing: '0.04em',
                color: 'var(--fg-faint)',
              })}
            >
              <summary
                mix={css({
                  cursor: 'pointer',
                  textTransform: 'uppercase',
                  letterSpacing: '0.14em',
                  '&:hover': { color: 'var(--accent)' },
                })}
              >
                Technical detail
              </summary>
              <p
                mix={css({
                  marginTop: '4px',
                  marginBottom: '0',
                  color: 'var(--fg-subtle)',
                  lineHeight: '1.5',
                })}
              >
                {messageTechnical}
              </p>
            </details>
          )}
        </div>
      </div>
    );
  };
}
