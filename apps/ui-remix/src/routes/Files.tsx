import type { Handle } from '@remix-run/ui';
import { PortFromLegacy } from '../components/PortFromLegacy.tsx';

export function Files(_h: Handle) {
  return () => (
    <PortFromLegacy
      tab="Files"
      legacyHash="#tab=files"
      summary="Tree-driven file explorer: pick a file from the LHS panel and the RHS shows its outline + preview + imports + callers + TODOs + tests. The legacy version uses react-arborist; the Remix v3 port needs a tree primitive that doesn't depend on React."
      features={[
        'Recursive collapsible tree with persistent open/closed state',
        'Outline panel: declarations, exports, route handlers',
        'Preview with Shiki syntax highlighting (Shiki is React-free)',
        'Imports + Callers cross-references (driven by agent.json edges)',
        'TODOs panel surfaces TODO/FIXME/HACK comments per file',
      ]}
    />
  );
}
