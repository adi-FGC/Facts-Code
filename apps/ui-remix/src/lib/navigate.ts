/**
 * Tiny client-side navigation helper for the SPA mount.
 *
 * Why not use `remix/route-pattern`'s built-in `navigate()`?
 *   - That helper is wired to the Frame runtime, which our `createRoot`
 *     mount doesn't use. Calling it would attempt a frame reload that
 *     never resolves.
 *   - We want the simplest possible model: pushState the new URL,
 *     dispatch a `factstack:nav` event, and let `main.tsx` re-render.
 *
 * The dispatched event is the thing `main.tsx` listens for — together
 * with the browser's native `popstate` for back/forward, that gives us
 * a complete client-side router in ~20 lines.
 */

export interface NavigateOptions {
  /** Default 'push' — adds a history entry. 'replace' overwrites the current entry. */
  history?: 'push' | 'replace';
}

const NAV_EVENT = 'factstack:nav';

export function navigate(href: string, opts: NavigateOptions = {}): void {
  const mode = opts.history ?? 'push';
  if (location.pathname + location.search + location.hash === href) return;
  try {
    if (mode === 'replace') history.replaceState(history.state ?? null, '', href);
    else history.pushState({}, '', href);
  } catch {
    // file:// or sandboxed frame — fall through to a hard nav so the user
    // isn't stuck.
    location.assign(href);
    return;
  }
  window.dispatchEvent(new Event(NAV_EVENT));
}

/**
 * Click handler for `<a>` tags. Intercepts left-click on internal links,
 * calls `navigate()`, and stops the browser's default page-reload.
 *
 * The `mix={on('click', linkClick)}` style attaches this once per
 * <Header /> render. External links + modified clicks fall through to
 * the browser as usual.
 */
export function linkClick(event: Event): void {
  if (!(event instanceof MouseEvent)) return;
  if (event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const a = target.closest('a');
  if (!a) return;
  // A `download` anchor is an explicit file save, never SPA navigation.
  // Without this guard we preventDefault() the click and try to "navigate"
  // to the download URL — which for a blob: URL navigates the tab to raw
  // file content instead of downloading it (the Graph tab's "Download .mmd"
  // export hit exactly this). Let the browser handle download links.
  if (a.hasAttribute('download')) return;
  const href = a.getAttribute('href');
  if (!href) return;
  // In-page anchors (`#main`, `#section`) are native browser behavior: the
  // browser scrolls the target into view and moves focus to it. Intercepting
  // them would preventDefault() and pushState the hash WITHOUT scrolling or
  // focusing — silently breaking the accessibility skip-link (Header.tsx's
  // `<a href="#main">`) and any in-page jump. Let the browser handle them.
  if (href.startsWith('#')) return;
  // Only intercept same-origin navigation to a non-hash path.
  if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('//')) return;
  if (href.startsWith('mailto:') || href.startsWith('tel:')) return;
  // Non-navigational schemes: blob:/data: are object/inline payloads (e.g.
  // generated file downloads), never route paths. Leave them to the browser.
  if (href.startsWith('blob:') || href.startsWith('data:')) return;
  if (a.target && a.target !== '_self') return;
  event.preventDefault();
  navigate(href);
}
