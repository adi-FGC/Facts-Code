#!/usr/bin/env node
// Build the CLI's local UI (`factstack ui`, `export`, `quick`) from the
// legacy prototype. Run before the CLI's TypeScript build. The prototype
// lives at `legacy/prototype/index.html` since the v0.3 master-branch
// cleanup — the Remix v3 UI under `apps/ui-remix/` is the hosted UI, but the
// CLI's standalone preview deliberately keeps the prototype (owner decision
// 2026-09-24), hardened: no CDN, no web fonts, Tailwind compiled and inlined,
// @babel/parser vendored. See scripts/lib/build-ui.mjs for the steps.
//
// Writes src/ui/index.html (+ vendor/babel-parser.mjs) for `tsx` dev runs and
// mirrors both into dist/ui/ so the published package (files: dist) ships them.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  CLI_ROOT,
  PROTOTYPE_SRC,
  buildTemplate,
  bundleBabelParser,
  compileTailwind,
} from './lib/build-ui.mjs';

try {
  const html = buildTemplate(readFileSync(PROTOTYPE_SRC, 'utf8'), {
    tailwindCss: compileTailwind(),
  });
  const babel = await bundleBabelParser();
  for (const dir of [resolve(CLI_ROOT, 'src', 'ui'), resolve(CLI_ROOT, 'dist', 'ui')]) {
    mkdirSync(resolve(dir, 'vendor'), { recursive: true });
    writeFileSync(resolve(dir, 'index.html'), html);
    writeFileSync(resolve(dir, 'vendor', 'babel-parser.mjs'), babel);
  }
  const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(1);
  console.log(
    `[sync-ui] built legacy/prototype/index.html → apps/cli/{src,dist}/ui/ ` +
      `(index.html ${kb(html)} KB, vendor/babel-parser.mjs ${kb(babel)} KB)`,
  );
} catch (err) {
  console.error('[sync-ui] failed:', err?.message ?? err);
  process.exit(1);
}
