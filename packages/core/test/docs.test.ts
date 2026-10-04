import { describe, expect, it } from 'vitest';
import { buildDocFile, isDocFile, parseMarkdownStructure } from '../src/docs.js';

const doc = (path: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return isDocFile(path, dot > 0 ? name.slice(dot) : '', name);
};

describe('isDocFile — doc-like names on source files (HUNT-CORE-14)', () => {
  it.each([
    'packages/core/src/context.ts',
    'packages/spec/src/agent.ts',
    'packages/skills/src/renderers/agents.ts',
    'packages/skills/src/renderers/claude.ts',
    'apps/ui-remix/src/routes/History.tsx',
    'apps/ui-remix/src/routes/Security.tsx',
    'app/todo.py',
  ])('%s is source code, not a doc', (p) => {
    expect(doc(p)).toBe(false);
  });

  it.each([
    'CONTEXT.md',
    'CLAUDE.md',
    'LICENSE',
    'SECURITY',
    'AUTHORS',
    'CHANGELOG.rst',
    'NOTICE.html',
  ])('%s is a doc', (p) => {
    expect(doc(p)).toBe(true);
  });
});

/* UI-08 — the fence toggle closed a ```` block on an inner ``` and treated
   '``` text' as a close, so the outline, Todos and diagrams disagreed with
   the Docs body the dashboard renders (CommonMark rules, md-fence.ts). */
describe('parseMarkdownStructure — CommonMark fences (UI-08)', () => {
  const md = [
    '# Title',
    '```bash title="install.sh"',
    '# not a heading',
    '```',
    '````md',
    '```mermaid',
    'graph TD; A-->B',
    '```',
    '# still inside the four-backtick fence',
    '````',
    '~~~',
    '```',
    '- [ ] not a todo',
    '~~~',
    '```c++',
    '// TODO not a doc todo',
    '``` not a close',
    '```',
    '```{.mermaid}',
    'flowchart LR; X-->Y',
    '```',
    '## After',
    '- [ ] a real todo',
  ].join('\n');
  const s = parseMarkdownStructure(md);

  it('keeps fenced lines out of the outline and the todos', () => {
    expect(s.headings.map((h) => h.text)).toEqual(['Title', 'After']);
    expect(s.todos.map((t) => t.text)).toEqual(['a real todo']);
  });

  it('extracts only real diagrams, with the info string first word as the language', () => {
    expect(s.diagrams).toEqual([
      {
        kind: 'mermaid',
        type: 'flowchart',
        lang: 'mermaid',
        code: 'flowchart LR; X-->Y',
        line: 19,
      },
    ]);
  });
});

/* CORE-P2-02 — the hosted scan parses arbitrary repos' docs. The old
   per-line patterns were quadratic or worse on one hostile line (a 10 KB
   `[a](` line took 23 s; `# a` + 2,000 spaces took 0.5 s and grew cubically),
   and so were the HTML heading/title/tag scans. Markdown shapes are ~400 KB
   and HTML shapes ~800 KB: sizes where the mildest old pattern already took
   ~9 s, while the fixed parsers take well under 1 s. */
describe('parseMarkdownStructure / HTML docs — linear on hostile lines (CORE-P2-02)', () => {
  const N = 400_000;
  const fill = (unit: string, n = N) => unit.repeat(Math.ceil(n / unit.length));
  /* 2 s of CPU per shape. CPU, not wall time: a CI runner sharing 3-4 vCPUs
     with every other suite stretches wall time 10-20x, but not this
     process's own CPU use. Node's process, typed locally: this browser-safe
     package compiles its tests without @types/node. */
  type CpuUsage = { user: number; system: number };
  const node = globalThis as unknown as { process: { cpuUsage(prev?: CpuUsage): CpuUsage } };
  const within = (label: string, f: () => void) => {
    const start = node.process.cpuUsage();
    f();
    const { user, system } = node.process.cpuUsage(start);
    expect((user + system) / 1000, label).toBeLessThan(2_000);
  };
  const html = (text: string) =>
    buildDocFile({
      path: 'docs/page.html',
      name: 'page.html',
      ext: '.html',
      text,
      bytes: text.length,
      loc: 1,
      lastModifiedMs: null,
      storeContent: false,
    });

  it('parses hostile markdown lines in linear time', { timeout: 120_000 }, () => {
    const shapes = {
      'unclosed [': fill(' [a'),
      'unclosed ![': fill(' ![a'),
      'repeated [a](': fill('[a]('),
      'hrefs broken by [': fill('[a](bbbbbbbbbbbbbbbbbbbb['),
      'heading + space run': '# a' + ' '.repeat(N) + 'b',
      'table rule dash run': '| a | b |\n' + '-'.repeat(N) + 'x',
      'checkbox + CR': '- [ ] ' + ' '.repeat(N) + 'x\r',
      'TODOs + CR': fill('TODO ') + '\r',
    };
    for (const [label, text] of Object.entries(shapes))
      within(label, () => parseMarkdownStructure(text));
  });

  it('parses hostile HTML in linear time', { timeout: 120_000 }, () => {
    for (const [label, text] of Object.entries({
      'unclosed <h1>': fill('<h1>', 2 * N),
      'unclosed <': fill('<', 2 * N),
      'unclosed <title>': fill('<title>', 2 * N),
      'unclosed <h1 attrs': fill('<h1 a', 2 * N),
    }))
      within(label, () => html(text));
  });

  it('keeps the outline, todos, tables and links it found before', () => {
    const s = parseMarkdownStructure(
      [
        '# Title ##',
        '## C#',
        '- [x] done item',
        'TODO: write more',
        '| a | b |',
        '|:--|--:|',
        'See [setup](docs/setup.md "Setup") and [![CI](https://x/badge.svg)](https://x/ci).',
        '[w](https://en.wikipedia.org/wiki/Foo_(bar)) [a]( nope)',
      ].join('\n'),
    );
    expect(s.headings.map((h) => `${h.depth}:${h.text}`)).toEqual(['1:Title', '2:C#']);
    expect(s.todos.map((t) => t.text)).toEqual(['done item', 'write more']);
    expect(s.tableCount).toBe(1);
    expect(s.links.map((l) => `${l.text}|${l.href}`)).toEqual([
      'setup|docs/setup.md',
      '![CI|https://x/badge.svg',
      'w|https://en.wikipedia.org/wiki/Foo_(bar',
    ]);
  });

  it('reads checkboxes and TODOs on CRLF lines', () => {
    const s = parseMarkdownStructure('# Plan\r\n- [ ] ship it\r\nFIXME: the CRLF case\r\n');
    expect(s.headings.map((h) => h.text)).toEqual(['Plan']);
    expect(s.todos.map((t) => t.text)).toEqual(['ship it', 'the CRLF case']);
  });

  it('keeps HTML headings, their lines and the title', () => {
    const d = html(
      '<html><head><TITLE>Guide</TITLE></head>\n<body>\n<h1 class="x">Intro <b>now</b></h1>\n<h2></h2>\n\n<H2>Setup</H2><h3>never closed\n</body>',
    );
    expect(d.title).toBe('Guide');
    expect(d.headings.map((h) => `${h.depth}:${h.text}:${h.line}`)).toEqual([
      '1:Intro now:3',
      '2:Setup:6',
    ]);
    // Tag stripping is the old `<[^>]+>` exactly: '< b</p>' is one "tag".
    expect(html('<p>a < b</p><script>if (x < y && y > z) {}</script> <>').wordCount).toBe(6);
  });
});
