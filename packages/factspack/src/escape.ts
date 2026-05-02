/**
 * FactsPack cell escaping — spec §4 + §10.
 *
 * Three (and ONLY three) escape sequences are defined:
 *   `\t`   tab inside a cell value  (literal tab is the field separator)
 *   `\n`   newline inside a cell    (literal newline is the record separator)
 *   `\\`   literal backslash        (the escape character itself)
 *
 * Anything else after `\` is a parse error. The spec is intentionally
 * minimal here: PACK has no quoting layer, no other escapes, no
 * Unicode-escape syntax. UTF-8 cells pass through verbatim.
 *
 * Pure / no allocations beyond the result string. Single-pass walker,
 * O(n) on cell length.
 */

/** Encode a literal cell value into its on-the-wire form. */
export function escapeCell(s: string): string {
  // Hot path: if the cell contains none of the three reserved bytes,
  // return it unchanged. Most analyzer cells (paths, names, line
  // numbers) hit this branch.
  let needsEscape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x09 /* \t */ || c === 0x0A /* \n */ || c === 0x5C /* \\ */) {
      needsEscape = true;
      break;
    }
  }
  if (!needsEscape) return s;

  // Slow path: rebuild with escapes.
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x09) out += '\\t';
    else if (c === 0x0A) out += '\\n';
    else if (c === 0x5C) out += '\\\\';
    else out += s[i];
  }
  return out;
}

/**
 * Decode an on-the-wire cell back to its literal value. Throws on
 * unknown escapes — silent best-effort parsing is forbidden by the
 * spec ("MUST be rejected").
 */
export function unescapeCell(s: string): string {
  // Hot path: no `\` anywhere ⇒ return as-is.
  if (s.indexOf('\\') < 0) return s;

  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 0x5C /* \\ */) {
      out += s[i];
      continue;
    }
    // We're on a backslash — the next byte must be one of t/n/\.
    if (i + 1 >= s.length) {
      throw new PackEscapeError(
        `Unterminated escape sequence at end of cell: ${truncate(s)}`,
      );
    }
    const n = s.charCodeAt(i + 1);
    if (n === 0x74 /* t */) out += '\t';
    else if (n === 0x6E /* n */) out += '\n';
    else if (n === 0x5C /* \\ */) out += '\\';
    else {
      throw new PackEscapeError(
        `Unknown escape \\${s[i + 1]} in cell: ${truncate(s)}`,
      );
    }
    i++;
  }
  return out;
}

/** Distinct error class so callers can `instanceof`-check escape failures
 *  separately from header / schema / version mismatches. */
export class PackEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackEscapeError';
  }
}

/** Trim a string for use in error messages so we don't dump megabytes
 *  of context on a single bad cell. */
function truncate(s: string, max = 80): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}
