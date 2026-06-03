/**
 * Security — the merged risk & security tab (v0.9 IA consolidation).
 *
 * Everything "what's wrong / what to watch", behind one tab:
 *   - Risks          → all scanner findings (broken imports, stale,
 *                      TODOs, secrets-as-risks…)
 *   - Secrets        → the credentials/secret-leak surface
 *   - Vulnerabilities → known CVEs (OSV.dev) against dependency manifests
 *
 * The tab is labelled "Security" but the Risks view is broader than
 * security alone; the page headlines make that honest. Each view is the
 * existing standalone route, hosted unchanged by SubViewTabs. Legacy
 * URLs (/risks, /credentials, /vulnerabilities) deep-link to their view.
 */
import type { Handle } from 'remix/ui';
import type { Dataset } from '../lib/loadArtifacts.ts';
import { SubViewTabs } from '../ui/SubViewTabs.tsx';
import { Risks } from './Risks.tsx';
import { Credentials } from './Credentials.tsx';
import { Vulnerabilities } from './Vulnerabilities.tsx';

interface SecurityProps {
  data: Dataset;
}

export function Security(handle: Handle<SecurityProps>) {
  return () => (
    <SubViewTabs
      data={handle.props.data}
      storageKey="factstack:security-view"
      ariaLabel="Security view"
      views={[
        { key: 'risks', label: 'Risks', path: '/risks', render: (d) => <Risks data={d} /> },
        { key: 'secrets', label: 'Secrets', path: '/credentials', render: (d) => <Credentials data={d} /> },
        { key: 'vulns', label: 'Vulnerabilities', path: '/vulnerabilities', render: (d) => <Vulnerabilities data={d} /> },
      ]}
    />
  );
}
