import { isFenceClose, parseFenceOpen, type FenceOpen } from './md-fence.js';

/** The same window scanFileLicense reads. */
const HEADER_LINES = 60;

/* Indentation, an optional `<?php`, then at most one comment leader: a short
   punctuation run (`//`, `#`, `/*`, ` *`, `--`, `;;`, `<!--`, `{{!--`), a
   vim/VB quote followed by a space, roff's `.\"`, or REM / dnl / @c. A
   backtick or a quote glued to the tag quotes it, it doesn't comment it. */
const CODE_HEADER =
  /^[ \t]*(?:<\?php[ \t]+)?(?:[^\w\s`'"]{1,6}|["'][ \t]|[.']\\"|@?rem\b|dnl\b|@c\b)?[ \t]*SPDX-License-Identifier:/i;
/* A document's own header: column 0, bare or behind a comment leader. The
   whitespace belongs to the leader: a bare tag indented with no leader is an
   RST literal block (`::` + indent) or a Markdown code block — a quote. */
const DOC_HEADER = /^(?:(?:<!--|\.\.|\/\/|#+|%)[ \t]*)?SPDX-License-Identifier:/i;

/**
 * The line holding a file's OWN SPDX license header, or null. Pure (no node:*).
 *
 * scanFileLicense (@factstack/scanners) matches `SPDX-License-Identifier:`
 * anywhere in the first 60 lines. That is right for a comment header and
 * wrong for text that QUOTES one: a CONTRIBUTING.rst saying "start each file
 * with ``SPDX-License-Identifier: GPL-2.0-only``", or a license tool holding
 * the header in a string literal, is not a GPL file, yet in an MIT project it
 * graded as a HIGH copyleft risk. So only a line that STARTS with the tag
 * counts. In docs (isDocFile) the header is the document's own, so it also
 * sits at column 0 and outside any code fence: a fenced, indented or bulleted
 * example is a quote.
 */
export function spdxHeaderLine(text: string, doc: boolean): string | null {
  let fence: FenceOpen | null = null;
  let start = 0;
  // Line by line without splitting the whole file: only the head counts.
  for (let n = 0; n < HEADER_LINES && start <= text.length; n++) {
    const nl = text.indexOf('\n', start);
    const line = nl === -1 ? text.slice(start) : text.slice(start, nl);
    start = nl === -1 ? text.length + 1 : nl + 1;
    if (!doc) {
      if (CODE_HEADER.test(line)) return line;
      continue;
    }
    const trimmed = line.trim();
    if (fence) {
      if (isFenceClose(trimmed, fence)) fence = null;
      continue;
    }
    fence = parseFenceOpen(trimmed);
    if (fence) continue;
    if (DOC_HEADER.test(line)) return line;
  }
  return null;
}
