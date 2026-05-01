import type { Handle } from '@remix-run/ui';
import { PortFromLegacy } from '../components/PortFromLegacy.tsx';

export function Config(_h: Handle) {
  return () => (
    <PortFromLegacy
      tab="Config"
      legacyHash="#tab=config"
      summary="Per-deploy and per-user configuration — what FACTS reads at startup. Theme override, font-size slider, MCP-server pairing, telemetry preferences (when those exist), and the GitHub PAT for raised rate limits."
      features={[
        'Theme: Light / Dark / System',
        'Font size slider (0.85x – 1.35x), persisted to localStorage',
        'GitHub PAT for the Open from GitHub flow (60 → 5000 req/hr)',
        'Supabase URL + anon key for the cache-first deep-link flow',
        '.factsignore quick edit (when running locally)',
      ]}
    />
  );
}
