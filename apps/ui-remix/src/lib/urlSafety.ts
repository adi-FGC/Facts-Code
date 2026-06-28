/**
 * urlSafety — pure, dependency-free URL-scheme guards shared by the Markdown
 * renderer (link hrefs) and the SPA navigator (click handling).
 *
 * Doc bodies are copied verbatim from the ANALYZED project, so a README link
 * like `[x](javascript:…)` is untrusted input. These helpers stop a dangerous
 * scheme from ever reaching an `<a href>` or `location.assign()`. No imports,
 * so they're trivially unit-testable (no JSX / remix runtime needed).
 *
 * Both helpers strip characters ≤ 0x20 (control chars + space) and NBSP before
 * detecting the scheme, because browsers ignore those inside a scheme — e.g.
 * `java\tscript:alert(1)` still executes. We use a char-code filter rather than
 * a regex character class so the source stays plain ASCII.
 */

function stripBlanks(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code > 0x20 && code !== 0xa0) out += ch;
  }
  return out;
}

/** The scheme of a URL in lowercase, or null for relative / fragment / protocol-relative. */
function schemeOf(href: string): string | null {
  const norm = stripBlanks((href ?? '').trim());
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(norm);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Sanitize a link href for rendering. Allows only navigational schemes
 * (http, https, mailto, tel) and relative/fragment/protocol-relative URLs;
 * everything else (javascript:, data:, vbscript:, file:, exotic schemes)
 * collapses to '#'.
 */
export function safeHref(href: string): string {
  const s = (href ?? '').trim();
  const scheme = schemeOf(s);
  if (scheme === null) return s; // relative / fragment / protocol-relative
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel'
    ? s
    : '#';
}

/**
 * True for schemes that must never be handed to history/location — they can
 * execute script (javascript:, vbscript:) or load inline payloads (data:,
 * file:) in the page origin. Relative URLs return false.
 */
export function isDangerousScheme(href: string): boolean {
  const scheme = schemeOf(href);
  if (scheme === null) return false;
  return scheme === 'javascript' || scheme === 'vbscript' || scheme === 'data' || scheme === 'file';
}
