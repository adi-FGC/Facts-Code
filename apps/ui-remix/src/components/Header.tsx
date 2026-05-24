/**
 * Top navigation: brand · project chip · NumberedNav.
 *
 * The header is the only piece of chrome that gets `.glass`. Per
 * design_spec.md §2: glass for chrome, paper for content.
 */
import type { Handle } from 'remix/ui';
import { css } from 'remix/ui';
import type { Dataset } from '../lib/loadArtifacts.ts';
import { NumberedNav } from '../ui/NumberedNav.tsx';
import { ThemeToggle } from '../ui/ThemeToggle.tsx';
import { ReanalyzeButton } from '../ui/ReanalyzeButton.tsx';
import { OpenButton } from '../ui/OpenButton.tsx';
import { SourceChip } from '../ui/SourceChip.tsx';

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

/* The project chip got promoted to a real component (SourceChip) when
 * recents landed — it now reflects the actual scan source (local
 * folder, GitHub repo, or fall-through project name) and acts as a
 * second click target for the picker. The CSS that lived here moved
 * with the component. */

export function Header(_handle: Handle<HeaderProps>) {
  return ({ data }: HeaderProps) => {
    const root = data.project.root.replace(/\\/g, '/');
    return (
      <header class="glass" role="banner" mix={wrap}>
        <div mix={brand}>
          <span mix={brandMark}>FACTS</span>
        </div>
        <NumberedNav />
        <SourceChip projectName={data.project.name} projectRoot={root} />
        <div mix={rightCluster}>
          {/* Open is the entry point for in-browser scans (local dirs +
              GitHub URLs). Sits left of Re-analyze because it's the
              "load a different project" affordance, while Re-analyze is
              the "refresh THIS project" affordance — different verbs,
              ordered by reach. */}
          <OpenButton />
          <ReanalyzeButton />
          <ThemeToggle />
        </div>
      </header>
    );
  };
}
