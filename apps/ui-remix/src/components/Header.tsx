/**
 * Top navigation: brand · project chip · NumberedNav.
 *
 * The header is the only piece of chrome that gets `.glass`. Per
 * design_spec.md §2: glass for chrome, paper for content.
 */
import type { Handle } from '@remix-run/ui';
import { css } from '@remix-run/ui';
import type { Dataset } from '../lib/loadArtifacts.ts';
import { NumberedNav } from '../ui/NumberedNav.tsx';

interface HeaderProps {
  data: Dataset;
}

const wrap = css({
  display: 'grid',
  gridTemplateColumns: 'auto 1fr auto',
  alignItems: 'center',
  columnGap: 'var(--space-6)',
  paddingInline: 'var(--gutter)',
  borderRadius: '0',
  zIndex: '50',
});

const brand = css({
  display: 'flex',
  alignItems: 'baseline',
  gap: 'var(--space-3)',
  whiteSpace: 'nowrap',
});

const brandMark = css({
  fontFamily: 'var(--font-display)',
  fontSize: 'var(--fs-20)',
  fontWeight: '700',
  letterSpacing: '-0.03em',
  color: 'var(--fg)',
  fontVariationSettings: '"opsz" 20',
});

const brandSub = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
});

const projectChip = css({
  display: 'inline-flex',
  alignItems: 'baseline',
  gap: 'var(--space-3)',
  paddingInline: 'var(--space-3)',
  paddingBlock: 'var(--space-1)',
  borderLeft: '1px solid var(--border)',
  minWidth: '0',
  maxWidth: '38ch',
});

const projectName = css({
  fontFamily: 'var(--font-display)',
  fontWeight: '600',
  fontSize: 'var(--fs-14)',
  color: 'var(--fg)',
  letterSpacing: '-0.01em',
  whiteSpace: 'nowrap',
});

const projectRoot = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg-subtle)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});

export function Header(_handle: Handle<HeaderProps>) {
  return ({ data }: HeaderProps) => {
    const root = data.project.root.replace(/\\/g, '/');
    return (
      <header class="glass" role="banner" mix={wrap}>
        <div mix={brand}>
          <span mix={brandMark}>FACTS</span>
          <span mix={brandSub}>v0.1 · Remix UI</span>
        </div>
        <NumberedNav />
        <div mix={projectChip} title={root}>
          <span mix={projectName}>{data.project.name}</span>
          <span mix={projectRoot} dir="rtl">{root}</span>
        </div>
      </header>
    );
  };
}
