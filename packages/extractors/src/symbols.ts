/**
 * @factstack/extractors — JS/TS symbol extractor.
 *
 * Walks the @babel/parser AST (shared with imports.ts via parseJS()) and
 * emits SymbolSchema-shaped declarations for every top-level thing an
 * AI agent or CXO would ask about: functions, classes (with their
 * methods), types, interfaces, enums, React components, exported
 * top-level constants.
 *
 * Design choices (locked defaults from Phase 3):
 *   - JS/TS only in v0.2; Python waits for tree-sitter v0.3.
 *   - Named-binding for anonymous arrow/function expressions.
 *   - `default` for unnamed default exports.
 *   - Pure IIFEs skipped (they're execution, not declaration).
 *   - React components detected via uppercase-naming + JSX return.
 *   - Top-level `const` included ONLY when exported.
 *   - Class methods become `children` on the class symbol.
 */

import { isParseable, parseJS, walkAst, type ParsedFile } from './parse.js';

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'constant'
  | 'variable'
  | 'component'
  | 'hook'
  | 'region'
  | 'route';

export interface ExtractedSymbol {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  exported: boolean;
  /**
   * Leading JSDoc / docstring, if present. Explicitly `string | undefined`
   * (not just optional) so callers can pass `leadingDoc(node)` directly
   * under `exactOptionalPropertyTypes: true`.
   */
  docstring?: string | undefined;
  children?: ExtractedSymbol[] | undefined;
}

/**
 * Extract declarations from a JS/TS source file.
 *
 * `parsed` is optional — when omitted the function parses internally.
 * The analyzer in `packages/core` passes a pre-parsed AST so every
 * JS/TS file is parsed once and reused across import + symbol passes.
 */
export function extractSymbols(source: string, ext: string, parsed?: ParsedFile | null): ExtractedSymbol[] {
  if (!isParseable(ext)) return [];
  const pf = parsed ?? parseJS(source, ext);
  if (!pf) return [];

  const ast = pf.ast as { program?: { body?: unknown[] } };
  const body = (ast.program?.body ?? []) as AnyNode[];
  const out: ExtractedSymbol[] = [];
  // WeakSet instead of an AST-node property flag — calling extractSymbols
  // twice on the same ParsedFile used to poison nodes with a stuck
  // __fromExport marker that re-promoted un-exported consts on the 2nd
  // pass. WeakSet resets naturally each call + leaves the AST pristine.
  const fromExport = new WeakSet<object>();

  for (const node of body) {
    const syms = visitTopLevel(node, fromExport);
    for (const s of syms) out.push(s);
  }

  return dedupe(out);
}

/**
 * Visit a top-level program-body node. Returns zero or more symbols.
 * Handles the exported wrappers (ExportNamedDeclaration,
 * ExportDefaultDeclaration) by unwrapping + marking `exported: true`.
 */
function visitTopLevel(node: AnyNode | null | undefined, fromExport: WeakSet<object>): ExtractedSymbol[] {
  if (!node || typeof node !== 'object') return [];
  const t = node.type;

  // `export` wrappers — unwrap and recurse with `exported: true`.
  if (t === 'ExportNamedDeclaration') {
    const inner = node.declaration;
    if (!inner) return [];
    // Track via WeakSet so the VariableDeclaration branch knows to emit.
    // Safer than property-flagging the AST node — two calls on the same
    // ParsedFile would otherwise keep the previous run's flag.
    fromExport.add(inner as object);
    return visitTopLevel(inner, fromExport).map((s) => ({ ...s, exported: true }));
  }
  if (t === 'ExportDefaultDeclaration') {
    const inner = node.declaration;
    if (!inner) return [];
    // Unnamed default: `export default function() {}` / `export default () => …`.
    // Use 'default' as the binding name.
    const inner_type = inner.type;
    if (inner_type === 'FunctionDeclaration' || inner_type === 'ClassDeclaration') {
      const inferred = visitTopLevel(inner, fromExport).map((s) => ({
        ...s,
        name: s.name || 'default',
        exported: true,
      }));
      return inferred;
    }
    if (inner_type === 'ArrowFunctionExpression' || inner_type === 'FunctionExpression') {
      return [{
        name: 'default',
        kind: looksLikeComponent('default', inner) ? 'component' : 'function',
        startLine: lineOf(node, 'start'),
        endLine: lineOf(node, 'end'),
        exported: true,
      }];
    }
    if (inner_type === 'Identifier' && typeof inner.name === 'string') {
      return [{
        name: inner.name,
        kind: 'variable',
        startLine: lineOf(node, 'start'),
        endLine: lineOf(node, 'end'),
        exported: true,
      }];
    }
    return [];
  }

  // Bare top-level declarations.
  if (t === 'FunctionDeclaration') {
    if (!node.id?.name) return [];
    const name = node.id.name;
    return [{
      name,
      kind: looksLikeComponent(name, node) ? 'component' : (looksLikeHook(name) ? 'hook' : 'function'),
      startLine: lineOf(node, 'start'),
      endLine: lineOf(node, 'end'),
      exported: false,
      docstring: leadingDoc(node),
    }];
  }
  if (t === 'ClassDeclaration' && node.id?.name) {
    const methods: ExtractedSymbol[] = [];
    const body = node.body?.body;
    if (Array.isArray(body)) {
      for (const m of body) {
        if (!m) continue;
        if (m.type === 'ClassMethod' || m.type === 'ClassPrivateMethod') {
          const methodName = m.key?.name ?? m.key?.value;
          if (typeof methodName === 'string') {
            methods.push({
              name: methodName,
              kind: 'method',
              startLine: lineOf(m, 'start'),
              endLine: lineOf(m, 'end'),
              exported: false,
              docstring: leadingDoc(m),
            });
          }
        }
      }
    }
    return [{
      name: node.id.name,
      kind: 'class',
      startLine: lineOf(node, 'start'),
      endLine: lineOf(node, 'end'),
      exported: false,
      docstring: leadingDoc(node),
      ...(methods.length ? { children: methods } : {}),
    }];
  }
  if (t === 'TSInterfaceDeclaration' && node.id?.name) {
    return [{
      name: node.id.name, kind: 'interface',
      startLine: lineOf(node, 'start'), endLine: lineOf(node, 'end'),
      exported: false, docstring: leadingDoc(node),
    }];
  }
  if (t === 'TSTypeAliasDeclaration' && node.id?.name) {
    return [{
      name: node.id.name, kind: 'type',
      startLine: lineOf(node, 'start'), endLine: lineOf(node, 'end'),
      exported: false, docstring: leadingDoc(node),
    }];
  }
  if (t === 'TSEnumDeclaration' && node.id?.name) {
    return [{
      name: node.id.name, kind: 'enum',
      startLine: lineOf(node, 'start'), endLine: lineOf(node, 'end'),
      exported: false, docstring: leadingDoc(node),
    }];
  }

  // `const foo = …` — we only emit from the exported wrapper path
  // (where visitTopLevel is invoked with the inner declaration and the
  // result gets `exported: true` stamped). A bare VariableDeclaration
  // at the top level is always un-exported, and per the locked default
  // we skip non-exported consts to keep the outline under the size cap.
  if (t === 'VariableDeclaration') {
    if (!fromExport.has(node as object)) return [];
    const decls = Array.isArray(node.declarations) ? node.declarations : [];
    const out: ExtractedSymbol[] = [];
    for (const d of decls) {
      if (!d || d.type !== 'VariableDeclarator') continue;
      const name = d.id?.type === 'Identifier' ? d.id.name : null;
      if (!name) continue;
      const init = d.init;
      let kind: SymbolKind = 'constant';
      if (init) {
        const initType = init.type;
        if (initType === 'ArrowFunctionExpression' || initType === 'FunctionExpression') {
          kind = looksLikeComponent(name, init) ? 'component'
               : looksLikeHook(name) ? 'hook'
               : 'function';
        }
      }
      out.push({
        name,
        kind,
        startLine: lineOf(d, 'start'),
        endLine: lineOf(d, 'end'),
        exported: false,         // wrapper re-stamps
        docstring: leadingDoc(node),
      });
    }
    return out;
  }

  return [];
}

// ── Heuristics ─────────────────────────────────────────────────────────

/** React components are PascalCase AND return JSX. We do both checks — a
 *  PascalCase function that doesn't touch JSX is still a `function`. */
function looksLikeComponent(name: string, fn: AnyNode | null | undefined): boolean {
  if (!name || !/^[A-Z]/.test(name)) return false;
  return containsJsx(fn);
}

/** React hooks: camelCase starting with `use`, at least one char after. */
function looksLikeHook(name: string): boolean {
  return /^use[A-Z]/.test(name);
}

/** Recursively checks for a JSX node anywhere inside `node`'s subtree.
 *  Uses the shared `walkAst` from parse.ts so the structural-walk logic
 *  lives in one place. */
function containsJsx(node: AnyNode | null | undefined): boolean {
  if (!node || typeof node !== 'object') return false;
  let found = false;
  walkAst(node, (n) => {
    if (found) return;
    if (n.type === 'JSXElement' || n.type === 'JSXFragment') found = true;
  });
  return found;
}

// ── Misc helpers ───────────────────────────────────────────────────────

function lineOf(node: AnyNode | null | undefined, which: 'start' | 'end'): number {
  const loc = (node as { loc?: { start?: { line?: number }; end?: { line?: number } } } | null | undefined)?.loc;
  const pos = which === 'start' ? loc?.start : loc?.end;
  return typeof pos?.line === 'number' ? pos.line : 0;
}

function leadingDoc(node: AnyNode | null | undefined): string | undefined {
  const comments = (node as { leadingComments?: Array<{ type?: string; value?: string }> } | null | undefined)?.leadingComments;
  if (!Array.isArray(comments) || comments.length === 0) return undefined;
  const block = [...comments].reverse().find((c) => c?.type === 'CommentBlock' && typeof c.value === 'string' && c.value.startsWith('*'));
  if (!block?.value) return undefined;
  // Strip the JSDoc " * " line prefixes, trim, cap at 240 chars.
  const text = block.value
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  return text.length > 240 ? text.slice(0, 237) + '…' : text;
}

/** Dedupe on (name, kind, startLine) — handles overloads safely. */
function dedupe(xs: ExtractedSymbol[]): ExtractedSymbol[] {
  const seen = new Set<string>();
  const out: ExtractedSymbol[] = [];
  for (const s of xs) {
    const k = s.name + '|' + s.kind + '|' + s.startLine;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

// ── Loose AST typing ───────────────────────────────────────────────────

/** We walk the AST structurally; a loose typing avoids dragging in
 *  @babel/types as a dependency for just this one file's shape checks. */
type AnyNode = {
  type?: string;
  name?: string;
  value?: unknown;
  id?: { type?: string; name?: string };
  declaration?: AnyNode;
  declarations?: AnyNode[];
  init?: AnyNode;
  body?: AnyNode | { body?: AnyNode[] };
  key?: { name?: string; value?: string };
  loc?: { start?: { line?: number }; end?: { line?: number } };
  leadingComments?: Array<{ type?: string; value?: string }>;
  [k: string]: unknown;
};
