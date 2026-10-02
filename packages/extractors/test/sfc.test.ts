import { describe, expect, it } from 'vitest';
import { extractSfcScripts, isSfc } from '../src/sfc.js';

describe('extractSfcScripts (HUNT-CORE-04)', () => {
  it('finds Vue <script> and <script setup lang="ts"> with their line offsets', () => {
    const src = [
      '<template><Header /></template>', // line 1
      '<script>', // 2
      "import Header from './components/Header.vue';", // 3
      'export default { components: { Header } };', // 4
      '</script>', // 5
      '<script setup lang="ts" generic="T extends Record<string, unknown>">', // 6
      "import { useStore } from './store';", // 7
      '</script>',
    ].join('\n');
    const blocks = extractSfcScripts(src);
    expect(blocks.map((b) => b.ext)).toEqual(['.js', '.ts']);
    // Body line 2 of the first block is original line 3.
    expect(blocks[0]!.lineOffset + 2).toBe(3);
    expect(blocks[1]!.lineOffset + 2).toBe(7);
    expect(blocks[1]!.source).toContain("from './store'");
  });

  it('reads Svelte instance + module scripts and skips <script src>', () => {
    const src = [
      '<script context="module" lang="ts">export const prerender = true;</script>',
      '<script src="./legacy.js"></script>',
      "<script>\n  import { count } from './store';\n</script>",
      '<p>{$count}</p>',
    ].join('\n');
    const blocks = extractSfcScripts(src);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.ext).toBe('.ts');
    expect(blocks[1]!.source).toContain("from './store'");
  });

  it('skips non-JS <script type> blocks such as JSON-LD (CORE-R3)', () => {
    const src = [
      '<script lang="ts">',
      "  import Seo from './Seo.svelte';",
      '</script>',
      '<svelte:head>',
      '  <script type="application/ld+json">{ "@context": "https://schema.org" }</script>',
      "  <script type='text/x-template'><div>{{ x }}</div></script>",
      '  <script type="module">export const a = 1;</script>',
      '  <script type=text/javascript>var b = 2;</script>',
      '</svelte:head>',
    ].join('\n');
    expect(extractSfcScripts(src).map((b) => b.source.trim())).toEqual([
      "import Seo from './Seo.svelte';",
      'export const a = 1;',
      'var b = 2;',
    ]);
  });

  it('recognises the SFC extensions only', () => {
    expect(isSfc('.vue')).toBe(true);
    expect(isSfc('.SVELTE')).toBe(true);
    expect(isSfc('.astro')).toBe(false);
  });
});
