import { describe, expect, it } from 'vitest';
import { stripInlineMarkdown } from '../src/plain-text.js';

/* UI-15 — summary.oneLiner kept README Markdown verbatim. The dashboard's
   Overview headline imports this same function (@factstack/core/plain-text). */
describe('stripInlineMarkdown', () => {
  it('keeps a link label and drops its target', () => {
    expect(stripInlineMarkdown('See [setup](docs/setup.md).')).toBe('See setup.');
    expect(stripInlineMarkdown('See [the guide][guide].')).toBe('See the guide.');
  });

  it('unwraps emphasis, strong and code spans', () => {
    expect(stripInlineMarkdown('**Fast**, _typed_ `cli` for *agents*')).toBe(
      'Fast, typed cli for agents',
    );
    expect(stripInlineMarkdown('__bold__ and ~plain~')).toBe('bold and ~plain~');
  });

  it('leaves identifiers and literal symbols alone', () => {
    expect(stripInlineMarkdown('Use snake_case_names and 2 * 3 * 4')).toBe(
      'Use snake_case_names and 2 * 3 * 4',
    );
    expect(stripInlineMarkdown('Run `a*b*c` now')).toBe('Run a*b*c now');
  });

  it('drops images to their alt text and strips inline HTML tags', () => {
    expect(stripInlineMarkdown('![logo](x.png) A <b>tool</b><br/> for you')).toBe(
      'logo A tool for you',
    );
  });

  it('keeps autolink text instead of dropping it as an HTML tag', () => {
    expect(stripInlineMarkdown('Docs at <https://example.com>.')).toBe(
      'Docs at https://example.com.',
    );
    expect(stripInlineMarkdown('Mail <mailto:a@b.co> or <team@example.com>')).toBe(
      'Mail mailto:a@b.co or team@example.com',
    );
  });

  it('leaves intraword __ alone (not emphasis in CommonMark)', () => {
    expect(stripInlineMarkdown('Call foo__bar__baz now')).toBe('Call foo__bar__baz now');
    expect(stripInlineMarkdown('A __bold__ word and a**b**c')).toBe('A bold word and abc');
  });

  it('is a no-op on plain prose', () => {
    expect(stripInlineMarkdown('A plain one-liner.')).toBe('A plain one-liner.');
  });
});
