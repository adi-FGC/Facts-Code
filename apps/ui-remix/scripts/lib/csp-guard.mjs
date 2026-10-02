/**
 * The Content-Security-Policy checks the build runs on the two host files:
 * public/_headers (Cloudflare) and netlify.toml (Netlify).
 *
 * It reads rules that cf-headers.mjs (parseHeadersFile) and
 * netlify-headers.mjs (parseNetlifyTomlHeaders) already parsed, so each file
 * has one grammar. check-bundle-size.mjs used to carry a second hand-rolled
 * parser. That parser read a commented-out CSP line as the policy, and it
 * accepted the boot-script hash from anywhere in _headers, comments included.
 *
 * Per file, cspPolicyProblems checks that:
 *   - the main `/*` policy's script-src pins the inline boot script's hash.
 *     If the script changes without the hash, the browser silently blocks it
 *     (flash of the wrong theme);
 *   - SEC-3: the main style-src carries no 'unsafe-inline';
 *   - both sign-in URLs are keyed, and every /mcp-auth* block carries the
 *     same scoped policy, byte for byte.
 * What each host SENDS per path, and whether the two hosts agree, is checked
 * by cloudflareHeaderProblems, netlifyHeaderProblems and hostParityProblems.
 *
 * Used by check-bundle-size.mjs and netlify-headers.mjs, and unit-tested from
 * the repo-root test/ suite.
 */
import { createHash } from 'node:crypto';

/** The two URLs the MCP sign-in page is served at. Cloudflare 308s the
 *  `.html` one to the clean one; Netlify answers both. */
export const AUTH_PATHS = ['/mcp-auth', '/mcp-auth.html'];

const isCsp = (name) => /^content-security-policy$/i.test(name);

/** The CSP set by the first rule keyed exactly `pattern`, or undefined. */
export function cspFor(rules, pattern) {
  for (const rule of rules) {
    if (rule.pattern !== pattern) continue;
    const hit = rule.set.find(([name]) => isCsp(name));
    if (hit) return hit[1];
  }
  return undefined;
}

/** A policy → directive name (lower-cased) → its sources. As in a browser,
 *  a directive repeated later in the policy is ignored. */
export function parseCsp(value) {
  const out = new Map();
  for (const part of value.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/).filter(Boolean);
    if (name && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), sources);
  }
  return out;
}

/** Directives whose sources differ between two policies, ignoring source
 *  order: `{ directive, a, b }`, with '(absent)' for a missing directive. */
export function cspDirectiveDiff(a, b) {
  const pa = parseCsp(a);
  const pb = parseCsp(b);
  const norm = (sources) => (sources ? [...sources].sort().join(' ') : '(absent)');
  const out = [];
  for (const directive of [...new Set([...pa.keys(), ...pb.keys()])].sort()) {
    const x = norm(pa.get(directive));
    const y = norm(pb.get(directive));
    if (x !== y) out.push({ directive, a: x, b: y });
  }
  return out;
}

/** The `sha256-…` CSP source of the first bare inline <script> in `html`
 *  (the no-flash theme boot), or null when the page has none. */
export function bootScriptToken(html) {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  return m ? `sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}` : null;
}

/**
 * Problems with the policies themselves, as human-readable lines; empty = OK.
 * `hosts` is `[{ file, rules }]`, with the Cloudflare file first. Its
 * /mcp-auth policy is the canonical scoped policy, the same one the header
 * simulation expects. Leave `bootToken` out to skip the hash check.
 */
export function cspPolicyProblems(hosts, { bootToken } = {}) {
  const problems = [];
  const scoped = [];
  for (const { file, rules } of hosts) {
    const main = cspFor(rules, '/*');
    if (main === undefined) {
      problems.push(`${file} has no \`/*\` Content-Security-Policy (the main app policy).`);
    } else {
      const directives = parseCsp(main);
      if (bootToken && !(directives.get('script-src') ?? []).includes(`'${bootToken}'`))
        problems.push(
          `${file}: inline boot script drifted — the \`/*\` script-src must pin '${bootToken}'. ` +
            'Update the hash in apps/ui-remix/public/_headers AND netlify.toml.',
        );
      if ((directives.get('style-src') ?? []).includes("'unsafe-inline'"))
        problems.push(
          `${file}: the \`/*\` style-src must not contain 'unsafe-inline' (SEC-3) — ` +
            'inline styles were eliminated; the css() runtime uses adopted stylesheets.',
        );
    }
    for (const path of AUTH_PATHS)
      if (cspFor(rules, path) === undefined)
        problems.push(
          `${file} is missing the ${path} scoped CSP block. The sign-in page is served at ` +
            `${AUTH_PATHS.join(' and ')}; a URL without its own block gets the strict main CSP, ` +
            'which blocks the Firebase SDK.',
        );
    for (const rule of rules)
      if (rule.pattern.startsWith('/mcp-auth'))
        for (const [name, value] of rule.set)
          if (isCsp(name)) scoped.push({ file, pattern: rule.pattern, value });
  }
  const canonical = cspFor(hosts[0]?.rules ?? [], '/mcp-auth') ?? scoped[0]?.value;
  for (const s of scoped) {
    if (s.value === canonical) continue;
    const drift = cspDirectiveDiff(canonical, s.value).map((d) => d.directive);
    problems.push(
      `${s.file} ${s.pattern} scoped CSP differs from the canonical /mcp-auth policy` +
        (drift.length ? ` (${drift.join(', ')})` : '') +
        ' — every /mcp-auth* block must be byte-equal.',
    );
  }
  return problems;
}
