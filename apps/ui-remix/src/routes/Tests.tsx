import { PortFromLegacy } from '../components/PortFromLegacy.tsx';

export function Tests() {
  return (
    <PortFromLegacy
      tab="Tests"
      legacyHash="#tab=tests"
      summary="Test coverage and effectiveness — not just what's tested, but what changed recently and whether the corresponding tests changed too. The 'are we actually safe?' panel."
      features={[
        'Per-file coverage map (heuristic from import graph, v0.3.7)',
        'Stale tests: subject unchanged + test untouched + no recent CI runs',
        'Symbol-level drift between impl and tests (v0.4.5)',
        'Auto-suggested regression tests from the bug-to-PR pipeline (v0.6)',
      ]}
    />
  );
}
