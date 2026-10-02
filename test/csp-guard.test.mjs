/**
 * The CSP policy checks (apps/ui-remix/scripts/lib/csp-guard.mjs), the real
 * public/_headers + netlify.toml they guard, and check-bundle-size.mjs
 * running them end to end on a fixture dist.
 *
 * Regression (review, 2026-09-24): check-bundle-size.mjs carried a second,
 * hand-rolled CSP parser beside the cf-headers / netlify-headers models, so
 * the same two files had two grammars. It read a commented-out CSP line in
 * netlify.toml as the policy, and it accepted the boot-script hash if the
 * hash appeared anywhere in _headers, even in a comment. The checks now run
 * on the models' parsed rules. The header simulation now also fails when
 * _headers has no /mcp-auth policy to compare against; it used to skip the
 * check and pass.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parseHeadersFile, withRouteCacheRules } from '../apps/ui-remix/scripts/lib/cf-headers.mjs';
import {
  AUTH_PATHS,
  bootScriptToken,
  cspDirectiveDiff,
  cspFor,
  cspPolicyProblems,
  parseCsp,
} from '../apps/ui-remix/scripts/lib/csp-guard.mjs';
import { parseNetlifyTomlHeaders } from '../apps/ui-remix/scripts/lib/netlify-headers.mjs';
import { ROUTE_CATALOG } from '../packages/spec/src/routes.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'apps/ui-remix');
// LF-normalized: a Windows checkout may carry CRLF, and the regex edits below assume LF.
const lf = (f) => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const HEADERS = lf('apps/ui-remix/public/_headers');
const TOML = lf('netlify.toml');
const SOURCE_HTML = lf('apps/ui-remix/index.html');
const ROUTES = ROUTE_CATALOG.map((r) => r.path);
/** dist/_headers as the build publishes it (generate-discovery appends the route rules). */
const BUILT = withRouteCacheRules(HEADERS, ROUTES);

const hosts = (headers, toml) => [
  { file: '_headers', rules: parseHeadersFile(headers) },
  ...(toml == null ? [] : [{ file: 'netlify.toml', rules: parseNetlifyTomlHeaders(toml) }]),
];
const MAIN = cspFor(parseHeadersFile(HEADERS), '/*');
/** The boot-script hash the real `/*` policy pins. */
const TOKEN = (parseCsp(MAIN).get('script-src') ?? [])
  .find((s) => s.startsWith("'sha256-"))
  ?.slice(1, -1);
/** Drop a `_headers` block keyed exactly `pattern` (its indented lines too). */
const withoutHeadersBlock = (text, pattern) =>
  text.replace(new RegExp(`^${pattern.replace(/[.*]/g, '\\$&')}\\n(?:[ \\t]+.*\\n?)+`, 'm'), '');
const withoutTomlBlock = (text, pattern) =>
  text.replace(
    new RegExp(
      `\\[\\[headers\\]\\]\\s*\\nfor = "${pattern.replace(/[.*]/g, '\\$&')}"\\s*\\n[\\s\\S]*?(?=\\n\\n|\\n#|$)`,
    ),
    '',
  );

describe('CSP value helpers', () => {
  it('parses a policy the way a browser does: names lower-cased, a repeated directive ignored', () => {
    const p = parseCsp("default-src 'self'; Script-Src 'self' a.test;  ; script-src *");
    expect([...p.keys()]).toEqual(['default-src', 'script-src']);
    expect(p.get('script-src')).toEqual(["'self'", 'a.test']);
  });

  it('diffs two policies per directive, ignoring source order', () => {
    expect(cspDirectiveDiff('a-src x y; b-src z', 'b-src z; a-src y x')).toEqual([]);
    expect(cspDirectiveDiff('a-src x; c-src q', 'a-src x y; b-src z')).toEqual([
      { directive: 'a-src', a: 'x', b: 'x y' },
      { directive: 'b-src', a: '(absent)', b: 'z' },
      { directive: 'c-src', a: 'q', b: '(absent)' },
    ]);
  });

  it('hashes only the bare inline boot script', () => {
    expect(bootScriptToken('<script type="module" src="/a.js"></script>')).toBeNull();
    expect(bootScriptToken('<script type="application/json">{}</script>')).toBeNull();
    expect(bootScriptToken('<script>boot()</script><script>other()</script>')).toBe(
      `sha256-${createHash('sha256').update('boot()').digest('base64')}`,
    );
  });

  it('reads the CSP of the first rule keyed exactly that pattern', () => {
    const rules = parseHeadersFile('/*\n  X: 1\n/*\n  Content-Security-Policy: a\n/x\n  X: 2\n');
    expect(cspFor(rules, '/*')).toBe('a');
    expect(cspFor(rules, '/x')).toBeUndefined();
  });
});

describe('cspPolicyProblems on the real host files', () => {
  it('passes, and the pinned hash is the source boot script', () => {
    expect(TOKEN).toMatch(/^sha256-/);
    expect(bootScriptToken(SOURCE_HTML)).toBe(TOKEN);
    expect(cspPolicyProblems(hosts(BUILT, TOML), { bootToken: TOKEN })).toEqual([]);
  });

  it('flags a changed boot script in both files', () => {
    expect(cspPolicyProblems(hosts(BUILT, TOML), { bootToken: 'sha256-changed' })).toEqual([
      expect.stringMatching(/^_headers: inline boot script drifted/),
      expect.stringMatching(/^netlify\.toml: inline boot script drifted/),
    ]);
  });

  it('does not count the hash when it only appears in a comment', () => {
    const unpinned = `${BUILT.replace(` '${TOKEN}'`, '')}\n# was: script-src 'self' '${TOKEN}'\n`;
    expect(unpinned).toContain(TOKEN); // the old whole-file `includes` check passed this
    expect(cspPolicyProblems(hosts(unpinned, TOML), { bootToken: TOKEN })).toEqual([
      expect.stringMatching(/^_headers: inline boot script drifted/),
    ]);
  });

  it('does not read a commented-out CSP line in netlify.toml as the policy', () => {
    const commented = TOML.replace(
      'Content-Security-Policy = "',
      '# was: Content-Security-Policy = "default-src *"\nContent-Security-Policy = "',
    );
    expect(commented).toContain('# was: Content-Security-Policy');
    expect(cspFor(parseNetlifyTomlHeaders(commented), '/*')).toBe(MAIN);
    expect(cspPolicyProblems(hosts(BUILT, commented), { bootToken: TOKEN })).toEqual([]);
  });

  it("flags 'unsafe-inline' in the main style-src of either file (SEC-3)", () => {
    const loosen = (t) =>
      t.replace("style-src 'self'; script-src", "style-src 'self' 'unsafe-inline'; script-src");
    expect(loosen(BUILT)).not.toBe(BUILT);
    expect(loosen(TOML)).not.toBe(TOML);
    expect(cspPolicyProblems(hosts(loosen(BUILT), TOML))).toEqual([
      expect.stringMatching(/^_headers: the `\/\*` style-src must not contain 'unsafe-inline'/),
    ]);
    expect(cspPolicyProblems(hosts(BUILT, loosen(TOML)))).toEqual([
      expect.stringMatching(
        /^netlify\.toml: the `\/\*` style-src must not contain 'unsafe-inline'/,
      ),
    ]);
  });

  it('flags a missing sign-in block in either file', () => {
    for (const p of AUTH_PATHS) {
      const noCf = withoutHeadersBlock(BUILT, p);
      expect(cspFor(parseHeadersFile(noCf), p)).toBeUndefined();
      expect(cspPolicyProblems(hosts(noCf, TOML))).toContainEqual(
        expect.stringContaining(`_headers is missing the ${p} scoped CSP block`),
      );
      const noNf = withoutTomlBlock(TOML, p);
      expect(cspFor(parseNetlifyTomlHeaders(noNf), p)).toBeUndefined();
      expect(cspPolicyProblems(hosts(BUILT, noNf))).toEqual([
        expect.stringContaining(`netlify.toml is missing the ${p} scoped CSP block`),
      ]);
    }
  });

  it('flags a scoped block that drifted from the canonical /mcp-auth policy', () => {
    const drifted = TOML.replace(
      /(for = "\/mcp-auth\.html"\s*\n\[headers\.values\]\s*\nContent-Security-Policy = "[^"]*)"/,
      '$1; upgrade-insecure-requests"',
    );
    expect(drifted).not.toBe(TOML);
    expect(cspPolicyProblems(hosts(BUILT, drifted))).toEqual([
      'netlify.toml /mcp-auth.html scoped CSP differs from the canonical /mcp-auth policy ' +
        '(upgrade-insecure-requests) — every /mcp-auth* block must be byte-equal.',
    ]);
  });

  it('checks only _headers when the checkout has no netlify.toml', () => {
    expect(cspPolicyProblems(hosts(BUILT, null), { bootToken: TOKEN })).toEqual([]);
    expect(cspPolicyProblems(hosts(BUILT, null), { bootToken: 'sha256-changed' })).toHaveLength(1);
  });
});

describe('check-bundle-size.mjs runs the CSP and header guards (end to end)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fx-csp-guard-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const boot = SOURCE_HTML.match(/<script>([\s\S]*?)<\/script>/)[1];

  /** A minimal dist that passes every guard; `headers`/`html` override those files. */
  const run = (name, { headers = BUILT, html } = {}) => {
    const dist = join(tmp, name);
    const put = (rel, body) => {
      const f = join(dist, ...rel.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, body);
    };
    put('assets/index-Ab1_x.js', 'export {};\n');
    put(
      'index.html',
      html ??
        `<!doctype html><html><head><title>t</title><script>${boot}</script></head><body></body></html>`,
    );
    put('_headers', headers);
    put(
      'sitemap.xml',
      `<urlset>${ROUTES.map((p) => `<url><loc>https://example.dev${p}</loc></url>`).join('')}</urlset>`,
    );
    for (const f of [
      'llms.txt',
      'llms-full.txt',
      'robots.txt',
      'site.webmanifest',
      '.well-known/security.txt',
    ])
      put(f, 'x\n');
    put('.well-known/mcp.json', JSON.stringify({ mcp: { toolCount: 1, toolNames: ['t'] } }));
    const r = spawnSync(
      process.execPath,
      [join(APP, 'scripts/check-bundle-size.mjs'), '--dist', dist],
      {
        encoding: 'utf8',
      },
    );
    return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
  };

  it('passes a dist whose headers match the real policies', () => {
    const r = run('ok');
    expect(r.out).not.toMatch(/FAIL/);
    expect(r.status).toBe(0);
  });

  it('fails when _headers loses its /mcp-auth block, in the policy check AND the header simulation', () => {
    const r = run('no-auth', { headers: withoutHeadersBlock(BUILT, '/mcp-auth') });
    expect(r.status).toBe(1);
    expect(r.out).toContain('CSP guard: _headers is missing the /mcp-auth scoped CSP block');
    expect(r.out).toContain(
      'header guard (Cloudflare): no scoped sign-in Content-Security-Policy to check /mcp-auth, /mcp-auth.html against',
    );
  });

  it('fails when the boot script drifts from the hash both files pin', () => {
    const r = run('drift', {
      html: '<!doctype html><html><head><title>t</title><script>changed()</script></head></html>',
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain('CSP guard: _headers: inline boot script drifted');
    expect(r.out).toContain('CSP guard: netlify.toml: inline boot script drifted');
  });
});
