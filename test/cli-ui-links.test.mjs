/**
 * The CLI's local UI links to this project.
 *
 * Regression (ux#25 / tech-debt#20): the About view's "GitHub →" button in
 * legacy/prototype/index.html linked github.com/garrytan/factstack, a
 * different project, and sync:ui copies it into apps/cli/src/ui/index.html,
 * which the CLI bundle ships. Both copies are checked; apps/cli's legacy-ui
 * test separately pins the built template to the prototype.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'https://github.com/adi-FGC/Facts-Code';

describe('CLI local UI repository link', () => {
  it.each(['legacy/prototype/index.html', 'apps/cli/src/ui/index.html'])(
    '%s: the About "GitHub →" button opens this repo',
    (f) => {
      const html = readFileSync(join(ROOT, f), 'utf8');
      const links = [...html.matchAll(/<a href="([^"]+)"[^>]*>\s*GitHub →\s*<\/a>/g)].map(
        (m) => m[1],
      );
      expect(links).toEqual([REPO]);
      expect(html).not.toContain('github.com/garrytan');
    },
  );
});
