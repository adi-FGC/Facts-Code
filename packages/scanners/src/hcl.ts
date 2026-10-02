/**
 * F11 — Terraform / HCL parser (whole-stack modalities, infra layer).
 *
 * A PURE, deterministic parser for the HCL `resource "type" "name" { … }`
 * construct plus the dependency edges between resources — both implicit
 * (interpolation references like `aws_vpc.main.id`) and explicit (`depends_on`).
 * It is NOT a full HCL evaluator: variables/locals/modules/expressions are not
 * resolved; only resource→resource references are surfaced. Unrecognized
 * constructs are ignored, never errored.
 *
 * Isomorphic (constraint C1): no node:* imports. Deterministic (INV2):
 * source-order output, references de-duplicated keeping first occurrence.
 * Line numbers are 1-indexed.
 */

import { lineIndex } from './line-index.js';

export interface HclResource {
  /** Resource type, e.g. `aws_s3_bucket`. */
  type: string;
  /** Local resource name, e.g. `app_data`. */
  name: string;
  line: number;
}

export interface HclDependency {
  fromType: string;
  fromName: string;
  toType: string;
  toName: string;
  line: number;
}

export interface ParsedHcl {
  resources: HclResource[];
  dependencies: HclDependency[];
}

/**
 * Blank out comments + heredoc bodies, preserving double-quoted strings (which
 * carry resource names + `${type.name}` interpolation refs) and all newlines so
 * line numbers + offsets stay exact. A single string/heredoc-aware pass: comment
 * delimiters are recognized only in code state, so a block-comment-close
 * sequence inside a string (e.g. an ARN or URL containing star-slash) can no
 * longer prematurely terminate a comment and eat a resource's braces; and a
 * `{` inside a heredoc body can no longer unbalance `matchBrace` (the body is
 * blanked to spaces). Unterminated block comments are consumed to EOF.
 */
/**
 * Index just past the `"…"` string that opens at `start`. Honors `\` escapes
 * and `${ … }` / `%{ … }` template sequences, which may hold NESTED quoted
 * strings (`"${format("arn:%s/*", x)}"`, TF 0.11 style) — ending the string
 * at the first inner quote read `/*` as a comment that ate the rest of the
 * file. `$${` / `%%{` are literal. Unterminated → the text's end.
 * Iterative, with an explicit stack of open contexts: recursing per nested
 * `"${` overflowed the call stack at a few thousand levels (a fuzz-corpus
 * .tf aborted the whole analyze).
 */
function stringEnd(text: string, start: number): number {
  // Innermost last: 0 = inside a string, n > 0 = inside a template at brace depth n.
  const open: number[] = [0];
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    const top = open.length - 1;
    const depth = open[top]!;
    if (depth > 0) {
      if (c === '"') open.push(0);
      else if (c === '{') open[top] = depth + 1;
      else if (c === '}') {
        if (depth === 1) open.pop();
        else open[top] = depth - 1;
      }
      i++;
      continue;
    }
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '"') {
      open.pop();
      i++;
      if (open.length === 0) return i;
      continue;
    }
    if ((c === '$' || c === '%') && text[i + 1] === c && text[i + 2] === '{') {
      i += 3;
      continue;
    }
    if ((c === '$' || c === '%') && text[i + 1] === '{') {
      open.push(1);
      i += 2;
      continue;
    }
    i++;
  }
  return text.length;
}

function stripHclComments(src: string): string {
  const out: string[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    // "…" string — preserve verbatim (incl. ${type.name} interpolations).
    if (c === '"') {
      const end = stringEnd(src, i);
      out.push(src.slice(i, end));
      i = end;
      continue;
    }
    // <<MARKER / <<-MARKER heredoc — keep header + terminator, blank the body.
    if (c === '<' && c2 === '<') {
      let j = i + 2;
      if (src[j] === '-') j++;
      let mk = '';
      while (j < n && /[A-Za-z0-9_]/.test(src[j]!)) {
        mk += src[j];
        j++;
      }
      if (mk) {
        while (i < n && src[i] !== '\n') {
          out.push(src[i]!);
          i++;
        }
        if (i < n) {
          out.push('\n');
          i++;
        }
        while (i < n) {
          let line = '';
          while (i < n && src[i] !== '\n') {
            line += src[i];
            i++;
          }
          const isTerm = line.trim() === mk;
          for (let k = 0; k < line.length; k++) out.push(isTerm ? line[k]! : ' ');
          if (i < n) {
            out.push('\n');
            i++;
          }
          if (isTerm) break;
        }
        continue;
      }
    }
    // # or // line comment.
    if (c === '#' || (c === '/' && c2 === '/')) {
      while (i < n && src[i] !== '\n') {
        out.push(' ');
        i++;
      }
      continue;
    }
    // /* block comment */ (to EOF if unterminated).
    if (c === '/' && c2 === '*') {
      out.push(' ', ' ');
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out.push(src[i] === '\n' ? '\n' : ' ');
        i++;
      }
      if (i < n) {
        out.push(' ', ' ');
        i += 2;
      }
      continue;
    }
    out.push(c!);
    i++;
  }
  return out.join('');
}

/** Index of the `}` matching the `{` at `openIdx`, skipping double-quoted
 *  strings (so `"${...}"` interpolations don't unbalance the count). */
function matchBrace(text: string, openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      i = stringEnd(text, i);
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

const RESOURCE_RE = /\bresource\s+"([^"]+)"\s+"([^"]+)"\s*\{/g;
/** A `type.name` reference token (provider_resource.local_name). */
const REF_RE = /\b([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_-]*)/g;

interface ResourceBlock extends HclResource {
  bodyStart: number;
  bodyEnd: number;
}

/**
 * Parse a `.tf` / `.hcl` source into resources + their dependency edges.
 * Always returns a (possibly empty) result; never throws.
 */
export function parseHcl(source: string): ParsedHcl {
  const src = stripHclComments(source);
  const lineAt = lineIndex(src);

  // ── Pass 1: collect resource blocks ──
  const blocks: ResourceBlock[] = [];
  RESOURCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RESOURCE_RE.exec(src)) !== null) {
    const type = m[1] ?? '';
    const name = m[2] ?? '';
    if (!type || !name) continue;
    const openIdx = src.indexOf('{', m.index + m[0].length - 1);
    if (openIdx < 0) continue;
    const closeIdx = matchBrace(src, openIdx);
    if (closeIdx < 0) continue;
    blocks.push({
      type,
      name,
      line: lineAt(m.index),
      bodyStart: openIdx + 1,
      bodyEnd: closeIdx,
    });
    // Resume scanning after this block's header (nested blocks of other kinds
    // are skipped; resources don't nest resources in practice).
    RESOURCE_RE.lastIndex = openIdx + 1;
  }

  const declared = new Set(blocks.map((b) => `${b.type}.${b.name}`));
  const resources: HclResource[] = blocks.map((b) => ({
    type: b.type,
    name: b.name,
    line: b.line,
  }));

  // ── Pass 2: resource→resource references inside each block body ──
  const dependencies: HclDependency[] = [];
  for (const b of blocks) {
    const selfId = `${b.type}.${b.name}`;
    const body = src.slice(b.bodyStart, b.bodyEnd);
    const seen = new Set<string>();
    REF_RE.lastIndex = 0;
    let r: RegExpExecArray | null;
    while ((r = REF_RE.exec(body)) !== null) {
      const toType = r[1] ?? '';
      const toName = r[2] ?? '';
      const targetId = `${toType}.${toName}`;
      if (targetId === selfId) continue;
      if (!declared.has(targetId)) continue;
      if (seen.has(targetId)) continue;
      seen.add(targetId);
      dependencies.push({
        fromType: b.type,
        fromName: b.name,
        toType,
        toName,
        line: lineAt(b.bodyStart + r.index),
      });
    }
  }

  return { resources, dependencies };
}
