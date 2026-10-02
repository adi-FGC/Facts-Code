/**
 * Regression tests for the CLI's local UI (legacy prototype → `factstack ui`,
 * `export`, `quick`): stored XSS, offline/no-CDN build, dataset embedding,
 * CSP and the vendored @babel/parser. They run against both the prototype
 * source and the committed build (apps/cli/src/ui/index.html).
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import {
  inlineScriptHashes,
  injectInlineData,
  jsonForScriptBlock,
  prepareStaticReport,
  readVendorModule,
  uiContentSecurityPolicy,
} from '../../src/ui/embed.js';
import {
  CLI_ROOT,
  DATA_PLACEHOLDER,
  PROTOTYPE_SRC,
  assertNoRemoteResources,
  buildTemplate,
  bundleBabelParser,
  compileTailwind,
} from '../lib/build-ui.mjs';
import { SANITIZERS, auditHtmlSinks, extractFunctionSource } from '../lib/ui-xss-audit.mjs';

const source = readFileSync(PROTOTYPE_SRC, 'utf8');
const built = readFileSync(path.join(CLI_ROOT, 'src', 'ui', 'index.html'), 'utf8');
const DATA_OPEN = '<script id="factstack-data" type="application/json">';
const dataBody = (html: string): string => {
  const at = html.indexOf(DATA_OPEN) + DATA_OPEN.length;
  return html.slice(at, html.indexOf('</script>', at));
};
const tmp = mkdtempSync(path.join(tmpdir(), 'facts-legacy-ui-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const HOSTILE = [
  '<img src=x onerror=alert(1)>',
  '"><svg onload=alert(1)>',
  "' onmouseover='alert(1)",
  'red;" onmouseover="alert(1)',
  '</script><script>alert(1)</script>',
  '<!--<script>',
];

describe('stored XSS in the local UI (security#3)', () => {
  it('no unescaped value reaches an HTML sink in the prototype source', () => {
    expect(auditHtmlSinks(source)).toEqual([]);
  });

  it('no unescaped value reaches an HTML sink in the shipped CLI template', () => {
    expect(auditHtmlSinks(built)).toEqual([]);
  });

  it('the audit flags the pre-fix tree-row pattern (raw names, colors, h({html}))', () => {
    const fixture = `<script type="module">
      const h = (tag, attrs = {}) => {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) if (k === 'html') el.innerHTML = v;
        return el;
      };
      function escapeHtml(s) { return String(s); }
      function renderTree(node) {
        for (const c of node.children) {
          const row = h('div');
          row.innerHTML = \`<span class="truncate">\${c.name}</span>\`;
        }
        for (const f of node.files) {
          const langColor = f.language?.iconColor || 'var(--fg-muted)';
          const row = h('div');
          row.innerHTML = \`<span style="color:\${langColor};">\${f.language?.tag}</span><span>\${escapeHtml(f.name)}</span>\`;
        }
        h('p', { html: '<b>' + node.name + '</b>' });
        document.write(\`<i>\${node.path}</i>\`);
        frame.srcdoc = node.readme;
      }
    </script>`;
    const exprs = auditHtmlSinks(fixture).map((f) => f.expr);
    expect(exprs).toEqual(
      expect.arrayContaining([
        'c.name',
        'f.language?.iconColor',
        'f.language?.tag',
        'node.name',
        'node.path',
        'node.readme',
      ]),
    );
    expect(exprs).not.toContain('escapeHtml(f.name)');
    expect(exprs).not.toContain('v'); // the h() helper's own sink is not a finding
  });

  // Review legacy-ui-R1: patterns that used to slip past the audit.
  const audit = (body: string) =>
    auditHtmlSinks(`<script type="module">
      function escapeHtml(s) { return String(s).replace(/[&<>"']/g, ''); }
      const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);
      function render(f, files) {
        ${body}
      }
    </script>`).map((x) => x.expr);

  it.each([
    ['a dataset-shaped .size / .length', 'el.innerHTML = `${f.size} of ${files.length}`;'],
    [
      'a lookup table written after its literal',
      "const T = { a: 'x' }; T.label = f.name; el.innerHTML = T.label + T[f.k];",
    ],
    [
      'an array filled through a helper parameter',
      "const add = (a, v) => a.push(v); const parts = []; add(parts, f.name); el.innerHTML = parts.join('');",
    ],
    [
      'an array filled through an alias',
      "const parts = []; const alias = parts; alias.push(f.name); el.innerHTML = parts.join('');",
    ],
    [
      'Object.assign into a lookup table',
      "const T = { a: 'x' }; Object.assign(T, { b: f.name }); el.innerHTML = T[f.k];",
    ],
    [
      'a local that shadows a sanitizer',
      'const escapeHtml = (s) => s; el.innerHTML = escapeHtml(f.name);',
    ],
    [
      'a parameter that shadows a sanitizer',
      '((num) => { el.innerHTML = num(f.name); })((s) => s);',
    ],
    ['a reassigned sanitizer', 'escapeHtml = (s) => s; el.innerHTML = escapeHtml(f.name);'],
    [
      'a reassigned local helper',
      "let fmt = () => 'x'; fmt = (x) => x; el.innerHTML = fmt(f.name);",
    ],
    ['a string built by reduce', "el.innerHTML = files.reduce((a, x) => a + x.name, '');"],
  ])('the audit flags %s', (_, body) => {
    expect(audit(body)).not.toEqual([]);
  });

  it('the audit still accepts the sanitized forms of those patterns', () => {
    expect(
      audit(`
        el.innerHTML = \`\${num(f.size)} of \${num(files.length)}\`;
        const T = { a: 'x' }; T.label = escapeHtml(f.name); el.innerHTML = T.label + T[f.k];
        const add = (a, v) => a.push(escapeHtml(v)); const parts = []; add(parts, f.name);
        const alias = parts; alias.push('<b>'); el.innerHTML = parts.join('');
      `),
    ).toEqual([]);
  });

  it('every sanitizer the audit trusts neutralizes hostile input', () => {
    const names = ['isSafeColor', ...SANITIZERS];
    const src = names
      .map((n) => extractFunctionSource(source, n) ?? `/* missing ${n} */`)
      .join('\n');
    for (const n of names) expect(src, `${n} not found in prototype`).not.toContain(`missing ${n}`);
    // Test-only: evaluates the prototype's own sanitizer source in isolation.
    const fns = new Function(`${src}\nreturn { ${names.join(', ')} };`)() as Record<
      string,
      (v: unknown) => unknown
    >;
    for (const bad of [...HOSTILE, { toString: () => '<b>' }, Number.NaN, null, undefined]) {
      expect(String(fns.escapeHtml!(bad))).not.toMatch(/[<>"']/);
      for (const n of ['num', 'fmtTok', 'fmtBytes', 'fmtNum']) {
        expect(String(fns[n]!(bad)), n).toMatch(/^[\d.,]+ ?[A-Z]*$/);
      }
      expect(String(fns.cssColor!(bad))).toBe('var(--fg-muted)');
      expect(String(fns.cssIdent!(bad))).toMatch(/^[\w-]*$/);
    }
    expect(fns.cssColor!('#1850b8')).toBe('#1850b8');
    expect(fns.cssColor!('var(--lang-typescript)')).toBe('var(--lang-typescript)');
  });
});

describe('dataset embedding (ux#4, blank page on "<!--<script")', () => {
  const loadDefault = async (inlineText: string) => {
    const src = ['loadDefault', 'emptyDataset']
      .map((n) => extractFunctionSource(source, n))
      .join('\n');
    const doc = { getElementById: () => ({ textContent: inlineText }) };
    const offline = () => Promise.reject(new Error('offline (file://)'));
    const quiet = { warn() {}, error() {} };
    // Test-only: runs the prototype's loader against a stubbed document.
    const run = new Function(
      'document',
      'fetch',
      'console',
      `let DATA = null;\n${src}\nreturn loadDefault().then(() => DATA);`,
    );
    return (await run(doc, offline, quiet)) as {
      summary?: { description?: string };
      project?: { name?: string };
    };
  };

  it('uses an inline dataset that merely mentions the placeholder token', async () => {
    const dataset = { summary: { description: `README documents ${DATA_PLACEHOLDER}` } };
    expect(await loadDefault(jsonForScriptBlock(dataset))).toEqual(dataset);
  });

  it('treats only the bare placeholder as "no inline data"', async () => {
    const data = await loadDefault(`\n  ${DATA_PLACEHOLDER}\n    `);
    expect(data.project?.name).toBe('no data loaded');
  });

  it('writes no "<" into the data block, so repo text cannot end it or swallow the page', () => {
    const data = { notes: HOSTILE, readme: `x ${DATA_PLACEHOLDER} y` };
    const html = injectInlineData(built, data);
    const body = dataBody(html);
    expect(body).not.toContain('<');
    expect(JSON.parse(body)).toEqual(data);
    // Everything outside the block is untouched.
    const at = built.indexOf(DATA_OPEN) + DATA_OPEN.length;
    expect(html.slice(0, at)).toBe(built.slice(0, at));
    expect(html.slice(html.indexOf('</script>', at))).toBe(
      built.slice(built.indexOf('</script>', at)),
    );
    expect(jsonForScriptBlock(undefined)).toBe('null');
  });
});

describe('offline build: no CDN, no web fonts (ux#3, ux#4, tech-debt#5)', () => {
  it('the committed CLI template is exactly what sync-ui builds from the prototype', () => {
    expect(buildTemplate(source, { tailwindCss: compileTailwind() })).toBe(built);
  });

  it('the shipped template loads nothing from another origin', () => {
    expect(() => assertNoRemoteResources(built)).not.toThrow();
    expect(() => assertNoRemoteResources(prepareStaticReport(built))).not.toThrow();
    expect(() =>
      assertNoRemoteResources('<link href="https://fonts.googleapis.com/css2" rel="stylesheet">'),
    ).toThrow(/remote resource/);
  });

  it('the prototype source drops the Tailwind CDN, Google Fonts and esm.sh parser', () => {
    expect(source).not.toMatch(/<script\b[^>]*\bsrc=/i);
    expect(source).not.toMatch(/fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr|esm\.sh\/@babel/);
    expect(source).toContain("import('./vendor/babel-parser.mjs')");
    expect(source).toMatch(/--font-body:\s+ui-sans-serif, system-ui/);
  });

  it('inlines compiled Tailwind utilities, including state-dependent classes', () => {
    const css = /<style id="facts-tailwind">([\s\S]*?)<\/style>/.exec(built)?.[1] ?? '';
    expect(css).toContain('@layer utilities');
    for (const sel of [
      '.hidden{',
      '.flex{',
      '.grid{',
      '.lg\\:hidden',
      '.text-\\[var\\(--danger\\)\\]',
    ]) {
      expect(css, sel).toContain(sel);
    }
  });

  it('builds no Tailwind class names at runtime (ahead-of-time compile would miss them)', () => {
    expect(source).not.toMatch(/\b[a-z][\w:-]*-\[[^\]\s"'`]*\$\{/);
  });

  it('keeps the Supabase path inert and ships no baked sample dataset', () => {
    expect(built).not.toMatch(/import\(\s*['"]https?:/);
    expect(built).toContain('Remote modules are disabled in the factstack CLI build.');
    expect(built).not.toMatch(/data-url="[^"]|data-anon-key="[^"]/);
    expect(dataBody(built)).toBe(DATA_PLACEHOLDER);
  });
});

describe('Content-Security-Policy', () => {
  const executable = [...built.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)].filter(
    (m) => !/type="application\/json"/.test(m[1] ?? ''),
  );

  it('allows exactly the shipped inline scripts, by hash, and nothing inline besides', () => {
    const csp = uiContentSecurityPolicy(built);
    const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src ')) ?? '';
    expect(executable.length).toBe(3); // theme boot, supabase config, app module
    for (const m of executable) {
      const text = m[2]!.replaceAll(/\r\n?/g, '\n');
      const hash = createHash('sha256').update(text, 'utf8').digest('base64');
      expect(scriptSrc).toContain(`'sha256-${hash}'`);
    }
    expect(scriptSrc).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  it('is independent of the injected dataset and of CRLF checkouts', () => {
    const withData = injectInlineData(built, { name: HOSTILE });
    expect(uiContentSecurityPolicy(withData)).toBe(uiContentSecurityPolicy(built));
    expect(inlineScriptHashes(built.replaceAll('\n', '\r\n'))).toEqual(inlineScriptHashes(built));
  });

  it('static reports get a <meta> CSP ahead of every script, matching the rewritten module', () => {
    const report = prepareStaticReport(built);
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)" \/>/.exec(report);
    expect(meta).not.toBeNull();
    expect(meta!.index).toBeLessThan(report.indexOf('<script'));
    expect(meta![1]).not.toContain('frame-ancestors'); // ignored (and warned about) in <meta>
    expect(report).not.toContain("import('./vendor/");
    for (const h of inlineScriptHashes(report)) expect(meta![1]).toContain(h);
  });
});

/** The CLI sources the hardened template depends on. Since cli.ts was split
 *  (tech-debt#6) each piece is checked in the module that owns it. */
interface CliUiSources {
  /** src/ui-server.ts: serves the page (CSP header) and GET /vendor/*. */
  server: string;
  /** src/commands/export.ts + src/commands/quick.ts: the static reports. */
  reports: Record<string, string>;
  /** Every CLI source outside src/ui/, for the no-local-copy check. */
  all: Record<string, string>;
}

/** Names a module imports from `from` (one `import { … } from '<from>'`). */
function importsFrom(code: string, from: string): string {
  const spec = from.replaceAll('.', '\\.').replaceAll('/', '\\/');
  return new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*'${spec}'`).exec(code)?.[1] ?? '';
}

/** What the CLI must do for the hardened template to work (legacy-ui
 *  cross-stream request (a)-(h)); returns the missing pieces. */
function cliUiWiringGaps(src: CliUiSources): string[] {
  const missing = (code: string, from: string, names: string[]) =>
    names.filter((name) => !new RegExp(`\\b${name}\\b`).test(importsFrom(code, from)));
  const gaps = missing(src.server, './ui/embed.js', [
    'injectInlineData',
    'readVendorModule',
    'uiContentSecurityPolicy',
  ]).map((name) => `ui-server.ts: import ${name} from './ui/embed.js'`);
  for (const [file, code] of Object.entries(src.reports)) {
    for (const name of missing(code, '../ui/embed.js', ['injectInlineData', 'prepareStaticReport']))
      gaps.push(`${file}: import ${name} from '../ui/embed.js'`);
  }
  for (const [file, code] of Object.entries(src.all)) {
    if (/function (stripCdnDeps|injectInlineData)\s*\(/.test(code))
      gaps.push(
        `${file}: delete the local stripCdnDeps / injectInlineData (the old one escapes only </script)`,
      );
  }
  if (!/pathname\.startsWith\(\s*'\/vendor\/'\s*\)[\s\S]{0,400}readVendorModule\(/.test(src.server))
    gaps.push(
      'ui-server.ts: serve GET /vendor/* via readVendorModule (the Open-folder scan imports ./vendor/babel-parser.mjs)',
    );
  if (
    !/'content-security-policy':\s*\w/.test(src.server) ||
    !/uiContentSecurityPolicy\(/.test(src.server)
  )
    gaps.push(
      "ui-server.ts: send 'content-security-policy': uiContentSecurityPolicy(template) on GET /",
    );
  for (const [file, code] of Object.entries(src.reports)) {
    if (!/injectInlineData\(\s*prepareStaticReport\(\s*readUiTemplate\(\)\s*\)/.test(code))
      gaps.push(`${file}: embed via injectInlineData(prepareStaticReport(readUiTemplate()), viz)`);
  }
  return gaps;
}

/** The real sources, read from apps/cli/src. */
function cliUiSources(): CliUiSources {
  const src = path.join(CLI_ROOT, 'src');
  const read = (rel: string) => readFileSync(path.join(src, rel), 'utf8');
  const all: Record<string, string> = {};
  for (const rel of readdirSync(src, { recursive: true, encoding: 'utf8' })) {
    const posix = rel.replaceAll('\\', '/');
    if (posix.endsWith('.ts') && !posix.startsWith('ui/')) all[posix] = read(rel);
  }
  return {
    server: read('ui-server.ts'),
    reports: {
      'commands/export.ts': read(path.join('commands', 'export.ts')),
      'commands/quick.ts': read(path.join('commands', 'quick.ts')),
    },
    all,
  };
}

describe('merge gate: the CLI serves what the template needs (review legacy-ui-R2)', () => {
  it('recognises the requested wiring', () => {
    const server = `import {
        injectInlineData, readVendorModule, uiContentSecurityPolicy,
      } from './ui/embed.js';
      const uiCsp = uiContentSecurityPolicy(template);
      res.writeHead(200, { 'content-security-policy': uiCsp });
      if (req.method === 'GET' && url.pathname.startsWith('/vendor/')) {
        const body = readVendorModule(url.pathname.slice('/vendor/'.length));
      }`;
    const report = `import { injectInlineData, prepareStaticReport } from '../ui/embed.js';
      const out = injectInlineData(prepareStaticReport(readUiTemplate()), viz);`;
    const reports = { 'commands/export.ts': report, 'commands/quick.ts': report };
    expect(cliUiWiringGaps({ server, reports, all: { 'ui-server.ts': server } })).toEqual([]);
    const bare = { 'commands/export.ts': '', 'commands/quick.ts': '' };
    // 3 server imports + 2×2 report imports + the local copy + vendor + CSP + 2 report embeds
    expect(
      cliUiWiringGaps({
        server: '',
        reports: bare,
        all: { 'cli.ts': 'function stripCdnDeps(html) {}' },
      }),
    ).toHaveLength(12);
    // One report without the hardened embed is caught on its own.
    expect(
      cliUiWiringGaps({
        server,
        reports: { ...reports, 'commands/quick.ts': report.replace('prepareStaticReport(', '(') },
        all: {},
      }),
    ).toEqual([
      'commands/quick.ts: embed via injectInlineData(prepareStaticReport(readUiTemplate()), viz)',
    ]);
  });

  // Red until the cli stream applied the legacy-ui request: without it
  // `factstack ui` sends no CSP, the Open-folder scan's parser import 404s,
  // and export/quick keep the '</script'-only data escaping. Since the
  // tech-debt#6 split it checks ui-server.ts, commands/export.ts and
  // commands/quick.ts, and every CLI module for a local copy.
  it('the CLI is wired to src/ui/embed.ts', () => {
    const src = cliUiSources();
    expect(Object.keys(src.all)).toEqual(
      expect.arrayContaining(['cli.ts', 'ui-server.ts', 'commands/export.ts', 'commands/quick.ts']),
    );
    expect(cliUiWiringGaps(src)).toEqual([]);
  });
});

describe('vendored @babel/parser', () => {
  it('bundles into a self-contained module that parses imports', async () => {
    const code = await bundleBabelParser();
    expect(code.startsWith('/*! @babel/parser ')).toBe(true);
    expect(/import\(\s*["']https?:/.test(code)).toBe(false);
    // Importing it from a bare temp dir (no node_modules) proves it is self-contained.
    const file = path.join(tmp, 'babel-parser.mjs');
    writeFileSync(file, code);
    const mod = (await import(pathToFileURL(file).href)) as {
      parse: (s: string, o: object) => { program: { body: { type: string }[] } };
    };
    const ast = mod.parse("import a from 'b'; export * from './c';", { sourceType: 'module' });
    expect(ast.program.body.map((n) => n.type)).toEqual([
      'ImportDeclaration',
      'ExportAllDeclaration',
    ]);
  });

  it('serves only allow-listed module names', () => {
    writeFileSync(path.join(tmp, 'babel-parser.mjs'), 'export {}');
    expect(readVendorModule('babel-parser.mjs', [tmp])).toBe('export {}');
    expect(readVendorModule('../package.json', [tmp])).toBeNull();
    expect(readVendorModule('babel-parser.mjs', [path.join(tmp, 'missing')])).toBeNull();
  });
});
