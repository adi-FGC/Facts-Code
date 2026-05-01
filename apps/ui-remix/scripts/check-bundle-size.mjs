#!/usr/bin/env node
/**
 * Hard bundle-size cap for the UI app.
 *
 * The editorial rebuild stays in budget by keeping the runtime small —
 * Remix v3's @remix-run/ui VDOM + route-pattern + this app's source.
 * If a future change pushes JS past the cap, this exits non-zero so CI
 * surfaces it before users do.
 *
 * Tunable thresholds in one place. Bump them deliberately, with a
 * commit-message justification.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(here, '..');
const ASSETS_DIR = join(APP_DIR, 'dist', 'assets');

/** Caps in bytes. Raw = pre-gzip; gz = transfer size on the wire. */
const CAP_JS_RAW = 150 * 1024;
const CAP_JS_GZ = 50 * 1024;
const CAP_CSS_RAW = 24 * 1024;
const CAP_CSS_GZ = 8 * 1024;

let entries;
try {
  entries = readdirSync(ASSETS_DIR);
} catch (e) {
  console.error(`[check-bundle-size] dist/assets missing — run \`vite build\` first.`);
  console.error('  ' + (e?.message || e));
  process.exit(1);
}

const totals = { jsRaw: 0, jsGz: 0, cssRaw: 0, cssGz: 0 };
const rows = [];
for (const name of entries) {
  const path = join(ASSETS_DIR, name);
  const st = statSync(path);
  if (!st.isFile()) continue;
  if (name.endsWith('.map')) continue;
  const body = readFileSync(path);
  const gz = gzipSync(body, { level: 9 }).byteLength;
  const raw = body.byteLength;
  rows.push({ name, raw, gz });
  if (name.endsWith('.js'))  { totals.jsRaw  += raw; totals.jsGz  += gz; }
  if (name.endsWith('.css')) { totals.cssRaw += raw; totals.cssGz += gz; }
}

function fmt(n) {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(2) + ' KB';
  return n + ' B';
}

console.log('\nBundle size report:');
for (const r of rows) {
  console.log(`  ${r.name.padEnd(38)}  ${fmt(r.raw).padStart(10)}  ${fmt(r.gz).padStart(10)} (gz)`);
}
console.log('  ' + '─'.repeat(70));
console.log(`  ${'JS  total'.padEnd(38)}  ${fmt(totals.jsRaw).padStart(10)}  ${fmt(totals.jsGz).padStart(10)} (gz)`);
console.log(`  ${'CSS total'.padEnd(38)}  ${fmt(totals.cssRaw).padStart(10)}  ${fmt(totals.cssGz).padStart(10)} (gz)`);

const failures = [];
if (totals.jsRaw  > CAP_JS_RAW)  failures.push(`JS raw ${fmt(totals.jsRaw)} > cap ${fmt(CAP_JS_RAW)}`);
if (totals.jsGz   > CAP_JS_GZ)   failures.push(`JS gzip ${fmt(totals.jsGz)} > cap ${fmt(CAP_JS_GZ)}`);
if (totals.cssRaw > CAP_CSS_RAW) failures.push(`CSS raw ${fmt(totals.cssRaw)} > cap ${fmt(CAP_CSS_RAW)}`);
if (totals.cssGz  > CAP_CSS_GZ)  failures.push(`CSS gzip ${fmt(totals.cssGz)} > cap ${fmt(CAP_CSS_GZ)}`);

if (failures.length) {
  console.error('\n[check-bundle-size] FAIL:');
  for (const f of failures) console.error('  ' + f);
  console.error('\nIf this is intentional, bump the caps in this script with a justification.');
  process.exit(1);
}

console.log(
  `\n[check-bundle-size] OK — JS ${fmt(totals.jsGz)} / ${fmt(CAP_JS_GZ)} cap, ` +
    `CSS ${fmt(totals.cssGz)} / ${fmt(CAP_CSS_GZ)} cap.`,
);
