/**
 * markdown.tsx — renderer regressions, asserted on the server-rendered HTML
 * (remix/component/server renderToString needs no DOM).
 *
 *   - UI-08: fences with an info string (```bash title="x"), odd languages
 *     (```c++), longer fences (````md nesting ```), and tildes must open and
 *     close as fences; otherwise code and prose swap for the rest of the doc.
 *   - UI-07: relative links in a doc resolve against the doc's own path to an
 *     in-app route instead of a bare relative href the SPA router hijacks.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'remix/component/server';
import { renderMarkdown, type MarkdownOptions } from './markdown.tsx';

const html = (src: string, opts?: MarkdownOptions) => renderToString(renderMarkdown(src, opts));

/** Text of every <pre><code> block, in order. */
function codeBlocks(out: string): string[] {
  return [...out.matchAll(/<code>([\s\S]*?)<\/code>/g)].map((m) => m[1] ?? '');
}
/** Text of every rendered heading, in order. */
function headings(out: string): string[] {
  return [...out.matchAll(/role="heading"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => m[1] ?? '');
}

describe('renderMarkdown fences (UI-08)', () => {
  it('opens a fence whose info string carries attributes', async () => {
    const out = await html(
      ['```bash title="install"', '# install deps', '```', '', '## Usage'].join('\n'),
    );
    expect(codeBlocks(out)).toEqual(['# install deps']);
    expect(headings(out)).toEqual(['Usage']);
    expect(out).not.toContain('title=&quot;install&quot;</p>');
  });

  it('keeps languages with punctuation (c++) and braces ({.python})', async () => {
    const out = await html(
      ['```c++', 'int main() {}', '```', '```{.python}', 'x = 1', '```'].join('\n'),
    );
    expect(codeBlocks(out)).toEqual(['int main() {}', 'x = 1']);
    expect(out).toContain('c++');
    expect(out).toContain('python');
  });

  it('closes a 4-backtick fence only on a 4+ backtick line (nested ``` stays code)', async () => {
    const out = await html(['````md', '```js', 'x()', '```', '````', '', '# After'].join('\n'));
    expect(codeBlocks(out)).toEqual(['```js\nx()\n```']);
    expect(headings(out)).toEqual(['After']);
  });

  it('does not close a backtick fence with tildes (and vice versa)', async () => {
    const out = await html(['~~~', '```', 'still code', '~~~', '# Heading'].join('\n'));
    expect(codeBlocks(out)).toEqual(['```\nstill code']);
    expect(headings(out)).toEqual(['Heading']);
  });

  it('a closing fence with trailing text is content, not a close', async () => {
    const out = await html(['```', 'a', '``` not a close', 'b', '```', '# Done'].join('\n'));
    expect(codeBlocks(out)).toEqual(['a\n``` not a close\nb']);
    expect(headings(out)).toEqual(['Done']);
  });
});

describe('renderMarkdown relative links (UI-07)', () => {
  const docs = new Set(['.claude/skills/critique/reference/cognitive-load.md', 'README.md']);
  const opts: MarkdownOptions = {
    basePath: '.claude/skills/critique/SKILL.md',
    isDoc: (p) => docs.has(p),
  };

  it('resolves a sibling doc link to the Docs route for that doc', async () => {
    const out = await html('See [cognitive-load](reference/cognitive-load.md#top).', opts);
    expect(out).toContain(
      `href="/docs?doc=${encodeURIComponent('.claude/skills/critique/reference/cognitive-load.md')}"`,
    );
    expect(out).not.toContain('href="reference/cognitive-load.md');
  });

  it('resolves ../ and root-relative links; non-doc files go to the Files route', async () => {
    const out = await html('[readme](../../../README.md) [src](/src/index.ts)', opts);
    expect(out).toContain(`href="/docs?doc=README.md"`);
    expect(out).toContain(`href="/files?p=${encodeURIComponent('src/index.ts')}"`);
  });

  it('renders a link that escapes the project root as plain text', async () => {
    const out = await html('[out](../../../../etc/passwd)', opts);
    expect(out).not.toContain('<a ');
    expect(out).toContain('out');
  });

  it('leaves external, fragment and mailto links alone', async () => {
    const out = await html('[a](https://x.dev/y) [b](#usage) [c](mailto:a@b.c)', opts);
    expect(out).toContain('href="https://x.dev/y"');
    expect(out).toContain('href="#usage"');
    expect(out).toContain('href="mailto:a@b.c"');
  });

  it('still neutralises dangerous schemes', async () => {
    const out = await html('[x](javascript:alert(1))', opts);
    expect(out).not.toContain('javascript:');
  });
});
