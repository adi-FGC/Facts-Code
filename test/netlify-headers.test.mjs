/**
 * The Netlify header model (apps/ui-remix/scripts/lib/netlify-headers.mjs)
 * and the real netlify.toml + public/_headers it guards.
 *
 * Regression: on Netlify the clean URL /mcp-auth served the sign-in page with
 * the strict app CSP (seen live 2026-09-24). Netlify merges dist/_headers
 * UNDER netlify.toml and a later rule replaces a header, so netlify.toml's
 * `/*` beat the _headers /mcp-auth block; the Firebase SDK was blocked. The
 * model was checked against Netlify's own @netlify/headers-parser 10.1.1 +
 * the CLI's headersForPath on 27 paths (old and new netlify.toml): identical.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HTML_CACHE_CONTROL,
  parseHeadersFile,
  withRouteCacheRules,
} from '../apps/ui-remix/scripts/lib/cf-headers.mjs';
import {
  hostParityProblems,
  netlifyEffectiveHeaders,
  netlifyHeaderProblems,
  netlifyPatternRegExp,
  parseNetlifyTomlHeaders,
} from '../apps/ui-remix/scripts/lib/netlify-headers.mjs';
import { ROUTE_CATALOG } from '../packages/spec/src/routes.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// LF-normalized: a Windows checkout may carry CRLF, and the regex edits below assume LF.
const lf = (f) => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const HEADERS = lf('apps/ui-remix/public/_headers');
const TOML = lf('netlify.toml');
const ROUTES = ROUTE_CATALOG.map((r) => r.path);
/** dist/_headers as the build publishes it (generate-discovery appends the route rules). */
const BUILT = withRouteCacheRules(HEADERS, ROUTES);

const toml = (...blocks) =>
  blocks
    .map(([path, values]) =>
      [
        '[[headers]]',
        `for = "${path}"`,
        '[headers.values]',
        ...Object.entries(values).map(([k, v]) => `${k} = "${v}"`),
      ].join('\n'),
    )
    .join('\n\n');
const cspOf = (headers, t, path) =>
  netlifyEffectiveHeaders(headers, t, path).get('content-security-policy') ?? [];

describe('Netlify header model', () => {
  it('a later matching rule REPLACES a header (no second CSP, unlike Cloudflare)', () => {
    const t = toml(
      ['/*', { 'Content-Security-Policy': 'strict' }],
      ['/login', { 'Content-Security-Policy': 'scoped' }],
    );
    expect(cspOf('', t, '/login')).toEqual(['scoped']);
    expect(cspOf('', t, '/other')).toEqual(['strict']);
  });

  it('netlify.toml wins over _headers for the same header — the live /mcp-auth bug', () => {
    const headers =
      '/*\n  Content-Security-Policy: strict\n/login\n  ! Content-Security-Policy\n  Content-Security-Policy: scoped\n';
    const onlyStar = toml(['/*', { 'Content-Security-Policy': 'strict' }]);
    expect(cspOf(headers, onlyStar, '/login')).toEqual(['strict']);
    const keyed = toml(
      ['/*', { 'Content-Security-Policy': 'strict' }],
      ['/login', { 'Content-Security-Policy': 'scoped' }],
    );
    expect(cspOf(headers, keyed, '/login')).toEqual(['scoped']);
    // Order inside netlify.toml matters: keyed ABOVE `/*` loses again.
    const above = toml(
      ['/login', { 'Content-Security-Policy': 'scoped' }],
      ['/*', { 'Content-Security-Policy': 'strict' }],
    );
    expect(cspOf(headers, above, '/login')).toEqual(['strict']);
  });

  it('matches paths the way @netlify/headers-parser does', () => {
    expect(netlifyPatternRegExp('/review/*').test('/review')).toBe(true); // standalone * is optional
    expect(netlifyPatternRegExp('/review/*').test('/review/a/b')).toBe(true);
    expect(netlifyPatternRegExp('/').test('/')).toBe(true);
    expect(netlifyPatternRegExp('/mcp-auth').test('/MCP-AUTH/')).toBe(true); // case, trailing slash
    expect(netlifyPatternRegExp('/b/:id').test('/b/1/2')).toBe(false);
    expect(netlifyPatternRegExp('/*.html').test('/a/index.html')).toBe(true);
  });

  it('parses netlify.toml [[headers]] tables and skips `!` lines in _headers', () => {
    const rules = parseNetlifyTomlHeaders(
      '[build]\npublish = "dist"\n\n' +
        toml(['/x', { 'Cache-Control': 'a', 'X-Y': 'b' }]) +
        '\n\n[[redirects]]\nfrom = "/*"\nto = "/index.html"\n',
    );
    expect(rules).toEqual([
      {
        pattern: '/x',
        set: [
          ['Cache-Control', 'a'],
          ['X-Y', 'b'],
        ],
      },
    ]);
    expect(netlifyEffectiveHeaders('/x\n  ! X-Y\n  X-Z: 1\n', '', '/x').get('x-z')).toEqual(['1']);
  });
});

describe('netlify.toml + public/_headers on Netlify', () => {
  const blocks = parseHeadersFile(BUILT);
  const cspIn = (p) =>
    blocks.find((r) => r.pattern === p)?.set.find(([n]) => n === 'Content-Security-Policy')?.[1];
  const expected = {
    authPaths: ['/mcp-auth', '/mcp-auth.html'],
    authCsp: cspIn('/mcp-auth'),
    appPaths: ['/', '/index.html', ...ROUTES],
    appCsp: cspIn('/*'),
    routePaths: [...ROUTES, '/review/x'],
  };

  it('both sign-in URLs get ONE CSP — the scoped one that allows gstatic', () => {
    expect(expected.authCsp).toContain('https://www.gstatic.com');
    expect(netlifyHeaderProblems(BUILT, TOML, expected)).toEqual([]);
    expect(cspOf(BUILT, TOML, '/mcp-auth')).toEqual([expected.authCsp]);
  });

  it('flags the pre-fix netlify.toml (no /mcp-auth key) — the regression', () => {
    const noClean = TOML.replace(
      /\[\[headers\]\]\s*\nfor = "\/mcp-auth"\s*\n[\s\S]*?(?=\n\n|\n#|$)/,
      '',
    );
    expect(noClean).not.toMatch(/for = "\/mcp-auth"/);
    expect(netlifyHeaderProblems(BUILT, noClean, expected)).toEqual([
      expect.stringMatching(/^\/mcp-auth receives the wrong Content-Security-Policy on Netlify/),
    ]);
  });

  it('Cloudflare and Netlify send the same Cache-Control and CSP on every probed path', () => {
    const probes = [
      ...expected.appPaths,
      ...expected.authPaths,
      '/review/x',
      '/files/a/b',
      '/assets/index-x.js',
      '/fonts/x.woff2',
      '/data/factstack.json',
      '/factstack.pack',
      '/site.webmanifest',
      '/mcp-auth-config.json',
    ];
    expect(hostParityProblems(BUILT, TOML, probes)).toEqual([]);
    // Drift in netlify.toml's own `/*.html` rule is caught (it used to drift silently).
    const drifted = TOML.replace(
      /(for = "\/\*\.html"[\s\S]*?Cache-Control = ")[^"]*/,
      '$1public, max-age=3600',
    );
    expect(hostParityProblems(BUILT, drifted, ['/index.html'])).toEqual([
      expect.stringMatching(/^\/index\.html cache-control: Cloudflare sends \[public, max-age=0/),
    ]);
  });

  /* Regression: the Netlify guard passed any route value carrying
     `stale-while-revalidate`, which must-revalidate next to it disables. */
  it('every route gets exactly the HTML policy on Netlify, never a dead SWR', () => {
    for (const p of expected.routePaths)
      expect(netlifyEffectiveHeaders(BUILT, TOML, p).get('cache-control'), p).toEqual([
        HTML_CACHE_CONTROL,
      ]);
    const dead = BUILT.replaceAll(
      `Cache-Control: ${HTML_CACHE_CONTROL}`,
      `Cache-Control: ${HTML_CACHE_CONTROL}, stale-while-revalidate=604800`,
    );
    expect(netlifyHeaderProblems(dead, TOML, { routePaths: ['/review'] })).toEqual([
      expect.stringMatching(
        /^\/review receives Cache-Control \[.*\] on Netlify — expected exactly one ".*" \(must-revalidate disables its stale-while-revalidate\)\.$/,
      ),
    ]);
  });

  it('fails when there is no sign-in policy to check against, instead of passing silently', () => {
    expect(netlifyHeaderProblems(BUILT, TOML, { ...expected, authCsp: undefined })).toEqual([
      expect.stringMatching(/^no scoped sign-in Content-Security-Policy to check \/mcp-auth, /),
    ]);
  });

  it('names the drifted directive when the two hosts send different CSPs', () => {
    // Regression: the policies are ~400 chars and the message truncated at 90,
    // so a connect-src drift printed two identical-looking prefixes.
    const drifted = TOML.replace(
      "connect-src 'self' https://api.osv.dev",
      "connect-src 'self' https://example.dev https://api.osv.dev",
    );
    expect(drifted).not.toBe(TOML);
    expect(hostParityProblems(BUILT, drifted, ['/'])).toEqual([
      '/ content-security-policy: Cloudflare and Netlify differ in connect-src (Cloudflare [' +
        "'self' https://api.github.com https://api.osv.dev https://raw.githubusercontent.com], " +
        "Netlify ['self' https://api.github.com https://api.osv.dev https://example.dev " +
        'https://raw.githubusercontent.com]).',
    ]);
  });

  it('keeps per-route cache rules out of netlify.toml — dist/_headers already covers them', () => {
    // A `/*` Cache-Control in netlify.toml would also override /assets/* immutable.
    expect(
      parseNetlifyTomlHeaders(TOML).filter(
        (r) => r.pattern === '/*' && r.set.some(([n]) => /^cache-control$/i.test(n)),
      ),
    ).toEqual([]);
    expect(netlifyEffectiveHeaders(BUILT, TOML, '/assets/index-x.js').get('cache-control')).toEqual(
      ['public, max-age=31536000, immutable'],
    );
  });
});
