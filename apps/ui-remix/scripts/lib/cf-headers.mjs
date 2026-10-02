/**
 * A model of how Cloudflare Pages applies a `_headers` file, so the build can
 * check what a browser will actually receive instead of what each block says.
 *
 * Cloudflare applies EVERY rule whose path matches, in file order. Per rule it
 * first deletes the `! Name` detaches, then sets each header — or APPENDS it
 * when an earlier matching rule already set that name (the asset server's
 * `attachHeaders`). So `/*` and `/mcp-auth` both setting a CSP ship two
 * policies on /mcp-auth, and a browser enforces both: the strict app policy
 * then blocks the Firebase SDK the scoped one allows. Only a
 * `! Content-Security-Policy` detach in the later block leaves one.
 *
 * Pure: text in, data out. Used by check-bundle-size.mjs (build guard) and
 * generate-discovery.mjs (per-route cache rules), and unit-tested from the
 * repo-root test/ suite.
 */

/** Parse `_headers` text into ordered rules `{ pattern, set: [[name, value]], unset: [name] }`. */
export function parseHeadersFile(text) {
  const rules = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      cur = { pattern: line.trim(), set: [], unset: [] };
      rules.push(cur);
      continue;
    }
    if (!cur) continue;
    const t = line.trim();
    if (t.startsWith('!')) {
      cur.unset.push(t.slice(1).trim());
      continue;
    }
    const ix = t.indexOf(':');
    if (ix > 0) cur.set.push([t.slice(0, ix).trim(), t.slice(ix + 1).trim()]);
  }
  return rules;
}

/** Cloudflare path pattern → RegExp: `*` is a splat (crosses `/`), `:name` one segment. */
export function patternRegExp(pattern) {
  const body = pattern
    .split(/(\*|:[A-Za-z]\w*)/)
    .map((part) =>
      part === '*'
        ? '.*'
        : /^:[A-Za-z]\w*$/.test(part)
          ? '[^/]+'
          : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');
  return new RegExp(`^${body}$`);
}

/**
 * The headers Cloudflare sends for `path`: lower-cased name → every value, in
 * the order they would appear. More than one value = the browser gets that
 * header more than once.
 */
export function effectiveHeaders(rules, path) {
  const out = new Map();
  const seen = new Set();
  for (const rule of rules) {
    if (!patternRegExp(rule.pattern).test(path)) continue;
    for (const name of rule.unset) out.delete(name.toLowerCase());
    for (const [name, value] of rule.set) {
      const k = name.toLowerCase();
      if (seen.has(k)) out.set(k, [...(out.get(k) ?? []), value]);
      else {
        out.set(k, [value]);
        seen.add(k);
      }
    }
  }
  return out;
}

/**
 * The HTML policy every page route gets: revalidate on every load, so a
 * redeploy ships instantly. No stale-while-revalidate: next to
 * must-revalidate it is dead (RFC 9111 §4.2.4; Chromium drops the SWR window),
 * and without must-revalidate a stale page would request the previous
 * deploy's /assets/* hashes, which an atomic Pages deploy no longer has (the
 * SPA fallback answers them with index.html).
 */
export const HTML_CACHE_CONTROL = 'public, max-age=0, must-revalidate';

/** What is wrong with a page's Cache-Control values, or null when they are
 *  exactly one HTML_CACHE_CONTROL. Shared with netlifyHeaderProblems. */
export function htmlCacheControlProblem(values) {
  if (values.length === 1 && values[0] === HTML_CACHE_CONTROL) return null;
  const dead = values.some((v) => /must-revalidate/.test(v) && /stale-while-revalidate/.test(v));
  return (
    `expected exactly one "${HTML_CACHE_CONTROL}"` +
    (dead ? ' (must-revalidate disables its stale-while-revalidate)' : '')
  );
}

const ROUTE_BLOCK_BEGIN = '# BEGIN generated: SPA route cache rules (generate-discovery.mjs)';
const ROUTE_BLOCK_END = '# END generated: SPA route cache rules';

/**
 * Append (or replace) one cache rule per SPA route. `/*.html` never matches
 * what Cloudflare serves — it serves clean URLs (`/`, `/review`), so the HTML
 * policy has to be keyed on the routes themselves. Never on `/*`: that would
 * also match `/assets/*`, and Cloudflare would comma-join the two
 * Cache-Control values into one contradictory header.
 */
export function withRouteCacheRules(text, routePaths) {
  const start = text.indexOf(ROUTE_BLOCK_BEGIN);
  const base =
    start >= 0
      ? text.slice(0, start) +
        text.slice(text.indexOf(ROUTE_BLOCK_END, start) + ROUTE_BLOCK_END.length)
      : text;
  const lines = [ROUTE_BLOCK_BEGIN];
  for (const p of [...new Set(routePaths)]) {
    const keys = p === '/' ? ['/'] : [p, `${p}/*`];
    for (const key of keys) lines.push(key, `  Cache-Control: ${HTML_CACHE_CONTROL}`);
  }
  lines.push(ROUTE_BLOCK_END);
  return base.replace(/\s*$/, '\n\n') + lines.join('\n') + '\n';
}

/**
 * Paths to check but no policy to check them against. The caller reads
 * `authCsp` / `appCsp` from the `_headers` blocks, so a missing block used to
 * skip the value check and pass silently. Shared with netlifyHeaderProblems.
 */
export function missingPolicyProblems({ authPaths = [], authCsp, appPaths = [], appCsp }) {
  const problems = [];
  if (authPaths.length && !authCsp)
    problems.push(
      `no scoped sign-in Content-Security-Policy to check ${authPaths.join(', ')} against — ` +
        'is its _headers block missing?',
    );
  if (appPaths.length && !appCsp)
    problems.push(
      `no main app Content-Security-Policy to check ${appPaths.length} app path(s) against — ` +
        'is the `/*` _headers block missing?',
    );
  return problems;
}

/**
 * What a browser would get wrong on this host. Returns human-readable
 * problems; empty = the file does what its comments say.
 *   - every `authPaths` entry gets exactly ONE CSP, equal to `authCsp`;
 *   - every `appPaths` entry gets exactly ONE CSP, equal to `appCsp`;
 *   - paths given without the policy to compare them to are a problem too;
 *   - every `routePaths` entry gets exactly one Cache-Control, HTML_CACHE_CONTROL.
 */
export function cloudflareHeaderProblems(
  text,
  { authPaths = [], authCsp, appPaths = [], appCsp, routePaths = [] },
) {
  const rules = parseHeadersFile(text);
  const problems = missingPolicyProblems({ authPaths, authCsp, appPaths, appCsp });
  const expectOneCsp = (path, want, what) => {
    const got = effectiveHeaders(rules, path).get('content-security-policy') ?? [];
    if (got.length !== 1)
      problems.push(
        `${path} receives ${got.length} Content-Security-Policy headers on Cloudflare (a browser enforces all of them) — ` +
          `add \`! Content-Security-Policy\` to the ${path} block so only the ${what} policy remains.`,
      );
    else if (want && got[0] !== want)
      problems.push(
        `${path} receives the wrong Content-Security-Policy — expected the ${what} policy.`,
      );
  };
  for (const p of authPaths) expectOneCsp(p, authCsp, 'scoped sign-in');
  for (const p of appPaths) expectOneCsp(p, appCsp, 'main app');
  for (const p of routePaths) {
    const got = effectiveHeaders(rules, p).get('cache-control') ?? [];
    const why = htmlCacheControlProblem(got);
    if (why)
      problems.push(
        `${p} receives Cache-Control [${got.join(' | ') || 'none'}] on Cloudflare — ${why}.`,
      );
  }
  return problems;
}
