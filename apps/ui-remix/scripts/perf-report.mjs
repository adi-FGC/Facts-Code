#!/usr/bin/env node
/**
 * Report-only first-paint check of the BUILT dashboard (dist/), for CI.
 *
 * The owner removed byte caps (2026-09-23) in favour of measuring what users
 * feel — first paint on a throttled connection — but that measurement only
 * ever ran by hand, so a regression (the dataset moving back into <head>, a
 * render-blocking font) would ship silently. This makes it a number on every
 * CI run. It never fails the build on a number.
 *
 * How: serves dist/ itself the way Cloudflare does (brotli, SPA fallback to
 * index.html), loads `/` N times in headless Chromium with a cold cache under
 * Lighthouse's mobile throttling (Slow 4G: 562.5 ms RTT, 1.47 Mbps down,
 * 675 Kbps up; 4x CPU), and reads FCP / LCP from PerformanceObserver plus the
 * moment the boot skeleton is replaced by the app. Prints the medians and
 * appends a table to $GITHUB_STEP_SUMMARY.
 *
 * PERF_WARN_LCP_MS=<n>: a ::warning:: (still exit 0) when the median LCP is
 * above n. Exit 1 only when nothing could be measured (no dist/, no browser).
 *
 * Usage: node scripts/perf-report.mjs [--dist <dir>] [--runs 3]
 * Needs a Playwright Chromium: `pnpm exec playwright install chromium`.
 */
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync } from 'node:zlib';
import { isMain } from './lib/is-main.mjs';

/** Lighthouse mobile "Slow 4G" as applied (devtools) throttling. */
export const THROTTLE = {
  latency: 562.5,
  downloadThroughput: (1474.56 * 1024) / 8,
  uploadThroughput: (675 * 1024) / 8,
  cpuSlowdown: 4,
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
  '.pack': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|xml|manifest\+json)|image\/svg)/;

export function median(xs) {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * A static server for dist/ that behaves like the production host where it
 * matters for first paint: brotli for text, clean-URL SPA fallback, no path
 * escapes. Compressed bodies are cached per file.
 */
export function createDistServer(dist) {
  const root = resolve(dist);
  const cache = new Map();
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let rel = decodeURIComponent(url.pathname);
    let file = normalize(join(root, rel));
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      const html = file + '.html';
      file = existsSync(html) ? html : join(root, 'index.html'); // SPA fallback, like _redirects
    }
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    let body = readFileSync(file);
    const headers = { 'content-type': type, 'cache-control': 'no-store' };
    if (COMPRESSIBLE.test(type) && /\bbr\b/.test(req.headers['accept-encoding'] ?? '')) {
      if (!cache.has(file)) cache.set(file, brotliCompressSync(body));
      body = cache.get(file);
      headers['content-encoding'] = 'br';
    }
    res.writeHead(200, headers).end(body);
  });
}

const fmtMs = (v) => (v == null ? 'n/a' : `${Math.round(v)} ms`);
const fmtKb = (v) => (v == null ? 'n/a' : `${(v / 1024).toFixed(1)} KB`);

/** Markdown table of per-run results + medians. */
export function summaryMarkdown(runs, { throttle = THROTTLE } = {}) {
  const row = (label, key, fmt) =>
    `| ${label} | **${fmt(median(runs.map((r) => r[key])))}** | ${runs.map((r) => fmt(r[key])).join(' · ')} |`;
  return [
    '### First paint (report-only)',
    `Cold cache, mobile viewport, Slow 4G (${throttle.latency} ms RTT, ` +
      `${((throttle.downloadThroughput * 8) / 1024 / 1024).toFixed(2)} Mbps down) + ${throttle.cpuSlowdown}x CPU. ` +
      'Never fails the build.',
    '',
    '| metric | median | runs |',
    '| --- | --- | --- |',
    row('First contentful paint', 'fcp', fmtMs),
    row('Largest contentful paint', 'lcp', fmtMs),
    row('App mounted (skeleton replaced)', 'appReady', fmtMs),
    row('index.html on the wire', 'htmlTransfer', fmtKb),
    '',
  ].join('\n');
}

async function measure(browser, url) {
  const context = await browser.newContext({
    viewport: { width: 412, height: 823 },
    deviceScaleFactor: 1.75,
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      const perf = { fcp: null, lcp: null };
      window.__factsPerf = perf;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries())
          if (e.name === 'first-contentful-paint') perf.fcp = e.startTime;
      }).observe({ type: 'paint', buffered: true });
      new PerformanceObserver((list) => {
        const es = list.getEntries();
        if (es.length) perf.lcp = es[es.length - 1].startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: THROTTLE.latency,
      downloadThroughput: THROTTLE.downloadThroughput,
      uploadThroughput: THROTTLE.uploadThroughput,
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE.cpuSlowdown });
    await page.goto(url, { waitUntil: 'load', timeout: 180_000 });
    let appReady = null;
    try {
      await page.waitForSelector('[data-app-skeleton]', { state: 'detached', timeout: 60_000 });
      appReady = await page.evaluate(() => performance.now());
    } catch {
      /* the app never replaced the skeleton — reported as n/a */
    }
    await page.waitForTimeout(1500); // let LCP settle after the mount
    return await page.evaluate((ready) => {
      const nav = performance.getEntriesByType('navigation')[0];
      // LCP stops updating on input; nothing here interacts, so the last entry is final.
      return {
        ...window.__factsPerf,
        appReady: ready,
        htmlTransfer: nav ? nav.transferSize : null,
      };
    }, appReady);
  } finally {
    await context.close();
  }
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const dist = resolve(arg('--dist', resolve(here, '..', 'dist')));
  const runsWanted = Math.max(1, Number(arg('--runs', '3')) || 3);
  if (!existsSync(join(dist, 'index.html'))) {
    console.error(`[perf-report] ${dist}/index.html not found — build first (pnpm build:static).`);
    process.exit(1);
  }
  const { chromium } = await import('@playwright/test');
  const server = createDistServer(dist);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  let browser;
  const runs = [];
  try {
    browser = await chromium.launch();
    for (let i = 0; i < runsWanted; i++) {
      const r = await measure(browser, url);
      runs.push(r);
      console.log(
        `[perf-report] run ${i + 1}: FCP ${fmtMs(r.fcp)}, LCP ${fmtMs(r.lcp)}, app ${fmtMs(r.appReady)}, html ${fmtKb(r.htmlTransfer)}`,
      );
    }
  } catch (e) {
    console.error(`[perf-report] could not measure: ${e?.message || e}`);
    process.exitCode = 1;
  } finally {
    await browser?.close();
    server.close();
  }
  if (!runs.length) return;
  const md = summaryMarkdown(runs);
  console.log('\n' + md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  const warnAt = Number(process.env.PERF_WARN_LCP_MS);
  const lcp = median(runs.map((r) => r.lcp));
  if (warnAt > 0 && lcp != null && lcp > warnAt) {
    const msg = `median LCP ${Math.round(lcp)} ms is above the ${warnAt} ms warn line (report-only).`;
    console.warn(
      process.env.GITHUB_ACTIONS
        ? `::warning title=First paint::${msg}`
        : `[perf-report] WARN ${msg}`,
    );
  }
}

/* Run only as a script, not when imported by the test suite. */
if (isMain(import.meta.url)) await main();
