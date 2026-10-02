/**
 * apps/ui-remix/scripts/perf-report.mjs — the report-only first-paint check CI
 * runs on the built dashboard. The browser run itself needs a Playwright
 * Chromium and is exercised in CI; these cover the parts that decide what it
 * measures: the Cloudflare-like static server and the summary it writes.
 */
import { brotliDecompressSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDistServer,
  median,
  summaryMarkdown,
} from '../apps/ui-remix/scripts/perf-report.mjs';

describe('median + summary', () => {
  it('takes the median and ignores missing values', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, null, 2, 3])).toBe(2.5);
    expect(median([null])).toBeNull();
  });

  it('writes a report-only table with every metric', () => {
    const md = summaryMarkdown([
      { fcp: 1000, lcp: 2000, appReady: 2100, htmlTransfer: 100 * 1024 },
      { fcp: 1200, lcp: 2400, appReady: null, htmlTransfer: 100 * 1024 },
    ]);
    expect(md).toContain('report-only');
    expect(md).toContain('| Largest contentful paint | **2200 ms** | 2000 ms · 2400 ms |');
    expect(md).toContain('| App mounted (skeleton replaced) | **2100 ms** | 2100 ms · n/a |');
    expect(md).toContain('100.0 KB');
  });
});

describe('dist server', () => {
  let dir;
  let server;
  let port;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fx-perf-'));
    mkdirSync(join(dir, 'dist', 'assets'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'index.html'), '<!doctype html><p>app</p>');
    writeFileSync(join(dir, 'dist', 'assets', 'a.js'), 'console.log(1)');
    writeFileSync(join(dir, 'secret.txt'), 'outside dist');
    server = createDistServer(join(dir, 'dist'));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (path, headers = {}) =>
    new Promise((ok, fail) => {
      const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      });
      req.on('error', fail);
      req.end();
    });

  it('serves brotli like the production host', async () => {
    const r = await get('/', { 'accept-encoding': 'gzip, br' });
    expect(r.headers['content-encoding']).toBe('br');
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(brotliDecompressSync(r.body).toString()).toContain('<p>app</p>');
  });

  it('falls back to index.html for SPA routes and types assets', async () => {
    expect((await get('/review')).body.toString()).toContain('<p>app</p>');
    expect((await get('/assets/a.js')).headers['content-type']).toMatch(/javascript/);
  });

  it('never serves files outside dist/', async () => {
    const r = await get('/..%2Fsecret.txt');
    expect(r.body.toString()).not.toContain('outside dist');
  });
});
