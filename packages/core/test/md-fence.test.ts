import { describe, expect, it } from 'vitest';
import { isFenceClose, parseFenceOpen } from '../src/md-fence.js';

/* UI-08 — CommonMark fence rules. The dashboard's renderer imports this same
   module (@factstack/core/md-fence), so core and the UI cannot disagree. */
describe('parseFenceOpen', () => {
  it.each([
    ['```', { char: '`', len: 3, lang: '' }],
    ['```bash title="x"', { char: '`', len: 3, lang: 'bash' }],
    ['```c++', { char: '`', len: 3, lang: 'c++' }],
    ['```{.python}', { char: '`', len: 3, lang: 'python' }],
    ['````md', { char: '`', len: 4, lang: 'md' }],
    ['~~~ Mermaid', { char: '~', len: 3, lang: 'mermaid' }],
  ])('%s opens a fence', (line, open) => {
    expect(parseFenceOpen(line)).toEqual(open);
  });

  it.each(['``', '`` x', '```js```', 'text ```', '~~'])('%s is not an opener', (line) => {
    expect(parseFenceOpen(line)).toBeNull();
  });
});

describe('isFenceClose', () => {
  const ticks4 = parseFenceOpen('````md')!;
  const tilde = parseFenceOpen('~~~')!;
  const ticks3 = parseFenceOpen('```')!;

  it('closes only on the same character, at least as long, with nothing after', () => {
    expect(isFenceClose('````', ticks4)).toBe(true);
    expect(isFenceClose('`````  ', ticks4)).toBe(true);
    expect(isFenceClose('```', ticks4)).toBe(false);
    expect(isFenceClose('```', tilde)).toBe(false);
    expect(isFenceClose('~~~', ticks3)).toBe(false);
    expect(isFenceClose('``` not a close', ticks3)).toBe(false);
    expect(isFenceClose('~~~~', tilde)).toBe(true);
  });
});
