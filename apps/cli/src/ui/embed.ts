/**
 * Runtime helpers for the CLI's local UI (the legacy prototype built by
 * scripts/sync-ui.mjs): embedding the dataset, the Content-Security-Policy
 * for `factstack ui` and for the static `export` / `quick` reports, and
 * serving the vendored @babel/parser module.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DATA_OPEN = '<script id="factstack-data" type="application/json">';

/**
 * JSON that is inert inside `<script type="application/json">`. Every `<` is
 * written as the JSON escape `\u003c`, so repo text containing `</script>`,
 * `<!--` or `<script` cannot end the block early or push the HTML tokenizer
 * into its "double-escaped" state (which swallowed the rest of the page and
 * rendered it blank). JSON.parse turns the escapes back into `<`.
 */
export function jsonForScriptBlock(data: unknown): string {
  return (JSON.stringify(data) ?? 'null').replaceAll('<', '\\u003c');
}

/** Replace the template's inline dataset with `data`. */
export function injectInlineData(html: string, data: unknown): string {
  const i = html.indexOf(DATA_OPEN);
  if (i < 0) throw new Error('data marker not found in UI template');
  const after = i + DATA_OPEN.length;
  const end = html.indexOf('</script>', after);
  if (end < 0) throw new Error('closing </script> not found after data marker');
  return html.slice(0, after) + '\n' + jsonForScriptBlock(data) + '\n    ' + html.slice(end);
}

const SCRIPT_RE = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
const EXECUTABLE_TYPES = new Set(['', 'module', 'text/javascript', 'application/javascript']);

/**
 * CSP source expressions (`'sha256-…'`) for every executable inline script.
 * Data blocks (`type="application/json"`) never run, so the dataset needs no
 * hash and can change freely. Browsers hash the text after normalizing
 * CRLF/CR to LF, so we do the same (a CRLF checkout must not break the page).
 */
export function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(SCRIPT_RE)) {
    const attrs = m[1] ?? '';
    if (/\ssrc\s*=/i.test(attrs)) continue;
    const type = /\stype\s*=\s*["']?([^"'\s>]*)/i.exec(attrs)?.[1]?.toLowerCase() ?? '';
    if (!EXECUTABLE_TYPES.has(type)) continue;
    const text = (m[2] ?? '').replaceAll(/\r\n?/g, '\n');
    out.push(`'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`);
  }
  return out;
}

/** The GitHub-repo scan is an explicit user action that talks to GitHub. */
const GITHUB_API = 'https://api.github.com https://raw.githubusercontent.com';

/**
 * Content-Security-Policy for the UI. Scripts run only if their hash matches
 * the shipped template (no `'unsafe-inline'`), so injected markup can never
 * execute script even if an unescaped value slipped through. `served` is the
 * `factstack ui` HTTP header; `static` is the `<meta>` for file:// reports,
 * where frame-ancestors is not allowed and there is no server to talk to.
 */
export function uiContentSecurityPolicy(
  html: string,
  mode: 'served' | 'static' = 'served',
): string {
  const self = mode === 'served' ? "'self' " : '';
  const directives = [
    "default-src 'none'",
    `script-src ${self}${inlineScriptHashes(html).join(' ')}`,
    // The prototype sets style="" attributes throughout (inline <style> too).
    "style-src 'unsafe-inline'",
    `img-src ${self}data:`,
    `connect-src ${self}${GITHUB_API}`,
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ];
  if (mode === 'served') directives.push("frame-ancestors 'none'");
  return directives.join('; ');
}

/**
 * Prepare the template for a static, self-contained report (`export`,
 * `quick`): there is no server, so the vendored parser import is replaced by
 * a friendly rejection (the page already degrades to "no import edges"), and
 * a `<meta>` CSP is inserted before the first script.
 */
export function prepareStaticReport(html: string): string {
  const out = html.replaceAll(
    /import\(\s*['"]\.\/vendor\/[^'"]+['"]\s*\)/g,
    "Promise.reject(new Error('Open-folder import edges need the served UI (factstack ui); static reports cannot load modules.'))",
  );
  const csp = uiContentSecurityPolicy(out, 'static');
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}" />`;
  const charset = /<meta charset=["']?utf-8["']?\s*\/?>/i.exec(out);
  if (!charset) throw new Error('UI template has no <meta charset> to anchor the CSP');
  const at = charset.index + charset[0].length;
  return out.slice(0, at) + '\n    ' + meta + out.slice(at);
}

/** Vendored modules the ui server may serve, by published file name. */
const VENDOR_MODULES = new Set(['babel-parser.mjs']);

/**
 * Source of a vendored module for `GET /vendor/<name>`, or null for anything
 * not on the allow-list (no path traversal: only fixed names resolve).
 * Looks next to this file first (dist/ui/vendor or src/ui/vendor), then in
 * the other tree, so both `tsx` dev runs and the built CLI find it.
 */
export function readVendorModule(name: string, dirs: string[] = vendorDirs()): string | null {
  if (!VENDOR_MODULES.has(name)) return null;
  for (const dir of dirs) {
    const file = path.join(dir, name);
    if (existsSync(file)) return readFileSync(file, 'utf8');
  }
  return null;
}

function vendorDirs(): string[] {
  const here = import.meta.dirname; // CLI floor is Node 24.3
  return [
    path.join(here, 'vendor'),
    path.join(here, '..', '..', 'dist', 'ui', 'vendor'),
    path.join(here, '..', '..', 'src', 'ui', 'vendor'),
  ];
}
