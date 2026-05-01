import type { Handle } from '@remix-run/ui';
import { PortFromLegacy } from '../components/PortFromLegacy.tsx';

export function RoutesTab(_h: Handle) {
  return () => (
    <PortFromLegacy
      tab="Routes"
      legacyHash="#tab=routes"
      summary="Every page, API endpoint, and CLI command the project exposes. The CXO's answer to 'what does this thing actually do?' — every entry maps to a file you can open."
      features={[
        'Detected routes from Next.js, Remix, Express, FastAPI, Flask, Django',
        'Grouped by framework, sortable by path or method',
        'Effect chips (DB / network / fs / env) once v0.4.11 ships',
        'Per-route reading-time estimate for new engineers',
      ]}
    />
  );
}
