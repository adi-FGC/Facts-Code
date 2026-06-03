/**
 * FilesTab — the merged code-inventory tab (v0.9 IA consolidation).
 *
 * Two lenses on "what's in here", behind one Files tab:
 *   - Files    → the per-file tree/table
 *   - Packages → the top-level directory browser ranked by token weight
 *                (the "what would I load into agent context" view)
 *
 * Both are the existing standalone routes, hosted unchanged by
 * SubViewTabs. The legacy /library URL deep-links to the Packages view.
 */
import type { Handle } from 'remix/ui';
import type { Dataset } from '../lib/loadArtifacts.ts';
import { SubViewTabs } from '../ui/SubViewTabs.tsx';
import { Files } from './Files.tsx';
import { Library } from './Library.tsx';

interface FilesTabProps {
  data: Dataset;
}

export function FilesTab(handle: Handle<FilesTabProps>) {
  return () => (
    <SubViewTabs
      data={handle.props.data}
      storageKey="factstack:files-view"
      ariaLabel="Files view"
      views={[
        { key: 'files', label: 'Files', path: '/files', render: (d) => <Files data={d} /> },
        { key: 'packages', label: 'Packages', path: '/library', render: (d) => <Library data={d} /> },
      ]}
    />
  );
}
