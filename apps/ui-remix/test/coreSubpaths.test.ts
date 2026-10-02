/**
 * core-dup-01 — the Docs renderer (lib/markdown.tsx) and the Overview H1
 * (routes/Overview.tsx) used to carry their own copies of core's fence and
 * inline-Markdown helpers, and nothing stopped the copies drifting from the
 * analyzer's doc outline (UI-08) or summary.oneLiner cleanup (UI-15). They now
 * import the one implementation through @factstack/core's leaf subpaths.
 *
 * Guards: the subpaths resolve by package name (Vite for the static imports,
 * Node for the manifest's exports map), they stay leaf modules (no imports, so
 * the analyzer barrel and any node:* can never ride into the dashboard's
 * chunk through them), and no local copy grows back under src/.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isFenceClose, parseFenceOpen } from '@factstack/core/md-fence';
import { stripInlineMarkdown } from '@factstack/core/plain-text';

const SUBPATHS = ['@factstack/core/md-fence', '@factstack/core/plain-text'] as const;
const SRC = fileURLToPath(new URL('../src/', import.meta.url));

describe('@factstack/core leaf subpaths used by the dashboard', () => {
  it('give the Docs renderer the CommonMark fence rules', () => {
    const open = parseFenceOpen('````md');
    expect(open).toEqual({ char: '`', len: 4, lang: 'md' });
    expect(isFenceClose('```', open!)).toBe(false);
    expect(isFenceClose('````', open!)).toBe(true);
    expect(parseFenceOpen('```js```')).toBeNull();
  });

  it('give the Overview headline its plain-text one-liner', () => {
    expect(stripInlineMarkdown('See [setup](docs/setup.md).')).toBe('See setup.');
    expect(stripInlineMarkdown('**Fast** `cli` for snake_case_names')).toBe(
      'Fast cli for snake_case_names',
    );
  });

  it.each(SUBPATHS)('%s resolves through the exports map to a leaf module', (spec) => {
    const file = createRequire(import.meta.url).resolve(spec);
    expect(file.replaceAll('\\', '/')).toMatch(/\/packages\/core\/src\/[\w-]+\.ts$/);
    const src = readFileSync(file, 'utf8');
    expect(src, `${spec} must not import anything`).not.toMatch(/^\s*import\s/m);
    expect(src, `${spec} must not re-export anything`).not.toMatch(/\bfrom\s+['"]/);
    expect(src, `${spec} must not load modules at runtime`).not.toMatch(
      /\b(?:import|require)\s*\(/,
    );
  });

  it('has no local copy of the helpers left under src/', () => {
    const copies = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .filter((rel) => /\.tsx?$/.test(rel) && !/\.test\.tsx?$/.test(rel))
      .filter((rel) =>
        /\bfunction\s+(?:parseFenceOpen|isFenceClose|stripInlineMarkdown)\b/.test(
          readFileSync(join(SRC, rel), 'utf8'),
        ),
      );
    expect(copies).toEqual([]);
  });
});
