/**
 * Strict-CSP page guard (apps/ui-remix/scripts/lib/html-guard.mjs).
 *
 * Regression: apps/ui-remix/public/briefing.html shipped to production with an
 * inline <style>, style= attributes, inline scripts, Google Fonts and a CDN
 * import — all blocked by the site CSP, so /briefing rendered unstyled and
 * broken. Every page the site serves (except mcp-auth.html, which carries its
 * own scoped policy) must render under the strict CSP.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { strictPageProblems } from '../apps/ui-remix/scripts/lib/html-guard.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'apps/ui-remix');

describe('strictPageProblems', () => {
  it('passes a page that only loads same-origin assets', () => {
    const page =
      '<!doctype html><link rel="stylesheet" href="/a.css"><link rel="canonical" href="https://x.dev">' +
      '<script type="module" src="/a.js"></script><script type="application/json">{"a":"<b style=x>"}</script>' +
      '<a href="https://github.com/x">x</a>';
    expect(strictPageProblems(page)).toEqual([]);
  });

  it('admits exactly one inline boot script when asked to', () => {
    const one = '<script>boot()</script>';
    expect(strictPageProblems(one, { allowBootScript: true })).toEqual([]);
    expect(strictPageProblems(one)).toHaveLength(1);
    expect(strictPageProblems(one + one, { allowBootScript: true })).toHaveLength(1);
  });

  it('flags every CSP breaker the briefing page carried', () => {
    const page =
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X">' +
      '<style>body{}</style><div style="color:red" onclick="x()"></div>' +
      '<script type="module">import m from "https://cdn.jsdelivr.net/npm/mermaid";</script>' +
      '<script src="https://cdn.example/x.js"></script><img src="https://evil.example/p.png">';
    const got = strictPageProblems(page).join('\n');
    for (const want of [
      'third-party resource',
      '<style>',
      'style=',
      'on*=',
      'inline <script>',
      'third-party script',
      'embeds',
    ])
      expect(got).toContain(want);
  });

  it('ignores markup inside HTML comments', () => {
    expect(strictPageProblems('<!-- <style> <div style="x"> -->')).toEqual([]);
  });
});

describe('pages the dashboard build ships', () => {
  const pages = [
    ['apps/ui-remix/index.html', readFileSync(join(APP, 'index.html'), 'utf8'), true],
    ...readdirSync(join(APP, 'public'))
      .filter((f) => f.endsWith('.html') && f !== 'mcp-auth.html')
      .map((f) => [
        `apps/ui-remix/public/${f}`,
        readFileSync(join(APP, 'public', f), 'utf8'),
        false,
      ]),
  ];
  it.each(pages)('%s renders under the strict CSP', (_name, html, boot) => {
    expect(strictPageProblems(html, { allowBootScript: boot })).toEqual([]);
  });
});
