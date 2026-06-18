/**
 * @factstack/extractors — Python import extractor.
 *
 * Pure-JS line-based extractor. Python's syntax is regular enough for
 * imports that a proper AST is overkill for v0.1 — we can recognize
 * `import x`, `import x as y`, `from x import y`, `from x.y import *`
 * plus `importlib.import_module("x")` with confidence.
 *
 * Tree-sitter would catch odd cases (imports inside `exec("...")`, etc.)
 * but a two-pass regex on non-comment, non-string lines handles 99% of
 * real code without pulling in another runtime dependency.
 */

import type { RawImport } from './imports.js';

const PYTHON_EXTS = new Set(['.py', '.pyi']);

export function isPython(ext: string): boolean {
  return PYTHON_EXTS.has(ext.toLowerCase());
}

/** Extract imports from a Python source file. */
export function extractPythonImports(source: string): RawImport[] {
  const out: RawImport[] = [];
  const seen = new Set<string>();
  // Two line arrays: one stripped (used for `from` / `import` directive
  // matching so we don't false-match inside docstrings) and one raw
  // (used for dynamic-import detection, which needs the string literal
  // intact).
  const rawLines = source.split('\n');
  const strippedLines = stripStringsAndComments(source).split('\n');

  for (let i = 0; i < rawLines.length; i++) {
    const stripped = strippedLines[i]?.trim() ?? '';
    if (stripped) {
      // `from X import Y[, Z, ...]` — we want X. Supports leading dots
      // (relative imports: `from ..mod import x` → specifier = "..mod").
      const fromMatch = stripped.match(/^from\s+([.\w]+)\s+import\s+/);
      if (fromMatch && fromMatch[1]) {
        record(fromMatch[1], 'import', i + 1);
        continue;
      }

      // `import a, b.c as d, e` — split on commas, keep the dotted
      // specifier, drop `as …` and trailing comments.
      const importMatch = stripped.match(/^import\s+(.+)$/);
      if (importMatch && importMatch[1]) {
        const tail = importMatch[1].replace(/#.*$/, '').trim();
        for (const part of tail.split(',')) {
          const mod = part.trim().split(/\s+as\s+/)[0]?.trim();
          if (mod && /^[.\w][.\w]*$/.test(mod)) record(mod, 'import', i + 1);
        }
        continue;
      }
    }

    // Dynamic detection must look at the raw source — stripStringsAndComments
    // replaces the quoted argument with spaces.
    const raw = rawLines[i] ?? '';
    const dyn = raw.match(/\b(?:importlib\.import_module|__import__)\s*\(\s*['"]([^'"]+)['"]/);
    if (dyn && dyn[1]) record(dyn[1], 'dynamic-import', i + 1);
  }

  function record(specifier: string, kind: RawImport['kind'], line: number) {
    const key = specifier + '|' + kind;
    if (seen.has(key)) return;
    seen.add(key);
    // F2 `names` (local bindings) is JS/TS-only for now — the symbol
    // resolver runs on JS/TS outlines, so Python imports carry no bindings.
    out.push({ specifier, kind, line, names: [] });
  }

  return out;
}

/**
 * Strip Python triple-quoted strings + line comments so our regex doesn't
 * hit text like `"from importlib import …"` inside a docstring. Keeps
 * line count intact so line numbers stay correct.
 */
function stripStringsAndComments(src: string): string {
  let out = '';
  let i = 0;
  let inTriple: '"""' | "'''" | null = null;
  while (i < src.length) {
    if (inTriple) {
      const end = src.indexOf(inTriple, i);
      if (end < 0) {
        // Unterminated — replace everything with newlines to preserve line numbers.
        out += src.slice(i).replace(/[^\n]/g, ' ');
        break;
      }
      // Replace body with spaces but keep newlines.
      out += src.slice(i, end).replace(/[^\n]/g, ' ');
      out += inTriple;
      i = end + 3;
      inTriple = null;
      continue;
    }
    const tripleD = src.startsWith('"""', i);
    const tripleS = src.startsWith("'''", i);
    if (tripleD || tripleS) {
      const marker = (tripleD ? '"""' : "'''") as '"""' | "'''";
      // Is this a closing triple on the same line as opening? Check ahead.
      const endOnSame = src.indexOf(marker, i + 3);
      if (endOnSame >= 0 && !src.slice(i + 3, endOnSame).includes('\n')) {
        // Single-line triple — consume inline.
        out += marker + src.slice(i + 3, endOnSame).replace(/[^\n]/g, ' ') + marker;
        i = endOnSame + 3;
        continue;
      }
      inTriple = marker;
      out += marker;
      i += 3;
      continue;
    }
    const c = src[i];
    if (c === '#') {
      // line comment — skip to newline
      const nl = src.indexOf('\n', i);
      if (nl < 0) break;
      out += ''.padEnd(nl - i, ' ');
      i = nl;
      continue;
    }
    if (c === '"' || c === "'") {
      // single-line string — scan to matching, ignore escapes
      const quote = c;
      let j = i + 1;
      while (j < src.length && src[j] !== quote && src[j] !== '\n') {
        if (src[j] === '\\' && j + 1 < src.length) j++;
        j++;
      }
      out += ''.padEnd(j - i + 1, ' ');
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
