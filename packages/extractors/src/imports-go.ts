/**
 * @factstack/extractors — Go import + symbol extractor.
 *
 * F6 — pure line-based extractor in the established per-language pattern
 * (mirrors imports-python.ts). Go's TOP-LEVEL grammar is line-anchored enough
 * that a real AST is overkill for imports + declarations: `import` blocks,
 * `func`/`type`/`var`/`const` all start at column 0 in gofmt'd code, and the
 * language enforces brace style, so brace-depth tracking recovers decl spans
 * reliably. (Tree-sitter remains the documented path for languages without
 * this regularity — see the F6 plan.)
 *
 * Go gives us one delightful freebie: EXPORTED IS SYNTAX. An uppercase first
 * letter is the export keyword, so the `exported` flag is exact, not inferred.
 */

import type { RawImport } from './imports.js';
import type { ExtractedSymbol } from './symbols.js';

const GO_EXTS = new Set(['.go']);

export function isGo(ext: string): boolean {
  return GO_EXTS.has(ext.toLowerCase());
}

/** Extract imports from a Go source file: single-line `import [alias] "path"`
 *  and block `import ( ... )` forms, including `.`/`_` aliases. */
export function extractGoImports(source: string): RawImport[] {
  const out: RawImport[] = [];
  const seen = new Set<string>();
  // Comments stripped so a commented-out import doesn't register; strings kept
  // intact because the import PATH is a string literal.
  const lines = stripGoComments(source).split('\n');

  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (!inBlock) {
      const single = line.match(/^import\s+(?:[\w.]+\s+)?"([^"]+)"/);
      if (single?.[1]) { record(single[1], i + 1); continue; }
      if (/^import\s*\($/.test(line) || /^import\s*\(/.test(line)) { inBlock = true; continue; }
    } else {
      if (line.startsWith(')')) { inBlock = false; continue; }
      const entry = line.match(/^(?:[\w.]+\s+|_\s+|\.\s+)?"([^"]+)"/);
      if (entry?.[1]) record(entry[1], i + 1);
    }
  }

  function record(specifier: string, line: number): void {
    if (seen.has(specifier)) return;
    seen.add(specifier);
    // `names` (local bindings) drives the JS/TS symbol resolver only.
    out.push({ specifier, kind: 'import', line, names: [] });
  }
  return out;
}

/** Map a Go declaration head to the shared symbol-kind vocabulary. */
function typeKind(rest: string): ExtractedSymbol['kind'] {
  if (/^\s*struct\b/.test(rest)) return 'class';
  if (/^\s*interface\b/.test(rest)) return 'interface';
  return 'type';
}

/**
 * Extract top-level declarations: functions, methods (receiver funcs), types,
 * and var/const (incl. grouped blocks). `endLine` is recovered by brace-depth
 * tracking from the declaration line; braceless decls end on their own line.
 */
export function extractGoSymbols(source: string): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  // Strings are BLANKED here (second arg) — the decl regexes never need string
  // contents, and braceEnd must not count a `{` inside `fmt.Sprintf("{%d}")`
  // toward brace depth (it would bleed endLine into the next declaration).
  const lines = stripGoComments(source, true).split('\n');

  const push = (name: string, kind: ExtractedSymbol['kind'], startLine: number, endLine: number): void => {
    out.push({ name, kind, startLine, endLine, exported: /^[A-Z]/.test(name) });
  };

  let group: 'var' | 'const' | 'type' | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    if (group) {
      const t = line.trim();
      if (t.startsWith(')')) { group = null; continue; }
      const entry = t.match(/^(\w+)/);
      if (entry?.[1] && entry[1] !== '_') {
        const end = braceEnd(lines, i);
        if (group === 'type') {
          push(entry[1], typeKind(t.slice(entry[1].length).trim()), i + 1, end);
        } else {
          push(entry[1], group === 'const' ? 'constant' : 'variable', i + 1, end);
        }
        // Skip a multi-line entry body (a struct inside a `type (...)` group,
        // a composite literal inside `var (...)`) so its inner lines don't
        // register as bogus sibling entries.
        if (end > i + 1) i = end - 1;
      }
      continue;
    }

    // func Name(  |  func (r *Recv) Name(
    const fn = line.match(/^func\s+(?:\([^)]*\)\s+)?(\w+)\s*[([]/);
    if (fn?.[1]) {
      const isMethod = /^func\s+\(/.test(line);
      push(fn[1], isMethod ? 'method' : 'function', i + 1, braceEnd(lines, i));
      continue;
    }
    // type Name struct/interface/alias (the grouped `type (` opener has no
    // name after `type`, so it falls through to the group matcher below)
    const ty = line.match(/^type\s+(\w+)(?:\[[^\]]*\])?\s+(.*)$/);
    if (ty?.[1]) { push(ty[1], typeKind(ty[2] ?? ''), i + 1, braceEnd(lines, i)); continue; }
    // var X / const X (single) or grouped block opener (var/const/type)
    const vc = line.match(/^(var|const|type)\s+(.*)$/);
    if (vc?.[1]) {
      const tail = (vc[2] ?? '').trim();
      if (tail.startsWith('(')) { group = vc[1] as 'var' | 'const' | 'type'; continue; }
      if (vc[1] === 'type') continue; // a named type already matched above
      const name = tail.match(/^(\w+)/)?.[1];
      if (name && name !== '_') push(name, vc[1] === 'const' ? 'constant' : 'variable', i + 1, i + 1);
    }
  }
  return out;
}

/** Line index (1-based) where the brace opened on `start`'s line closes; the
 *  start line itself when the declaration carries no braces. */
function braceEnd(lines: string[], start: number): number {
  let depth = 0; // brace nesting of the declaration body
  let sig = 0; // paren/bracket nesting of a (possibly multi-line) signature or type-param list
  let opened = false;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i] ?? '') {
      if (ch === '{') { depth++; opened = true; }
      else if (ch === '}') depth--;
      else if (ch === '(' || ch === '[') sig++;
      else if (ch === ')' || ch === ']') sig--;
    }
    if (opened && depth <= 0) return i + 1; // body brace closed
    // Braceless declaration (type alias, single var/const) — OR a multi-line
    // func/method signature that gofmt wrapped across lines. Only conclude
    // "braceless" once the signature's parens/brackets are balanced AND no
    // brace ever opened: that means the logical declaration line ended with no
    // `{` body. Concluding at i===start would truncate any wrapped signature
    // whose opening `{` lands on a later line.
    if (!opened && sig <= 0) return i + 1;
  }
  return lines.length; // unterminated — clamp to EOF, never crash (F6 edge rule)
}

/**
 * Strip `//` line comments and `/* ... *​/` block comments while preserving
 * line count. String literals ("..." and `...` raw strings, '.' runes) are
 * tracked so a comment marker inside one never eats the rest of the line;
 * their CONTENTS are kept verbatim by default (import paths are strings) or
 * blanked to spaces when `blankStrings` is set (the symbol scanner's brace
 * counter must not see a `{` inside `Sprintf("{%d}")`).
 */
function stripGoComments(src: string, blankStrings = false): string {
  let out = '';
  let i = 0;
  let mode: 'code' | 'block' | 'dq' | 'raw' | 'rune' = 'code';
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && next === '/') {
        const nl = src.indexOf('\n', i);
        if (nl < 0) break;
        out += ''.padEnd(nl - i, ' ');
        i = nl;
        continue;
      }
      if (c === '/' && next === '*') { mode = 'block'; out += '  '; i += 2; continue; }
      if (c === '"') mode = 'dq';
      else if (c === '`') mode = 'raw';
      else if (c === "'") mode = 'rune';
      out += c; i++;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && next === '/') { mode = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' '; i++;
      continue;
    }
    // String modes — verbatim or blanked; handle escapes (raw strings have none).
    if ((mode === 'dq' && c === '"') || (mode === 'raw' && c === '`') || (mode === 'rune' && c === "'")) {
      mode = 'code'; out += c; i++;
      continue;
    }
    if (mode !== 'raw' && c === '\\' && next !== undefined) {
      out += blankStrings ? '  ' : c + next;
      i += 2;
      continue;
    }
    out += blankStrings ? (c === '\n' ? '\n' : ' ') : c;
    i++;
  }
  return out;
}
