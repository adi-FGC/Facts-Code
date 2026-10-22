/**
 * Which URL changes are navigations. `popstate` also fires for a
 * same-document `#anchor` click (a docs heading, a footnote), where nothing
 * but the fragment changed; re-rendering the route for it announced "view
 * loaded" and yanked focus to <main>, away from the anchor the reader had
 * just clicked (F-47). The in-app `factstack:nav` event is always a
 * navigation: the link helper fires it for route changes only.
 *
 * `renderedPath` / `nextPath` are pathname plus query: a back/forward step
 * between `/files?p=a` and `/files?p=b` is a navigation, a fragment is not.
 */
export function isRouteChange(eventType: string, renderedPath: string, nextPath: string): boolean {
  if (eventType !== 'popstate') return true;
  return nextPath !== renderedPath;
}
