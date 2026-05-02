/**
 * @factstack/extractors — symbol reference walker (v0.3.5 phase 1).
 *
 * Walks a parsed JS/TS AST and emits a flat list of identifier
 * references — call sites, JSX usages, and member-expression accesses.
 * Pairs with `extractSymbols()`: that one finds DEFs, this one finds
 * REFs. Together they're the substrate for v0.4 power tools
 * (`impact_of`, `find_examples`, `unused`).
 *
 * Phase 1 scope (this file): SAME-FILE references only. Cross-file
 * resolution lands in v0.3.5 phase 2 alongside the import-graph join.
 *
 * What counts as a ref (high-confidence cases the AST gives us
 * directly — no string-name guessing):
 *
 *   - CallExpression(callee=Identifier 'X')          → kind: 'call'
 *   - CallExpression(callee=MemberExpression
 *                    (object=Identifier 'X'))         → kind: 'call'
 *   - MemberExpression(object=Identifier 'X')        → kind: 'read'
 *   - JSXOpeningElement(name=JSXIdentifier 'X')      → kind: 'jsx'
 *   - TSTypeReference(typeName=Identifier 'X')       → kind: 'type-ref'
 *
 * What's NOT a ref:
 *   - The identifier being DECLARED (function X(), const X = ...)
 *   - Parameter names in function signatures
 *   - Property keys in object literals ({ X: ... } ≠ ref to X)
 *   - Imports (import X from '...') — those are tracked separately
 *     by the import extractor
 *
 * Pure / isomorphic per the package's existing convention. Same AST
 * the imports + symbols extractors share.
 */

import { isParseable, parseJS, walkAst, type ParsedFile } from './parse.js';

export type RefKind = 'call' | 'read' | 'jsx' | 'type-ref';

export interface RawRef {
  /** The identifier name being referenced. */
  name: string;
  /** Line number of the reference site. */
  line: number;
  /** What flavor of reference this is. */
  kind: RefKind;
  /**
   * `true` when the ref was inferred from a non-AST context (e.g. a
   * string literal whose value looks like a symbol name). Phase 1
   * never emits heuristic refs — every ref here is `false`.
   * Reserved for phase 2's dynamic-call detection (`callbacks[name]`).
   */
  heuristic: boolean;
}

/* AST node shape — too dynamic to type fully; treat as permissive. */
type AnyNode = {
  type?: string;
  name?: string;
  callee?: AnyNode;
  object?: AnyNode;
  property?: AnyNode;
  computed?: boolean;
  loc?: { start?: { line?: number } };
  // Skip-set markers (declaration sites + signature names)
  id?: AnyNode;
  params?: AnyNode[];
  // JSX
  openingElement?: AnyNode;
  // TS
  typeName?: AnyNode;
  // Object literals (so we can skip property keys)
  key?: AnyNode;
  shorthand?: boolean;
};

/**
 * Extract identifier references from a JS/TS source. The skip-set
 * collects nodes we should NOT count as refs (declaration sites,
 * parameter names, property keys), populated as we walk.
 */
export function extractSymbolRefs(source: string, ext: string, parsed?: ParsedFile | null): RawRef[] {
  if (!isParseable(ext)) return [];
  const pf = parsed ?? parseJS(source, ext);
  if (!pf) return [];

  const skip = new WeakSet<object>();
  /* Pre-pass: mark every AST node that's a declaration name, a
     parameter name, or a (non-shorthand) object property key. The
     main walk skips refs whose underlying node is in this set. */
  walkAst(pf.ast, (n: AnyNode | null) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration' ||
        n.type === 'TSInterfaceDeclaration' || n.type === 'TSTypeAliasDeclaration' ||
        n.type === 'TSEnumDeclaration') {
      if (n.id) skip.add(n.id as object);
    }
    if (n.type === 'VariableDeclarator' && n.id) skip.add(n.id as object);
    if (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression' ||
        n.type === 'FunctionDeclaration') {
      for (const p of n.params ?? []) skip.add(p as object);
    }
    /* Object property: `{ foo: bar }` — `foo` is a key, not a ref to
       a symbol named `foo`. Skip the key when not shorthand. (The
       shorthand `{ foo }` IS a read — the key === value identifier.) */
    if (n.type === 'ObjectProperty' && !n.shorthand && n.key) {
      skip.add(n.key as object);
    }
  });

  const refs: RawRef[] = [];
  /* The walker is pre-order with no parent context. To classify a
     given Identifier correctly, we PRE-CLAIM it during the parent
     visit (CallExpression / JSXOpeningElement / TSTypeReference /
     MemberExpression-object) by adding it to the skip set with the
     intended classification stashed on the side. The bare-Identifier
     branch at the end then knows whether to ignore (already
     claimed) or emit a 'read'. */
  const claimed = new WeakMap<object, RefKind>();

  walkAst(pf.ast, (n: AnyNode | null) => {
    if (!n || typeof n !== 'object') return;

    /* CallExpression — claim the callee identifier as 'call'. */
    if (n.type === 'CallExpression' && n.callee) {
      const c = n.callee;
      if (c.type === 'Identifier' && typeof c.name === 'string' && !skip.has(c as object)) {
        refs.push({
          name: c.name as string,
          line: c.loc?.start?.line ?? n.loc?.start?.line ?? 0,
          kind: 'call',
          heuristic: false,
        });
        claimed.set(c as object, 'call');
      } else if (c.type === 'MemberExpression' && c.object?.type === 'Identifier' &&
                 typeof c.object.name === 'string' && !skip.has(c.object as object)) {
        /* `X.foo()` — record 'call' for the root identifier and claim
           it so the MemberExpression branch below doesn't double-count
           it as a 'read'. */
        refs.push({
          name: c.object.name as string,
          line: c.object.loc?.start?.line ?? n.loc?.start?.line ?? 0,
          kind: 'call',
          heuristic: false,
        });
        claimed.set(c.object as object, 'call');
      }
    }

    /* MemberExpression with Identifier object — kind: 'read', UNLESS
       already claimed as 'call' above. */
    if (n.type === 'MemberExpression' && n.object?.type === 'Identifier' &&
        typeof n.object.name === 'string' && !skip.has(n.object as object) &&
        !claimed.has(n.object as object)) {
      refs.push({
        name: n.object.name as string,
        line: n.object.loc?.start?.line ?? n.loc?.start?.line ?? 0,
        kind: 'read',
        heuristic: false,
      });
      claimed.set(n.object as object, 'read');
    }

    /* JSXOpeningElement — claim the name identifier as 'jsx'. */
    if (n.type === 'JSXOpeningElement' && n.name && typeof n.name === 'object') {
      const nm = n.name as AnyNode;
      if (nm.type === 'JSXIdentifier' && typeof nm.name === 'string') {
        const first = nm.name.charCodeAt(0);
        if (first >= 0x41 && first <= 0x5A) {
          refs.push({
            name: nm.name as string,
            line: nm.loc?.start?.line ?? n.loc?.start?.line ?? 0,
            kind: 'jsx',
            heuristic: false,
          });
          claimed.set(nm as object, 'jsx');
        }
      }
    }

    /* TSTypeReference — claim the typeName as 'type-ref'. */
    if (n.type === 'TSTypeReference' && n.typeName) {
      const tn = n.typeName;
      if (tn.type === 'Identifier' && typeof tn.name === 'string') {
        refs.push({
          name: tn.name as string,
          line: tn.loc?.start?.line ?? n.loc?.start?.line ?? 0,
          kind: 'type-ref',
          heuristic: false,
        });
        claimed.set(tn as object, 'type-ref');
      }
    }

    /* Bare Identifier — fallback for everything not otherwise claimed.
       This is what catches `const y = X` / `f(X)` / `x.foo` (the
       `x` here was claimed by MemberExpression, but if used bare
       like `bar` in `f(bar)`, the arg is a fresh Identifier).
       Emit as 'read' when not in skip set AND not already claimed. */
    if (n.type === 'Identifier' && typeof n.name === 'string' &&
        !skip.has(n as object) && !claimed.has(n as object)) {
      refs.push({
        name: n.name as string,
        line: n.loc?.start?.line ?? 0,
        kind: 'read',
        heuristic: false,
      });
    }
  });

  return dedupe(refs);
}

/** Collapse (name, line, kind) duplicates into a single ref. The
 *  walker can hit the same identifier multiple times when nested
 *  expressions reference it (e.g. `f(x).g(x)` records `x` twice on
 *  the same line). Counting once per site is the honest answer. */
function dedupe(refs: RawRef[]): RawRef[] {
  const seen = new Set<string>();
  const out: RawRef[] = [];
  for (const r of refs) {
    const k = `${r.name}|${r.line}|${r.kind}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  // Stable sort: line asc, then kind, then name.
  out.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  return out;
}

/**
 * Convenience: count refs grouped by name. Useful for the v0.3.5
 * "callers" question at single-file scope: "how many places call X
 * within this file?"
 */
export function countRefsByName(refs: RawRef[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of refs) out.set(r.name, (out.get(r.name) ?? 0) + 1);
  return out;
}
