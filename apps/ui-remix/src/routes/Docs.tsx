/**
 * Docs — the documentation-intelligence tab.
 *
 * One place to find every doc/spec file the analyzer flagged, plus inferred
 * views over them:
 *   - Browse   → the full index + a rendered/raw preview of any doc
 *   - Todos    → every checkbox/TODO across the docs, with progress
 *   - Roadmap  → collapsible, verifiable roadmaps from doc checklists
 *   - Diagrams → mermaid / ER / plantuml blocks lifted from the docs
 *   - Features → analyzer capabilities cross-checked against doc claims
 *
 * Each view is a self-contained component hosted by SubViewTabs, same as the
 * Architecture tab. All data comes from `data.docs` (parsed once at analyze
 * time), so the tab works identically in served, static-export, and
 * browser-scan modes.
 */
import type { Handle } from 'remix/ui';
import { css } from 'remix/ui';
import type { Dataset } from '../lib/loadArtifacts.ts';
import { SubViewTabs } from '../ui/SubViewTabs.tsx';
import { getDocs } from '../lib/docsModel.ts';
import { DocsBrowse } from '../ui/docs/DocsBrowse.tsx';
import { DocsTodos } from '../ui/docs/DocsTodos.tsx';
import { DocsRoadmap } from '../ui/docs/DocsRoadmap.tsx';
import { DocsDiagrams } from '../ui/docs/DocsDiagrams.tsx';
import { DocsFeatures } from '../ui/docs/DocsFeatures.tsx';

const emptyWrap = css({
  maxWidth: 'var(--content-max)', marginInline: 'auto', paddingInline: 'var(--gutter)', paddingBlock: 'var(--space-12)',
});
const emptyH = css({ fontFamily: 'var(--font-display, var(--font-body))', fontSize: 'var(--fs-24)', fontWeight: '600', letterSpacing: '-0.02em', margin: '0 0 var(--space-3)' });
const emptyP = css({ color: 'var(--fg-muted)', fontSize: 'var(--fs-14)', maxWidth: '60ch' });
const codeInline = css({ fontFamily: 'var(--font-mono)', fontSize: '0.9em', background: 'var(--code-bg)', padding: '1px 5px', borderRadius: '4px' });

export function Docs(handle: Handle<{ data: Dataset }>) {
  return () => {
    const data = handle.props.data;
    if (getDocs(data).length === 0) {
      return (
        <div mix={emptyWrap}>
          <h1 mix={emptyH}>No documentation flagged.</h1>
          <p mix={emptyP}>
            This analysis didn't flag any documentation or spec files. FACTS picks up
            Markdown, text, RST/AsciiDoc, HTML under a <code mix={codeInline}>docs/</code> folder,
            OpenAPI/Swagger specs, JSON Schema, and well-known files like
            <code mix={codeInline}>README</code>, <code mix={codeInline}>CHANGELOG</code>,
            and <code mix={codeInline}>CONTRIBUTING</code>. Re-run <code mix={codeInline}>factstack analyze</code>{' '}
            after adding docs and they'll appear here.
          </p>
        </div>
      );
    }
    return (
      <SubViewTabs
        data={data}
        storageKey="factstack:docs-view"
        ariaLabel="Docs view"
        views={[
          { key: 'browse', label: 'Browse', path: '/docs', render: (d) => <DocsBrowse data={d} /> },
          { key: 'todos', label: 'Todos', render: (d) => <DocsTodos data={d} /> },
          { key: 'roadmap', label: 'Roadmap', render: (d) => <DocsRoadmap data={d} /> },
          { key: 'diagrams', label: 'Diagrams', render: (d) => <DocsDiagrams data={d} /> },
          { key: 'features', label: 'Features', render: (d) => <DocsFeatures data={d} /> },
        ]}
      />
    );
  };
}
