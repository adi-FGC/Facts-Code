/**
 * A model of how Netlify applies headers, the twin of cf-headers.mjs, so the
 * build can check what a browser receives on the Netlify mirror too.
 *
 * Netlify reads the published `_headers` AND `netlify.toml` `[[headers]]`,
 * and puts the file rules first (@netlify/headers-parser mergeHeaders). Every
 * rule whose path matches is applied in that order and a later value
 * REPLACES an earlier one for the same header (the CLI's headersForPath is
 * `Object.assign`). So `netlify.toml`'s `/*` CSP beats a `_headers` /mcp-auth
 * block — the clean sign-in URL got the strict app policy (seen live
 * 2026-09-24) until netlify.toml keyed /mcp-auth itself, below its `/*`.
 * `! Name` lines have no `:` and are skipped. Same header twice inside ONE
 * block is comma-joined.
 *
 * Pure: text in, data out. Used by check-bundle-size.mjs and unit-tested from
 * the repo-root test/ suite (which also pins it to the real netlify.toml).
 */
import {
  effectiveHeaders,
  htmlCacheControlProblem,
  missingPolicyProblems,
  parseHeadersFile,
} from './cf-headers.mjs';
import { cspDirectiveDiff } from './csp-guard.mjs';

/** Netlify `for` path → RegExp (port of @netlify/headers-parser getForRegExp):
 *  case-insensitive, optional trailing slash, a standalone `*` segment is
 *  optional (`/review/*` also matches `/review`), `:name` is one segment. */
export function netlifyPatternRegExp(forPath) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = forPath
    .split('/')
    .map((p) => p.trimEnd())
    .filter(Boolean)
    .map((p) =>
      p.startsWith(':')
        ? '([^/]+)'
        : p === '*'
          ? '?(.*)'
          : p.includes('*')
            ? p.replaceAll('*', '(.*)') // unescaped, as upstream: `.` stays a wildcard
            : esc(p),
    )
    .join('/');
  return new RegExp(`^/${body}/?$`, 'iu');
}

/** `netlify.toml` → ordered rules `{ pattern, set: [[name, value]] }`, from
 *  each `[[headers]]` table's `for` and `[headers.values]`. Handles the basic
 *  `key = "string"` form this repo uses; anything else in a block is ignored. */
export function parseNetlifyTomlHeaders(text) {
  const rules = [];
  let cur = null;
  let inValues = false;
  const str = (quoted) => JSON.parse(quoted);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      if (line === '[[headers]]') {
        cur = { pattern: null, set: [] };
        rules.push(cur);
        inValues = false;
      } else if (line === '[headers.values]' && cur) inValues = true;
      else cur = null; // any other table ends the headers block
      continue;
    }
    if (!cur) continue;
    const m = line.match(/^("[^"]+"|[A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/);
    if (!m) continue;
    const key = m[1].startsWith('"') ? str(m[1]) : m[1];
    if (inValues) cur.set.push([key, str(m[2])]);
    else if (key === 'for') cur.pattern = str(m[2]);
  }
  return rules.filter((r) => r.pattern);
}

/** One block's headers as Netlify sends them: repeats within it comma-joined. */
function blockValues(set) {
  const out = {};
  for (const [name, value] of set) out[name] = name in out ? `${out[name]}, ${value}` : value;
  return out;
}

/**
 * The headers Netlify sends for `path`, in the same shape as cf-headers'
 * effectiveHeaders: lower-cased name → values. Netlify overrides rather than
 * appends, so there is one value per name unless two rules spell the same
 * header in different letter case (then the browser gets both).
 */
export function netlifyEffectiveHeaders(headersText, tomlText, path) {
  const rules = [...parseHeadersFile(headersText), ...parseNetlifyTomlHeaders(tomlText)];
  const merged = Object.assign(
    {},
    ...rules
      .filter((r) => netlifyPatternRegExp(r.pattern).test(path))
      .map((r) => blockValues(r.set)),
  );
  const out = new Map();
  for (const [name, value] of Object.entries(merged)) {
    const k = name.toLowerCase();
    out.set(k, [...(out.get(k) ?? []), value]);
  }
  return out;
}

/**
 * What a browser would get wrong on Netlify, same contract as
 * cloudflareHeaderProblems: one CSP per path, the right one; exactly one
 * HTML_CACHE_CONTROL per route.
 */
export function netlifyHeaderProblems(
  headersText,
  tomlText,
  { authPaths = [], authCsp, appPaths = [], appCsp, routePaths = [] },
) {
  const problems = missingPolicyProblems({ authPaths, authCsp, appPaths, appCsp });
  const expectOneCsp = (path, want, what) => {
    const got =
      netlifyEffectiveHeaders(headersText, tomlText, path).get('content-security-policy') ?? [];
    if (got.length !== 1)
      problems.push(`${path} receives ${got.length} Content-Security-Policy headers on Netlify.`);
    else if (want && got[0] !== want)
      problems.push(
        `${path} receives the wrong Content-Security-Policy on Netlify — expected the ${what} policy. ` +
          'netlify.toml rules override _headers, so a path that needs its own CSP must be keyed in netlify.toml, below `/*`.',
      );
  };
  for (const p of authPaths) expectOneCsp(p, authCsp, 'scoped sign-in');
  for (const p of appPaths) expectOneCsp(p, appCsp, 'main app');
  for (const p of routePaths) {
    const got = netlifyEffectiveHeaders(headersText, tomlText, p).get('cache-control') ?? [];
    const why = htmlCacheControlProblem(got);
    if (why)
      problems.push(
        `${p} receives Cache-Control [${got.join(' | ') || 'none'}] on Netlify — ${why}.`,
      );
  }
  return problems;
}

/**
 * Paths where the two hosts would send a different value for any header
 * either file sets. Cloudflare's repeated values are compared comma-joined,
 * which is how HTTP treats a repeated header. A single-policy CSP drift is
 * reported per directive: the policies are long, and a truncated value would
 * hide where they differ.
 */
export function hostParityProblems(headersText, tomlText, paths) {
  const cfRules = parseHeadersFile(headersText);
  const problems = [];
  const short = (v) => (v ? (v.length > 90 ? `${v.slice(0, 90)}…` : v) : 'none');
  for (const path of paths) {
    const cf = effectiveHeaders(cfRules, path);
    const nf = netlifyEffectiveHeaders(headersText, tomlText, path);
    for (const name of [...new Set([...cf.keys(), ...nf.keys()])].sort()) {
      const av = cf.get(name) ?? [];
      const bv = nf.get(name) ?? [];
      const a = av.join(', ');
      const b = bv.join(', ');
      if (a === b) continue;
      const drift =
        name === 'content-security-policy' && av.length === 1 && bv.length === 1
          ? cspDirectiveDiff(a, b)
          : [];
      problems.push(
        drift.length
          ? `${path} ${name}: Cloudflare and Netlify differ in ` +
              drift
                .map((d) => `${d.directive} (Cloudflare [${d.a}], Netlify [${d.b}])`)
                .join('; ') +
              '.'
          : `${path} ${name}: Cloudflare sends [${short(a)}] but Netlify sends [${short(b)}].`,
      );
    }
  }
  return problems;
}
