/**
 * Hash-based router. chrome-extension://<id>/panel.html has no server and no
 * SPA path-fallback, so we route on `location.hash` (#/security/vulns) instead
 * of pushState paths. Native `hashchange` gives back/forward for free.
 */
const FIRE = (): void => { window.dispatchEvent(new Event('factstack:hashnav')); };

export function currentPath(): string {
  const h = location.hash.replace(/^#/u, '');
  return h.startsWith('/') ? h : '/' + h; // '' → '/'
}

/** Path segments, e.g. "/security/vulns" → ['security','vulns']. */
export function pathSegments(): string[] {
  return currentPath().split('/').filter(Boolean);
}

export function navigate(path: string): void {
  const p = path.startsWith('/') ? path : '/' + path;
  if (currentPath() === p) return;
  location.hash = p; // triggers hashchange
}

export function back(): void {
  history.back();
}

export function onNavigate(cb: () => void): () => void {
  const handler = (): void => cb();
  window.addEventListener('hashchange', handler);
  window.addEventListener('factstack:hashnav', handler);
  return () => {
    window.removeEventListener('hashchange', handler);
    window.removeEventListener('factstack:hashnav', handler);
  };
}

/* Re-export so callers that mutate hash directly can still notify listeners
 * within the same tick if needed. */
export { FIRE as fireNav };
