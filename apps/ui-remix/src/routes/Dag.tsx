import { PortFromLegacy } from '../components/PortFromLegacy.tsx';

export function Dag() {
  return (
    <PortFromLegacy
      tab="DAG"
      legacyHash="#tab=dag"
      summary="A directed-acyclic-graph view of the dependency edges, layered top-down. Useful for spotting the actual layering of the codebase vs the README's claims."
      features={[
        'Layered Sugiyama layout (top-down by depth-from-entry-points)',
        'Cycle highlights — red edges where dependency loops exist',
        'Click any node to focus on its callers + callees',
        'Filter by tier (frontend / backend / shared) once v0.4.1 lands',
      ]}
    />
  );
}
