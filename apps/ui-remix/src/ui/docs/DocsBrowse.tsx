/**
 * DocsBrowse — find every doc in one place + preview it.
 *
 * Left: a searchable, folder-grouped index of every flagged doc/spec file.
 * Right: the selected doc rendered (Markdown → VDOM; HTML → its source, since
 * the dashboard's CSP would strip a doc's own styles/scripts; everything else
 * → raw), with a Raw toggle and a generated outline. This is the "see all the
 * documentation that exists, in its real form" surface.
 *
 * `/docs?doc=<path>` selects a doc (relative links inside docs resolve to it).
 * The component outlives a dataset hot-swap (⌘O scan), so everything cached
 * per dataset is dropped when `props.data` changes identity.
 */
import type { Handle } from 'remix/component';
import { css, on } from 'remix/component';
import type { DocFile } from '@factstack/spec';
import type { Dataset } from '../../lib/loadArtifacts.ts';
import { renderMarkdown, type MarkdownOptions } from '../../lib/markdown.tsx';
import { getDocs, groupDocs } from '../../lib/docsModel.ts';

const wrap = css({
  display: 'grid',
  gridTemplateColumns: '300px minmax(0, 1fr)',
  gap: '0',
  maxWidth: 'var(--content-max)',
  marginInline: 'auto',
  paddingInline: 'var(--gutter)',
  paddingBlock: 'var(--space-6)',
  '@media (max-width: 800px)': { gridTemplateColumns: '1fr' },
});

const aside = css({
  borderRight: '1px solid var(--hairline)',
  paddingRight: 'var(--space-4)',
  minWidth: '0',
});
const search = css({
  width: '100%',
  background: 'var(--surface-1)',
  border: '1px solid var(--border)',
  borderRadius: '8px',
  color: 'var(--fg)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  padding: 'var(--space-2) var(--space-3)',
  marginBottom: 'var(--space-4)',
  '&:focus': { outline: 'none', borderColor: 'var(--accent)' },
});
const groupHead = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
  margin: 'var(--space-4) 0 var(--space-2)',
});
const docRow = css({
  display: 'block',
  width: '100%',
  textAlign: 'left',
  background: 'transparent',
  border: 'none',
  borderLeft: '2px solid transparent',
  padding: '6px var(--space-3)',
  cursor: 'pointer',
  color: 'var(--fg-muted)',
  borderRadius: '0 6px 6px 0',
  '&:hover': { background: 'var(--accent-soft)', color: 'var(--fg)' },
});
const docRowActive = css({
  borderLeftColor: 'var(--accent)',
  background: 'var(--accent-soft)',
  color: 'var(--fg)',
});
const docName = css({
  fontSize: 'var(--fs-13)',
  fontWeight: '600',
  display: 'flex',
  gap: 'var(--space-2)',
  alignItems: 'baseline',
});
const fmtBadge = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  color: 'var(--accent)',
  flex: '0 0 auto',
});
const docMeta = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  color: 'var(--fg-subtle)',
  marginTop: '2px',
});

const main = css({
  paddingLeft: 'var(--space-6)',
  minWidth: '0',
  '@media (max-width: 800px)': { paddingLeft: '0', paddingTop: 'var(--space-5)' },
});
const docTitle = css({
  fontFamily: 'var(--font-display, var(--font-body))',
  fontSize: 'var(--fs-24)',
  fontWeight: '600',
  letterSpacing: '-0.02em',
  margin: '0 0 var(--space-2)',
});
const pathLine = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg-subtle)',
  marginBottom: 'var(--space-3)',
});
const chips = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--space-2)',
  marginBottom: 'var(--space-4)',
});
const chip = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  color: 'var(--fg-muted)',
  border: '1px solid var(--hairline)',
  borderRadius: '999px',
  padding: '2px 8px',
});
const toolbar = css({
  display: 'flex',
  gap: 'var(--space-3)',
  alignItems: 'center',
  marginBottom: 'var(--space-4)',
});
const segBtn = (active: boolean) =>
  css({
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--fs-11)',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    padding: '4px var(--space-3)',
    borderRadius: '6px',
    cursor: 'pointer',
    border: '1px solid var(--border)',
    background: active ? 'var(--accent)' : 'transparent',
    color: active ? 'var(--bg)' : 'var(--fg-muted)',
  });
const rawPre = css({
  background: 'var(--surface-1)',
  border: '1px solid var(--hairline)',
  borderRadius: '10px',
  padding: 'var(--space-4)',
  overflowX: 'auto',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  lineHeight: '1.6',
  color: 'var(--fg-muted)',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
});
const outline = css({
  border: '1px solid var(--hairline)',
  borderRadius: '10px',
  padding: 'var(--space-3) var(--space-4)',
  marginBottom: 'var(--space-5)',
  background: 'var(--surface-1)',
});
const outlineLink = (depth: number) =>
  css({
    display: 'block',
    fontSize: 'var(--fs-12)',
    color: 'var(--fg-muted)',
    padding: '2px 0',
    paddingLeft: `calc(${depth - 1} * var(--space-3))`,
    textDecoration: 'none',
    '&:hover': { color: 'var(--accent)' },
  });
const note = css({
  fontSize: 'var(--fs-12)',
  color: 'var(--warn)',
  fontFamily: 'var(--font-mono)',
  marginBottom: 'var(--space-3)',
});
const empty = css({ color: 'var(--fg-subtle)', fontSize: 'var(--fs-13)' });

/* Static inline styles hoisted to classes so the CSP can drop style-src
   'unsafe-inline'. */
const groupCount = css({ color: 'var(--fg-faint)' });
const ellipsis = css({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });

const FMT_LABEL: Record<string, string> = {
  markdown: 'MD',
  html: 'HTML',
  text: 'TXT',
  rst: 'RST',
  asciidoc: 'ADOC',
  openapi: 'API',
  'json-schema': 'SCHEMA',
  notebook: 'IPYNB',
  other: 'DOC',
};

function isMarkdownish(f: DocFile): boolean {
  return (
    f.format === 'markdown' || f.format === 'text' || f.format === 'rst' || f.format === 'asciidoc'
  );
}

/** On the published site a doc's body is not in the page: inject-data moves
 *  each to /data/docs/<id>.json and leaves this URL (≈800 KB the first visit
 *  no longer downloads). Local `factstack ui` and exported reports still
 *  carry `content` inline and never set it. */
type LazyDoc = DocFile & { contentUrl?: string };

/** The `?doc=` deep-link param, if the URL carries one. */
function docParam(): string | null {
  if (typeof location === 'undefined') return null;
  return new URLSearchParams(location.search).get('doc');
}

export function DocsBrowse(handle: Handle<{ data: Dataset }>) {
  let lastData = handle.props.data;
  let docPaths = new Set(getDocs(lastData).map((d) => d.path));
  const linked = docParam();
  let selPath = linked && docPaths.has(linked) ? linked : (getDocs(lastData)[0]?.path ?? '');
  let mode: 'preview' | 'raw' = 'preview';
  let query = '';

  /* Bodies fetched on demand, once per URL. Keyed by contentUrl, not path:
     after a hot-swap a new project's README.md is a different document, and
     a path-keyed cache showed the old one's body over it (UI-03). */
  const bodies = new Map<string, string | Error>();
  const pending = new Set<string>();
  let bodyGen = 0;
  const ensureBody = (doc: LazyDoc | undefined): void => {
    const url = doc && doc.content === null ? doc.contentUrl : undefined;
    if (!url || bodies.has(url) || pending.has(url)) return;
    const gen = bodyGen;
    pending.add(url);
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ content?: unknown }>;
      })
      .then((j) => {
        if (typeof j.content !== 'string') throw new Error('malformed document file');
        if (gen === bodyGen) bodies.set(url, j.content);
      })
      .catch((e: unknown) => {
        if (gen === bodyGen) bodies.set(url, e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        pending.delete(url);
        void handle.update();
      });
  };

  const select = (p: string) => {
    selPath = p;
    mode = 'preview';
    /* Keep `?doc=` in step with the pick, so Back, a reload or a copied
       link shows the doc on screen, and a later link back to the doc the
       URL named is a real change. */
    if (typeof location !== 'undefined' && location.pathname === '/docs') {
      try {
        history.replaceState(history.state, '', `/docs?doc=${encodeURIComponent(p)}`);
      } catch {
        /* sandboxed / file:// — the selection still applies */
      }
    }
    void handle.update();
  };
  /* A `?doc=` link followed from inside a doc (or back/forward) selects it.
     A /docs entry without a known `?doc=` is the landing state, which shows
     the first doc — so Back from a followed link restores it. */
  const onNav = () => {
    if (typeof location === 'undefined' || location.pathname !== '/docs') return;
    const want = docParam();
    const next =
      want && docPaths.has(want) ? want : (getDocs(handle.props.data)[0]?.path ?? selPath);
    if (next === selPath) return;
    selPath = next;
    mode = 'preview';
    void handle.update();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('popstate', onNav);
    window.addEventListener('factstack:nav', onNav);
    handle.signal.addEventListener('abort', () => {
      window.removeEventListener('popstate', onNav);
      window.removeEventListener('factstack:nav', onNav);
    });
  }
  const setMode = (m: 'preview' | 'raw') => {
    mode = m;
    void handle.update();
  };
  const setQuery = (v: string) => {
    query = v;
    void handle.update();
  };

  return () => {
    const docs = getDocs(handle.props.data);
    if (handle.props.data !== lastData) {
      /* Dataset hot-swapped: drop every per-dataset cache, and fall back to
         the new first doc if the old selection doesn't exist there. */
      lastData = handle.props.data;
      docPaths = new Set(docs.map((d) => d.path));
      bodies.clear();
      pending.clear();
      bodyGen++;
      if (!docPaths.has(selPath)) {
        selPath = docs[0]?.path ?? '';
        mode = 'preview';
      }
    }
    const q = query.trim().toLowerCase();
    const filtered = q
      ? docs.filter((d) => (d.path + ' ' + d.title).toLowerCase().includes(q))
      : docs;
    const groups = groupDocs(filtered);
    const picked: LazyDoc | undefined = docs.find((d) => d.path === selPath) ?? docs[0];
    ensureBody(picked);
    const lazy = picked?.content === null && Boolean(picked?.contentUrl);
    const fetched = lazy && picked?.contentUrl ? bodies.get(picked.contentUrl) : undefined;
    const sel: LazyDoc | undefined =
      picked && typeof fetched === 'string' ? { ...picked, content: fetched } : picked;

    return (
      <div mix={wrap}>
        <aside mix={aside}>
          <input
            mix={[search, on('input', (e) => setQuery(e.currentTarget.value))]}
            type="search"
            value={query}
            placeholder={`Filter ${docs.length} docs…`}
            aria-label="Filter documents"
          />
          {groups.length === 0 ? <p mix={empty}>No docs match.</p> : null}
          {groups.map((g) => (
            <div key={g.dir}>
              <div mix={groupHead}>
                {g.dir}/ <span mix={groupCount}>{String(g.docs.length)}</span>
              </div>
              {g.docs.map((d) => (
                <button
                  key={d.path}
                  type="button"
                  mix={[
                    docRow,
                    d.path === selPath ? docRowActive : null,
                    on('click', () => select(d.path)),
                  ]}
                >
                  <span mix={docName}>
                    <span mix={fmtBadge}>{FMT_LABEL[d.format] ?? 'DOC'}</span>
                    <span mix={ellipsis}>{d.name}</span>
                  </span>
                  <span mix={docMeta}>
                    {d.headings.length}h · {d.todos.length}t
                    {d.diagrams.length ? ` · ${d.diagrams.length}◇` : ''} · {d.readingMinutes}m
                  </span>
                </button>
              ))}
            </div>
          ))}
        </aside>

        <section mix={main}>
          {!sel ? (
            <p mix={empty}>Select a document.</p>
          ) : (
            <>
              <h1 mix={docTitle}>{sel.title || sel.name}</h1>
              <div mix={pathLine}>{sel.path}</div>
              <div mix={chips}>
                <span mix={chip}>{sel.kind}</span>
                <span mix={chip}>{sel.format}</span>
                <span mix={chip}>{fmtBytes(sel.bytes)}</span>
                <span mix={chip}>{sel.wordCount} words</span>
                <span mix={chip}>{sel.readingMinutes} min</span>
                {sel.todos.length ? <span mix={chip}>{sel.todos.length} todos</span> : null}
                {sel.diagrams.length ? (
                  <span mix={chip}>{sel.diagrams.length} diagrams</span>
                ) : null}
              </div>

              <div mix={toolbar}>
                <button
                  type="button"
                  mix={[segBtn(mode === 'preview'), on('click', () => setMode('preview'))]}
                >
                  Preview
                </button>
                <button
                  type="button"
                  mix={[segBtn(mode === 'raw'), on('click', () => setMode('raw'))]}
                >
                  Raw
                </button>
              </div>

              {fetched instanceof Error ? (
                <p mix={note}>
                  Couldn’t load this document ({fetched.message}). Outline + structure below.
                </p>
              ) : lazy && sel.content === null ? (
                <p mix={note} role="status">
                  Loading document…
                </p>
              ) : sel.content === null ? (
                <p mix={note}>
                  This doc’s text isn’t in this dataset (over the analysis content budget, or left
                  out of the published build). Outline + structure below.
                </p>
              ) : sel.truncated ? (
                <p mix={note}>
                  Showing a truncated copy (large file). Open the original for the full text.
                </p>
              ) : null}

              {mode === 'preview' && sel.headings.length > 2 ? (
                <nav mix={outline} aria-label="Document outline">
                  {sel.headings.slice(0, 40).map((h, i) => (
                    <a key={i} href={`#${h.slug}`} mix={outlineLink(h.depth)}>
                      {h.text}
                    </a>
                  ))}
                </nav>
              ) : null}

              {lazy && sel.content === null
                ? null
                : renderBody(sel, mode, { basePath: sel.path, isDoc: (p) => docPaths.has(p) })}
            </>
          )}
        </section>
      </div>
    );
  };
}

function renderBody(doc: DocFile, mode: 'preview' | 'raw', md: MarkdownOptions) {
  const content = doc.content ?? '';
  if (mode === 'raw' || (!isMarkdownish(doc) && doc.format !== 'html')) {
    if (!content) return <p mix={empty}>No raw content stored for this doc.</p>;
    return (
      <pre mix={rawPre}>
        <code>{content}</code>
      </pre>
    );
  }
  if (doc.format === 'html') {
    if (!content) return <p mix={empty}>No content stored for this HTML doc.</p>;
    /* No live preview. A srcdoc iframe inherits the dashboard's strict CSP,
       so the doc's own inline <style>/<script> never apply and it renders
       broken (UI-12). Say so, and show the source instead. */
    return (
      <>
        <p mix={note} role="note">
          HTML preview is off: this dashboard’s security policy blocks a page’s own inline styles
          and scripts, so it would render broken. Showing the source instead.
        </p>
        <pre mix={rawPre}>
          <code>{content}</code>
        </pre>
      </>
    );
  }
  if (!content) return <p mix={empty}>No content stored for this doc.</p>;
  return renderMarkdown(content, md);
}

function fmtBytes(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + ' MB';
  if (n >= 1000) return (n / 1000).toFixed(1) + ' KB';
  return n + ' B';
}
