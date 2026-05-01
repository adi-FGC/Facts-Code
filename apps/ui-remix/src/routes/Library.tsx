import type { Handle } from '@remix-run/ui';
import { PortFromLegacy } from '../components/PortFromLegacy.tsx';

export function Library(_h: Handle) {
  return () => (
    <PortFromLegacy
      tab="Library"
      legacyHash="#tab=library"
      summary="Symbol-level browse of every export in the project, grouped by role (Components, Hooks, Pages, Utilities, Server APIs, Types). Acts as the project's table of contents."
      features={[
        'Search by symbol name, file, or role',
        'Each row links to the file outline and the call sites',
        'Public vs private surface marker (lights up when v0.4.6 ships)',
        'Token cost per export so you can pre-budget agent context',
      ]}
    />
  );
}
