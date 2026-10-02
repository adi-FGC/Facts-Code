/**
 * CommonMark-shaped fenced-code detection, pure (no node:*), so the analyzer's
 * doc outline, TODOs and diagrams agree with the Docs body the dashboard
 * renders (UI-08). The dashboard imports this file through the
 * `@factstack/core/md-fence` subpath (guarded by ui-remix's coreSubpaths test).
 *
 *   - An opener is 3+ backticks or 3+ tildes, then an optional info string.
 *     A backtick opener's info string may not contain a backtick (that's an
 *     inline code span, not a fence). The language is the info string's first
 *     word: ```bash title="x" → bash, ```c++ → c++, ```{.python} → python.
 *   - A closer uses the SAME character, at least as many of them, and nothing
 *     but whitespace after — so ```` can nest ``` and ~~~ never closes ```.
 *
 * Lines are expected pre-trimmed.
 */

export interface FenceOpen {
  char: '`' | '~';
  len: number;
  /** First word of the info string, lowercased; '' when absent. */
  lang: string;
}

const OPEN = /^(`{3,}|~{3,})(.*)$/;
const CLOSE = /^(`{3,}|~{3,})\s*$/;

export function parseFenceOpen(line: string): FenceOpen | null {
  const m = OPEN.exec(line);
  if (!m) return null;
  const marks = m[1] ?? '';
  const info = (m[2] ?? '').trim();
  const char = marks[0] === '~' ? '~' : '`';
  if (char === '`' && info.includes('`')) return null;
  const word = (info.split(/\s+/)[0] ?? '').replace(/^\{\s*\.?|\}$/g, '').replace(/[,}].*$/, '');
  return { char, len: marks.length, lang: word.toLowerCase() };
}

export function isFenceClose(line: string, open: FenceOpen): boolean {
  const m = CLOSE.exec(line);
  if (!m) return false;
  const marks = m[1] ?? '';
  return marks[0] === open.char && marks.length >= open.len;
}
