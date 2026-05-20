/**
 * CyclesPanel — surface dependency loops from the SCC analysis.
 *
 * Each cycle below means the listed files mutually import each other.
 * Loops force the whole group to rebuild together and make the layer
 * a fiction — they're the first thing to break, hence the prominent
 * accent-danger treatment at the top of the Graph view.
 *
 * Returns null when there are no cycles so the parent can do
 * `<CyclesPanel cycles={cycles} />` without conditional wrapping. Less
 * code at the call site, same visual outcome.
 */
import type { Handle } from '@remix-run/ui';
import { css } from '@remix-run/ui';
import { Section } from '../Section.tsx';

interface CyclesPanelProps {
  cycles: ReadonlyArray<ReadonlyArray<string>>;
}

const intro = css({
  color: 'var(--fg-muted)',
  maxWidth: '60ch',
  marginBottom: 'var(--space-5)',
  lineHeight: '1.6',
});

const cycleHeader = css({
  display: 'flex',
  alignItems: 'baseline',
  gap: 'var(--space-3)',
  paddingBlock: 'var(--space-3)',
  borderBottom: '1px solid var(--hairline)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--danger)',
});

const cycleList = css({
  listStyle: 'none',
  margin: '0',
  padding: '0',
  paddingLeft: 'var(--space-4)',
  borderLeft: '2px solid var(--danger)',
  marginTop: 'var(--space-3)',
  marginBottom: 'var(--space-5)',
});

const cycleItem = css({
  paddingBlock: '4px',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
});

const fileLink = css({
  color: 'var(--fg)',
  '&:hover': { color: 'var(--accent)', textDecoration: 'underline', textUnderlineOffset: '3px' },
});

export function CyclesPanel(_h: Handle<CyclesPanelProps>) {
  return ({ cycles }: CyclesPanelProps) => {
    if (cycles.length === 0) return null;
    return (
      <Section label="Cycles" title={`${cycles.length} dependency loop${cycles.length === 1 ? '' : 's'}`}>
        <p mix={intro}>
          Each cycle below means the listed files mutually import each
          other. Loops force the whole group to rebuild together and
          make the layer a fiction. Break the weakest link first.
        </p>
        {cycles.map((c, i) => (
          <div key={i}>
            <div mix={cycleHeader}>
              Cycle {i + 1} · {c.length} {c.length === 1 ? 'node (self-loop)' : 'nodes'}
            </div>
            <ul mix={cycleList}>
              {c.map((p) => (
                <li key={p} mix={cycleItem}>
                  <a href={`/files?p=${encodeURIComponent(p)}`} mix={fileLink}>{p}</a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </Section>
    );
  };
}
