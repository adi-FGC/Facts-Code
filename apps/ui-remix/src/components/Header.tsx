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
import { ThemeToggle } from '../ui/ThemeToggle.tsx';
import { ReanalyzeButton } from '../ui/ReanalyzeButton.tsx';

interface HeaderProps {
  data: Dataset;
}

const wrap = css({
  display: 'grid',
  /* brand · nav · project chip · theme toggle */
  gridTemplateColumns: 'auto 1fr auto auto',
  alignItems: 'center',
  columnGap: 'var(--space-5)',     /* tightened from --space-6 */
  paddingInline: 'var(--gutter)',
  borderRadius: '0',
  zIndex: '50',
});

const rightCluster = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--space-3)',
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

/* Audit fix #8: chip is name-only at md and below; full path returns
   at lg+ where there's room. Same hairline-divider treatment but
   tighter. */
const projectChip = css({
  display: 'inline-flex',
  alignItems: 'baseline',
  gap: 'var(--space-3)',
  paddingInline: 'var(--space-3)',
  paddingBlock: 'var(--space-1)',
  borderLeft: '1px solid var(--border)',
  minWidth: '0',
  maxWidth: '32ch',
});

const projectRootResponsive = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg-subtle)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  '@media (max-width: 1279px)': {
    display: 'none',
  },
});

const projectName = css({
  fontFamily: 'var(--font-display)',
  fontWeight: '600',
  fontSize: 'var(--fs-14)',
  color: 'var(--fg)',
  letterSpacing: '-0.01em',
  whiteSpace: 'nowrap',
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
          <span mix={projectRootResponsive} dir="rtl">{root}</span>
        </div>
        <div mix={rightCluster}>
          <ReanalyzeButton />
          <ThemeToggle />
        </div>
      </header>
    );
  };
}
