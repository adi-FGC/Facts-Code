/**
 * The Cloudflare `_headers` model (apps/ui-remix/scripts/lib/cf-headers.mjs)
 * and the real public/_headers it guards.
 *
 * Regression: /mcp-auth shipped TWO Content-Security-Policy headers (the `/*`
 * app policy + the scoped sign-in one) because Cloudflare applies every
 * matching rule and appends repeats. The browser enforced both, blocked the
 * gstatic Firebase import and the sign-in page never worked.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HTML_CACHE_CONTROL,
  cloudflareHeaderProblems,
  effectiveHeaders,
  htmlCacheControlProblem,
  parseHeadersFile,
  withRouteCacheRules,
} from '../apps/ui-remix/scripts/lib/cf-headers.mjs';
import { ROUTE_CATALOG } from '../packages/spec/src/routes.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEADERS = readFileSync(join(ROOT, 'apps/ui-remix/public/_headers'), 'utf8');

const cspOf = (text, path) =>
  effectiveHeaders(parseHeadersFile(text), path).get('content-security-policy') ?? [];

describe('Cloudflare _headers model', () => {
  it('appends a header a later matching rule sets again (the double-CSP bug)', () => {
    const txt =
      '/*\n  Content-Security-Policy: strict\n/login\n  Content-Security-Policy: scoped\n';
    expect(cspOf(txt, '/login')).toEqual(['strict', 'scoped']);
    expect(cspOf(txt, '/other')).toEqual(['strict']);
  });

  it('a `!` detach in the later block leaves exactly the later value', () => {
    const txt =
      '/*\n  Content-Security-Policy: strict\n/login\n  ! Content-Security-Policy\n  Content-Security-Policy: scoped\n';
    expect(cspOf(txt, '/login')).toEqual(['scoped']);
  });

  it('a detach ABOVE `/*` does nothing — file order matters', () => {
    const txt =
      '/login\n  ! Content-Security-Policy\n  Content-Security-Policy: scoped\n/*\n  Content-Security-Policy: strict\n';
    expect(cspOf(txt, '/login')).toEqual(['scoped', 'strict']);
  });

  it('`*` is a splat across segments and `:name` one segment', () => {
    const rules = parseHeadersFile('/a/*\n  X: 1\n/b/:id\n  Y: 2\n');
    expect(effectiveHeaders(rules, '/a/b/c').get('x')).toEqual(['1']);
    expect(effectiveHeaders(rules, '/b/1').get('y')).toEqual(['2']);
    expect(effectiveHeaders(rules, '/b/1/2').get('y')).toBeUndefined();
  });
});

describe('apps/ui-remix/public/_headers on Cloudflare', () => {
  const blocks = parseHeadersFile(HEADERS);
  const appCsp = blocks
    .find((r) => r.pattern === '/*')
    ?.set.find(([n]) => n === 'Content-Security-Policy')?.[1];
  const authCsp = blocks
    .find((r) => r.pattern === '/mcp-auth')
    ?.set.find(([n]) => n === 'Content-Security-Policy')?.[1];

  it('the sign-in page gets ONE CSP — the scoped one that allows gstatic', () => {
    expect(authCsp).toContain('https://www.gstatic.com');
    expect(
      cloudflareHeaderProblems(HEADERS, {
        authPaths: ['/mcp-auth', '/mcp-auth.html'],
        authCsp,
        appPaths: ['/', '/review', '/index.html'],
        appCsp,
      }),
    ).toEqual([]);
  });

  it('fails when there is no sign-in policy to check against, instead of passing silently', () => {
    // Regression: the build reads authCsp from the /mcp-auth block. Without that
    // block, /mcp-auth gets the one strict app CSP, the value check was skipped,
    // and only a separate inline parser in check-bundle-size.mjs caught it.
    const noAuth = HEADERS.replace(/\r\n/g, '\n').replace(/^\/mcp-auth\n(?:[ \t]+.*\n?)+/m, '');
    expect(parseHeadersFile(noAuth).some((r) => r.pattern === '/mcp-auth')).toBe(false);
    expect(cspOf(noAuth, '/mcp-auth')).toEqual([appCsp]);
    expect(
      cloudflareHeaderProblems(noAuth, {
        authPaths: ['/mcp-auth', '/mcp-auth.html'],
        authCsp: undefined,
        appPaths: ['/'],
        appCsp,
      }),
    ).toEqual([
      'no scoped sign-in Content-Security-Policy to check /mcp-auth, /mcp-auth.html against — is its _headers block missing?',
    ]);
    expect(cloudflareHeaderProblems(HEADERS, { appPaths: ['/'], appCsp: undefined })).toEqual([
      'no main app Content-Security-Policy to check 1 app path(s) against — is the `/*` _headers block missing?',
    ]);
  });

  it('every SPA route gets exactly one HTML Cache-Control once the build appends route rules', () => {
    const routes = ROUTE_CATALOG.map((r) => r.path);
    // Without the generated rules, clean URLs get no HTML policy at all (the live bug).
    expect(cloudflareHeaderProblems(HEADERS, { routePaths: ['/', '/review'] })).toHaveLength(2);
    const built = withRouteCacheRules(HEADERS, routes);
    const probes = [...routes, '/review/x', '/files/a/b'];
    expect(cloudflareHeaderProblems(built, { routePaths: probes })).toEqual([]);
    for (const p of [...probes, '/index.html'])
      expect(effectiveHeaders(parseHeadersFile(built), p).get('cache-control'), p).toEqual([
        HTML_CACHE_CONTROL,
      ]);
    // Assets keep their single immutable policy — no comma-joined duplicate.
    expect(
      effectiveHeaders(parseHeadersFile(built), '/assets/index-x.js').get('cache-control'),
    ).toEqual(['public, max-age=31536000, immutable']);
    // Idempotent: a re-run replaces the block instead of stacking a second one.
    expect(withRouteCacheRules(built, routes)).toBe(built);
  });

  /* Regression: the policy was `max-age=0, must-revalidate,
     stale-while-revalidate=604800`, and the guard passed any value carrying
     the SWR text. must-revalidate forbids serving stale (RFC 9111 §4.2.4), so
     the promised paint-from-cache never happened. */
  it('HTML is revalidated on every load, with no dead stale-while-revalidate', () => {
    expect(HTML_CACHE_CONTROL).toBe('public, max-age=0, must-revalidate');
    const dead = 'public, max-age=0, must-revalidate, stale-while-revalidate=604800';
    const rule = (v) => `/review\n  Cache-Control: ${v}\n`;
    expect(cloudflareHeaderProblems(rule(dead), { routePaths: ['/review'] })).toEqual([
      `/review receives Cache-Control [${dead}] on Cloudflare — expected exactly one "${HTML_CACHE_CONTROL}" (must-revalidate disables its stale-while-revalidate).`,
    ]);
    expect(htmlCacheControlProblem([HTML_CACHE_CONTROL])).toBeNull();
    expect(htmlCacheControlProblem([HTML_CACHE_CONTROL, HTML_CACHE_CONTROL])).toMatch(
      /^expected exactly one/,
    );
    const swr = parseHeadersFile(HEADERS)
      .flatMap((r) => r.set)
      .filter(([n, v]) => /^cache-control$/i.test(n) && /stale-while-revalidate/.test(v));
    expect(swr).toEqual([]);
  });
});
