import { describe, expect, it } from 'vitest';
import { spdxHeaderLine } from '../src/spdx-header.js';

const TAG = 'SPDX-License-Identifier: GPL-2.0-only';

/* CORE-P2-03 — only a line that STARTS with the tag (after a comment leader)
   is a file's own license header; quoting the tag is not. */
describe('spdxHeaderLine — code files', () => {
  it.each([
    `// ${TAG}`,
    `# ${TAG}`,
    `/* ${TAG} */`,
    ` * ${TAG}`,
    `-- ${TAG}`,
    `;; ${TAG}`,
    `<!-- ${TAG} -->`,
    `{{!-- ${TAG} --}}`,
    `" ${TAG}`,
    `.\\" ${TAG}`,
    `REM ${TAG}`,
    `dnl ${TAG}`,
    `@c ${TAG}`,
    `<?php // ${TAG}`,
    `\t\t// ${TAG}`,
  ])('reads %s', (line) => {
    expect(spdxHeaderLine(`first\n${line}\nlast`, false)).toBe(line);
  });

  it.each([
    `const h = '// ${TAG}';`,
    `  '// ${TAG}',`,
    `"${TAG}"`,
    `\`${TAG}\``,
    `See ${TAG} above.`,
  ])('ignores the quoted %s', (line) => {
    expect(spdxHeaderLine(line, false)).toBeNull();
  });

  it('reads the first 60 lines only', () => {
    expect(spdxHeaderLine('x\n'.repeat(59) + `// ${TAG}`, false)).toBe(`// ${TAG}`);
    expect(spdxHeaderLine('x\n'.repeat(60) + `// ${TAG}`, false)).toBeNull();
  });
});

describe('spdxHeaderLine — docs', () => {
  it.each([
    TAG,
    `.. ${TAG}`,
    `..\t${TAG}`,
    `<!-- ${TAG} -->`,
    `<!--${TAG}-->`,
    `# ${TAG}`,
    `## ${TAG}`,
    `// ${TAG}`,
    `% ${TAG}`,
  ])('reads the header %s at column 0', (line) => {
    expect(spdxHeaderLine(`${line}\n\nTitle\n=====\n`, true)).toBe(line);
  });

  it('ignores indented, bulleted, fenced and inline-quoted tags', () => {
    const md = [
      'Start each file with ``' + TAG + '``.',
      '    // ' + TAG,
      // core-2: a bare tag indented with no comment leader (an RST `::`
      // literal block or a Markdown indented code block) is a quote too.
      'Add this line to each file::',
      '',
      '    ' + TAG,
      '\t' + TAG,
      ' ' + TAG,
      '- ' + TAG,
      '* ' + TAG,
      '```c',
      '// ' + TAG,
      '```',
      '~~~',
      TAG,
      '~~~',
    ].join('\n');
    expect(spdxHeaderLine(md, true)).toBeNull();
  });
});
