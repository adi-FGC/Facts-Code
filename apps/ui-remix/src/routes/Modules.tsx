/**
 * Modules — the F5 graph-analytics tab. Two lenses on the same deterministic
 * metrics the agent gets (importance = PageRank, community = label propagation):
 *
 *   - Key Files → every file ranked by graph centrality ("read these first").
 *   - Modules   → files clustered into communities ("what groups together").
 *
 * The metrics are computed once in @factstack/core and ride the dataset, so the
 * dashboard and the agent never disagree. When a dataset predates F5 (no
 * `nodeMetrics`), we show an explicit re-analyze prompt rather than a blank tab.
 */
import type { Handle } from 'remix/ui';
import { css } from 'remix/ui';
import type { Dataset } from '../lib/loadArtifacts.ts';
import { buildModuleView } from '../lib/moduleAnalysis.ts';
import { SubViewTabs } from '../ui/SubViewTabs.tsx';
import { Section } from '../ui/Section.tsx';
import { KeyFilesTable } from '../ui/modules/KeyFilesTable.tsx';
import { ModulesView } from '../ui/modules/ModulesView.tsx';

interface ModulesProps {
  data: Dataset;
}

const emptyText = css({
  fontSize: 'var(--fs-14)',
  color: 'var(--fg-muted)',
  maxWidth: '62ch',
  lineHeight: '1.6',
});

const code = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  background: 'var(--surface-2)',
  padding: '0.1em 0.4em',
  borderRadius: '4px',
});

export function Modules(handle: Handle<ModulesProps>) {
  return () => {
    const { data } = handle.props;
    // Derive once per render. The SubViewTabs callbacks close over this view
    // (it always passes the same `data` reference), so we avoid recomputing the
    // O(nodes+edges) aggregation a second time on mount.
    const view = buildModuleView(data);
    if (!view.hasMetrics) {
      return (
        <Section label="Modules" title="Graph analytics">
          <p mix={emptyText}>
            This dataset doesn't include graph analytics yet. Re-analyze the project
            with the latest FACTS (<span mix={code}>factstack analyze</span>) to
            populate file importance (PageRank centrality) and module clusters.
          </p>
        </Section>
      );
    }
    return (
      <SubViewTabs
        data={data}
        storageKey="factstack:modules-view"
        ariaLabel="Modules view"
        views={[
          { key: 'key-files', label: 'Key Files', render: () => <KeyFilesTable files={view.keyFiles} /> },
          { key: 'modules', label: 'Modules', render: () => <ModulesView modules={view.modules} /> },
        ]}
      />
    );
  };
}
