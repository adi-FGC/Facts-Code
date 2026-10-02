/**
 * docLinks — map a link written inside a project doc to a dashboard route.
 *
 * READMEs link to siblings relatively (`reference/x.md`, `../README.md`,
 * `/docs/setup.md` for the repo root, as GitHub renders them). Emitted
 * verbatim, the SPA router resolved them against the dashboard URL
 * (`/docs` → `/reference/x.md`), matched no tab and dumped the reader on
 * Overview. Resolved here against the doc's own path instead:
 *
 *   - a known doc      → `/docs?doc=<path>` (opens it in the Docs tab)
 *   - any other path   → `/files?p=<path>`  (the file's detail view)
 *   - escapes the root → null (the caller renders plain text)
 *
 * Anything with a scheme, protocol-relative URLs and `#fragments` pass
 * through untouched (safeHref still sanitises them). Pure, no DOM.
 */

/** Resolve `href` from a doc at `basePath`; null = render as plain text. */
export function resolveDocHref(
  href: string,
  basePath: string,
  isDoc: (path: string) => boolean,
): string | null {
  const h = href.trim();
  if (h === '' || h.startsWith('#') || h.startsWith('//')) return h;
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return h;
  const target = h.replace(/[?#].*$/, '');
  if (target === '') return h;
  const dir = basePath.includes('/') ? basePath.slice(0, basePath.lastIndexOf('/')) : '';
  const joined = target.startsWith('/') ? target : dir ? `${dir}/${target}` : target;
  const out: string[] = [];
  for (const seg of joined.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  if (out.length === 0) return null;
  let path = out.join('/');
  try {
    path = decodeURIComponent(path);
  } catch {
    /* malformed escape — keep the literal path */
  }
  return isDoc(path)
    ? `/docs?doc=${encodeURIComponent(path)}`
    : `/files?p=${encodeURIComponent(path)}`;
}
