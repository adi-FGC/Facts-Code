#!/usr/bin/env node
// Keep apps/cli/src/ui/index.html in step with prototype/index.html.
// Run before the CLI's TypeScript build so `factstack ui` always ships
// the latest prototype surface. CI should call this via `pnpm build`.

import { cpSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '..', '..', '..', 'prototype', 'index.html');
const dest = resolve(here, '..', 'src', 'ui', 'index.html');

try {
  const s = statSync(src);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
  const kb = (s.size / 1024).toFixed(1);
  console.log(`[sync-ui] copied prototype/index.html → apps/cli/src/ui/ (${kb} KB)`);
} catch (err) {
  console.error('[sync-ui] failed:', err?.message ?? err);
  process.exit(1);
}
