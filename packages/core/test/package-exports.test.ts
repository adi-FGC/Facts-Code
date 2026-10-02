import { describe, expect, it } from 'vitest';
import pkg from '../package.json';
import * as mdFence from '../src/md-fence.js';
import * as plainText from '../src/plain-text.js';

/**
 * core-dup-01 — the dashboard keeps @factstack/core out of its first-paint
 * bundle, so it held its own copies of the fence and inline-Markdown
 * helpers. These leaf subpaths let it import the ONE implementation without
 * pulling the analyzer barrel (same pattern as @factstack/spec/routes).
 */
describe('@factstack/core subpath exports', () => {
  it('keeps the root entry on the analyzer barrel', () => {
    expect(pkg.exports['.']).toBe(pkg.main);
  });

  it.each([
    ['./md-fence', mdFence, ['isFenceClose', 'parseFenceOpen']],
    ['./plain-text', plainText, ['stripInlineMarkdown']],
  ] as const)('%s resolves to the module core itself uses', async (sub, mod, names) => {
    const target = pkg.exports[sub];
    // Non-literal specifier: resolve the manifest's own target path.
    const url = new URL(`../${target}`, import.meta.url).href;
    const loaded = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
    expect(Object.keys(loaded).sort()).toEqual([...names]);
    for (const n of names) expect(loaded[n]).toBe((mod as Record<string, unknown>)[n]);
  });
});
