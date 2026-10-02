/**
 * The local UI template (the hardened legacy prototype) and the size warning
 * for the static report built from it. `ui` serves the template; `export`
 * and `quick` inline the dataset into it. Moved out of cli.ts unchanged
 * (tech-debt#6). This module must stay directly under src/: readUiTemplate
 * resolves the template relative to its own compiled location.
 */
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import kleur from 'kleur';
import { formatBytes } from './format.js';
import type { CliIO } from './io.js';

/**
 * Locate the shipped prototype HTML. In dev (tsx) this module lives at
 * apps/cli/src/uiTemplate.ts → template at apps/cli/src/ui/index.html. After
 * `pnpm build` the compiled output lives at apps/cli/dist/uiTemplate.js and
 * the sync-ui script has copied the HTML to apps/cli/dist/ui/index.html.
 * The publishable bundle (scripts/bundle.mjs) ships it the same way:
 * dist/cli.js (everything inlined) beside dist/ui/index.html.
 */
export function readUiTemplate(): string {
  // NB: fileURLToPath over `import.meta.dirname` only to keep one spelling
  // across the tsx, tsc and esbuild-bundle builds; the CLI's Node floor is
  // 24.3 (see `doctor`), where both work.
  // oxlint-disable-next-line unicorn/prefer-import-meta-properties -- see above
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'ui', 'index.html'),
    path.join(here, '..', 'src', 'ui', 'index.html'),
    path.join(here, '..', '..', 'src', 'ui', 'index.html'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return readFileSync(c, 'utf8');
  }
  throw new Error('UI template not found. Run `pnpm --filter @factstack/cli sync:ui`.');
}

/** performance#6 — the static report inlines the whole dataset (tree, edges,
 *  metrics grow linearly with the repo; ~60-90 MB for a 20k-file repo). Past
 *  this size browsers struggle to open a single file, so say so. */
export const LARGE_REPORT_BYTES = 20 * 1024 * 1024;

export function warnIfLargeReport(bytes: number, io: CliIO): void {
  if (bytes < LARGE_REPORT_BYTES) return;
  io.stderr.write(
    kleur.yellow(
      `  warning: the report is ${formatBytes(bytes)} — the whole dataset is inlined, and a single HTML file this large may open slowly or not at all. \`factstack ui\` serves the same view without a size limit.\n`,
    ),
  );
}
