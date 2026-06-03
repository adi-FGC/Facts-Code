/**
 * Architecture — the merged structure tab (v0.9 IA consolidation).
 *
 * Three lenses on how the system is built, behind one tab:
 *   - Graph  → dependency graph (heatmap / DAG / layers)
 *   - Flow   → data-flow diagrams (swimlanes / sequence / entities / text)
 *   - Routes → entry points + HTTP/page routes
 *
 * Each is the existing standalone route, hosted unchanged by SubViewTabs.
 * Legacy URLs (/graph, /flow, /routes) deep-link straight to their view.
 */
import type { Handle } from 'remix/ui';
import type { Dataset } from '../lib/loadArtifacts.ts';
import { SubViewTabs } from '../ui/SubViewTabs.tsx';
import { GraphRoute } from './GraphRoute.tsx';
import { Flow } from './Flow.tsx';
import { RoutesTab } from './RoutesTab.tsx';

interface ArchitectureProps {
  data: Dataset;
}

export function Architecture(handle: Handle<ArchitectureProps>) {
  return () => (
    <SubViewTabs
      data={handle.props.data}
      storageKey="factstack:architecture-view"
      ariaLabel="Architecture view"
      views={[
        { key: 'graph', label: 'Graph', path: '/graph', render: (d) => <GraphRoute data={d} /> },
        { key: 'flow', label: 'Flow', path: '/flow', render: (d) => <Flow data={d} /> },
        { key: 'routes', label: 'Routes', path: '/routes', render: (d) => <RoutesTab data={d} /> },
      ]}
    />
  );
}
