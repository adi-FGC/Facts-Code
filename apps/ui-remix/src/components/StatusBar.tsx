/**
 * Status bar — bottom hairline strip.
 *
 * Reads as a printer's colophon: just the meta. Health on the right
 * where the eye lands last. No icons, no chips with backgrounds.
 */
import type { Handle } from '@remix-run/ui';
import { css } from '@remix-run/ui';
import type { Dataset } from '../lib/loadArtifacts.ts';

interface StatusBarProps {
  data: Dataset;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

const wrap = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-5)',
  paddingInline: 'var(--gutter)',
  height: 'var(--status-h)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  fontVariantNumeric: 'tabular-nums',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
  borderTop: '1px solid var(--hairline)',
  background: 'var(--bg)',
});

const k = css({ color: 'var(--fg-subtle)' });
const v = css({ color: 'var(--fg-muted)' });

const sep = css({
  width: '1px',
  height: '12px',
  background: 'var(--hairline)',
});

const danger = css({ color: 'var(--danger)' });
const warn = css({ color: 'var(--warn)' });

export function StatusBar(_handle: Handle<StatusBarProps>) {
  return ({ data }: StatusBarProps) => {
    const s = data.stats;
    const h = data.summary.health;
    // No `.glass` here — status bar is a colophon strip, not chrome.
    // Glass is reserved for floating/elevated surfaces per design_spec.md §2.
    return (
      <footer role="contentinfo" mix={wrap}>
        <span mix={k}>files</span><span mix={v}>{fmt(s.files)}</span>
        <span aria-hidden="true" mix={sep} />
        <span mix={k}>loc</span><span mix={v}>{fmt(s.loc)}</span>
        <span aria-hidden="true" mix={sep} />
        <span mix={k}>tokens</span><span mix={v}>{fmt(s.tokens)}</span>
        <span mix={css({ flex: '1' })} />
        <span mix={k}>broken</span>
        <span mix={h.broken > 0 ? danger : v}>{fmt(h.broken)}</span>
        <span aria-hidden="true" mix={sep} />
        <span mix={k}>todos</span>
        <span mix={h.todos > 0 ? warn : v}>{fmt(h.todos)}</span>
        <span aria-hidden="true" mix={sep} />
        <span mix={k}>secrets</span>
        <span mix={h.secrets > 0 ? danger : v}>{fmt(h.secrets)}</span>
      </footer>
    );
  };
}
