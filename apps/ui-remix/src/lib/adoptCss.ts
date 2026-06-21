/**
 * SEC-3 — runtime CSS injection without `<style>` (so the CSP can drop
 * `style-src 'unsafe-inline'`).
 *
 * The css() runtime can't emit `@keyframes`, so a few components inject keyframe
 * rules at first render. Done the old way (document.createElement('style') +
 * textContent) that requires `style-src 'unsafe-inline'`. An ADOPTED
 * Constructable Stylesheet (`new CSSStyleSheet().replaceSync(css)` pushed onto
 * `document.adoptedStyleSheets`) is NOT governed by `style-src` — it carries no
 * inline `<style>` element — so it works under a strict CSP.
 *
 * Idempotent per `id`. No-op during SSR and on engines without Constructable
 * Stylesheets (Chrome <73 / Safari <16.4 / Firefox <101): the keyframes simply
 * don't register and animations degrade to instant — never a thrown error.
 */
const adopted = new Set<string>();

export function adoptCss(id: string, cssText: string): void {
  if (typeof document === 'undefined') return;
  if (adopted.has(id)) return;
  try {
    if (
      typeof CSSStyleSheet === 'undefined' ||
      !('replaceSync' in CSSStyleSheet.prototype) ||
      !('adoptedStyleSheets' in Document.prototype)
    ) {
      return; // old engine — skip; motion degrades to instant
    }
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    adopted.add(id);
  } catch {
    /* never let a stylesheet quirk break render */
  }
}
