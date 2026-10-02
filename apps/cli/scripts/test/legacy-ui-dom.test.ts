/**
 * DOM-level regression test for stored XSS in the CLI's local UI (security#3,
 * review finding legacy-ui-R1). The static audit (ui-xss-audit.mjs) is
 * heuristic; this renders the shipped template in headless Chromium with a
 * REAL dataset (analyze + humanToViz of a small fixture) in which every
 * string — file/folder names, language tag/iconColor/id, risk messages,
 * dates… — carries a quote-breaking markup payload, opens every tab and a
 * file, and asserts no payload ever becomes an element or runs.
 *
 * No CSP is sent, so it tests the escaping itself, not the backstop.
 * Chromium comes from the workspace's Playwright (declared by ui-remix); the
 * suite skips when no browser is installed unless FACTS_UI_DOM_TEST=1.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { analyze } from '@factstack/core';
import { gzippedBytes, humanToViz } from '@factstack/emit';
import { nodeFS } from '@factstack/fs-node';

import { injectInlineData } from '../../src/ui/embed.js';
import { CLI_ROOT } from '../lib/build-ui.mjs';

type Page = {
  goto(url: string): Promise<unknown>;
  click(selector: string): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T>(fn: () => T): Promise<T>;
  route(
    url: string,
    handler: (route: {
      request(): { url(): string };
      fulfill(o: { status: number; contentType: string; body: string }): Promise<void>;
      abort(): Promise<void>;
    }) => unknown,
  ): Promise<void>;
  on(event: 'pageerror', fn: (e: Error) => void): void;
  close(): Promise<void>;
};
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };
type Chromium = { executablePath(): string; launch(): Promise<Browser> };

// The page.evaluate() callbacks run in the browser, not Node. Declare just the
// DOM surface they touch, module-local: a `lib="dom"` reference would hand
// document/window to every Node test in the typecheck program.
declare const document: {
  querySelectorAll(selectors: string): { readonly length: number };
  readonly body: { readonly textContent: string | null };
};
declare const window: { readonly __xss?: number };

function loadChromium(): Chromium | null {
  try {
    const fromUiRemix = createRequire(path.resolve(CLI_ROOT, '../ui-remix/package.json'));
    const pwTest = fromUiRemix.resolve('@playwright/test');
    const { chromium } = createRequire(pwTest)('playwright') as { chromium: Chromium };
    return existsSync(chromium.executablePath()) ? chromium : null;
  } catch {
    return null;
  }
}
const chromium = loadChromium();
if (!chromium && process.env.FACTS_UI_DOM_TEST === '1')
  throw new Error('FACTS_UI_DOM_TEST=1 but no Playwright Chromium is installed');

// Breaks out of text, double- and single-quoted attribute context alike.
const PAYLOAD = `"'><img src=x onerror="window.__xss=(window.__xss||0)+1">`;
const TABS = [
  'overview',
  'graph',
  'dag',
  'files',
  'library',
  'routes',
  'risks',
  'tests',
  'history',
  'about',
  'config',
];

/** Append the payload to every string (and, optionally, turn every number
 *  into a payload-carrying string: a committed .facts/*.json controls types). */
const hostile = (v: unknown, numbers: boolean): unknown =>
  typeof v === 'string'
    ? v + PAYLOAD
    : typeof v === 'number' && numbers
      ? `${v}${PAYLOAD}`
      : Array.isArray(v)
        ? v.map((x) => hostile(x, numbers))
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, hostile(x, numbers)]))
          : v;

describe.skipIf(!chromium)('local UI renders a hostile dataset inert (security#3, DOM)', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'facts-legacy-ui-dom-'));
  let browser: Browser;
  let viz: Record<string, unknown>;
  let template = '';

  beforeAll(async () => {
    const put = (rel: string, body: string) => {
      mkdirSync(path.dirname(path.join(fixture, rel)), { recursive: true });
      writeFileSync(path.join(fixture, rel), body);
    };
    put(
      'package.json',
      JSON.stringify({ name: 'dom-fixture', dependencies: { react: '^18.3.0' } }),
    );
    put('README.md', '# dom fixture\n\nA tiny app.\n');
    put(
      'src/index.ts',
      "import { util } from './lib/util';\nexport function main() { return util(); }\n",
    );
    put('src/lib/util.ts', '// TODO: tidy this up\nexport function util() { return 1; }\n');
    put('src/components/Button.tsx', 'export function Button() { return null; }\n');
    put('test/util.test.ts', "import { util } from '../src/lib/util';\nutil();\n");
    const result = await analyze(nodeFS(fixture), {
      root: '.',
      projectName: 'dom-fixture',
      gzip: gzippedBytes,
    });
    viz = humanToViz(result.agent, result.human) as unknown as Record<string, unknown>;
    viz.history = [
      { at: '2026-09-01T00:00:00Z', loc: 4, tokens: 40, files: 4, risks: 1, todos: 1 },
      { at: '2026-09-02T00:00:00Z', loc: 5, tokens: 50, files: 5, risks: 1, todos: 1 },
    ];
    // Make sure a risk row exists even if the fixture triggers none.
    const risks = (viz.risks as Record<string, unknown>[] | undefined) ?? [];
    viz.risks = [
      ...risks,
      { severity: 'high', kind: 'todo', message: 'check me', file: 'src/lib/util.ts', line: 1 },
    ];
    template = readFileSync(path.join(CLI_ROOT, 'src', 'ui', 'index.html'), 'utf8');
    browser = await chromium!.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    rmSync(fixture, { recursive: true, force: true });
  });

  it.each([
    ['strings', false],
    ['strings and numbers', true],
  ])(
    'no payload in %s becomes an element or runs, on any tab or an opened file',
    async (_, numbers) => {
      const html = injectInlineData(template, hostile(viz, numbers));
      const page = await browser.newPage();
      const errors: string[] = [];
      const remote: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.route('**/*', (route) => {
        const url = route.request().url();
        if (url === 'http://facts.test/')
          return route.fulfill({ status: 200, contentType: 'text/html', body: html });
        remote.push(url);
        return route.abort();
      });
      await page.goto('http://facts.test/');
      await page.waitForTimeout(300);

      const probe = () =>
        page.evaluate(() => ({
          injected: document.querySelectorAll('img[src="x"], [onerror], [onload], [onmouseover]')
            .length,
          ran: window.__xss ?? 0,
          shown: (document.body.textContent ?? '').split(`<img src=x onerror=`).length - 1,
        }));

      const seen: Record<string, { injected: number; ran: number; shown: number }> = {};
      for (const tab of TABS) {
        await page.click(`#tab-${tab}`);
        await page.waitForTimeout(150);
        seen[tab] = await probe();
      }
      await page.click('#tab-files');
      await page.click('.tree-row[data-kind="file"]');
      await page.waitForTimeout(150);
      seen['files (opened)'] = await probe();

      for (const [where, s] of Object.entries(seen)) {
        expect(s.injected, `${where}: injected elements`).toBe(0);
        expect(s.ran, `${where}: payload ran`).toBe(0);
      }
      // Non-vacuous: the payload really is on screen, as text.
      expect(seen.overview!.shown).toBeGreaterThan(0);
      expect(seen['files (opened)']!.shown).toBeGreaterThan(0);
      expect(errors).toEqual([]);
      expect(remote.filter((u) => !u.startsWith('http://facts.test/'))).toEqual([]); // offline
      await page.close();
    },
    60_000,
  );
});
