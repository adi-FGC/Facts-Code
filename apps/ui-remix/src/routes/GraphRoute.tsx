import type { Handle } from '@remix-run/ui';
import { PortFromLegacy } from '../components/PortFromLegacy.tsx';

export function GraphRoute(_h: Handle) {
  return () => (
    <PortFromLegacy
      tab="Graph"
      legacyHash="#tab=graph"
      summary="Force-directed dependency graph with click-to-focus and tier filters. The legacy version uses xyflow (a React lib) — this Remix v3 app needs a replacement that doesn't pull React back in. Tracked in TASKS.md."
      features={[
        'Force-directed layout with stable seeds (same input → same picture)',
        'Click any node to focus on its callers + callees',
        'Cycle highlights — red edges where dependency loops exist',
        'Tier filters (frontend / backend / shared) once v0.4.1 lands',
        'Replacement candidate: d3-force + plain SVG, or cytoscape.js',
      ]}
    />
  );
}
