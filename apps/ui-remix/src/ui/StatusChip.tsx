/**
 * StatusChip — file/risk/route status indicator.
 *
 * No backgrounds, no boxes. A 2px colored leading bar + a tracked
 * mono label. Reads as a flag, not a button. Replaces the
 * pill-with-icon pattern.
 */
import type { Handle } from 'remix/ui';
import { css } from 'remix/ui';

type Kind = 'ok' | 'broken' | 'stale' | 'parse_error' | 'high' | 'critical' | 'medium' | 'low' | 'info';

interface StatusChipProps {
  kind: Kind;
  /** Override the displayed text. Defaults to the kind. */
  label?: string;
}

const KIND_LABEL: Record<Kind, string> = {
  ok: 'OK',
  broken: 'BROKEN',
  stale: 'STALE',
  parse_error: 'PARSE',
  high: 'HIGH',
  critical: 'CRITICAL',
  medium: 'MEDIUM',
  low: 'LOW',
  info: 'INFO',
};

const KIND_COLOR: Record<Kind, string> = {
  ok: 'var(--ok)',
  broken: 'var(--danger)',
  stale: 'var(--warn)',
  parse_error: 'var(--danger)',
  high: 'var(--warn)',
  critical: 'var(--danger)',
  medium: 'var(--info)',
  low: 'var(--fg-muted)',
  info: 'var(--info)',
};

export function StatusChip(handle: Handle<StatusChipProps>) {
  return () => {
    const { kind, label } = handle.props;
    const c = KIND_COLOR[kind];
    return (
      <span
        role="status"
        mix={css({
          display: 'inline-flex',
          alignItems: 'baseline',
          gap: '6px',
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--fs-10)',
          fontWeight: '500',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: c,
          whiteSpace: 'nowrap',
        })}
      >
        <span
          aria-hidden="true"
          mix={css({
            display: 'inline-block',
            width: '8px',
            height: '2px',
            background: c,
            transform: 'translateY(-3px)',
          })}
        />
        {label ?? KIND_LABEL[kind]}
      </span>
    );
  };
}
