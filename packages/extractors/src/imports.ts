/**
 * @factstack/extractors — JS/TS import extractor.
 *
 * Real AST parsing via @babel/parser. Pure-JS (no WASM, no native bindings)
 * so it runs unchanged in Node, Deno, and browsers — honors constraint C1.
 *
 * Emits a raw list of { specifier, kind, line } per file. The resolver (in
 * packages/graph) turns those specifiers into concrete file paths.
 *
 * Handles:
 *   - `import x from 'y'` / `import type x from 'y'`
 *   - `import { a } from 'y'` / `import { type a } from 'y'`
 *   - `import 'y'` (side-effect)
 *   - `export { a } from 'y'` / `export * from 'y'`
 *   - dynamic `import('y')`
 *   - CommonJS `require('y')`
 *
 * Everything else (class fields, decorators, TSX, JSX) is tolerated by the
 * parser but not walked — we only care about module-level edges.
 */

import { isParseable, parseJS, walkAst, type ParsedFile } from './parse.js';

export type ImportKind = 'import' | 'dynamic-import' | 'type-import' | 'require';

export interface RawImport {
  specifier: string;
  kind: ImportKind;
  line: number;
  /**
   * Local binding names introduced by this import (F2). For
   * `import { a, b as c } from 'm'` this is `['a', 'c']` — the LOCAL
   * names, because that's what identifier references in the file use and
   * what the symbol resolver keys its import map on. Empty for
   * side-effect / dynamic / require imports and for `export … from`
   * re-exports (which create no local binding). Aliased named imports
   * keep the alias here, so they resolve to the file but fall back to the
   * lower-confidence global tier in the resolver (a documented v1 gap).
   */
  names: string[];
}

/**
 * Extract imports from a JS/TS source. Accepts an optional pre-parsed
 * `ParsedFile` so the analyzer can share one parse across multiple
 * extractors (imports + symbols + future calls). When `parsed` is
 * omitted, falls back to the old self-parsing behavior.
 */
export function extractImports(source: string, ext: string, parsed?: ParsedFile | null): RawImport[] {
  if (!isParseable(ext)) return [];
  const pf = parsed ?? parseJS(source, ext);
  if (!pf) return [];
  // Babel AST is too dynamic to type fully; treat nodes as permissive any-records.
  type AnyNode = { type?: string; source?: { value?: unknown }; importKind?: string; exportKind?: string; loc?: { start?: { line?: number } }; callee?: { type?: string }; arguments?: AnyNode[]; value?: unknown; specifiers?: AnyNode[]; local?: { name?: unknown } };
  const ast = pf.ast as { program?: { body?: AnyNode[] } };

  /* Local binding names from an ImportDeclaration's specifiers. All three
     specifier shapes (default / namespace / named) expose `local.name`;
     for `import { x as y }` that's the alias `y`, which is what refs in the
     file actually write. */
  const bindingNames = (node: AnyNode): string[] => {
    const specs = node.specifiers;
    if (!Array.isArray(specs)) return [];
    const names: string[] = [];
    for (const s of specs) {
      const nm = s?.local?.name;
      if (typeof nm === 'string') names.push(nm);
    }
    return names;
  };

  const out: RawImport[] = [];
  const body = ast?.program?.body ?? [];

  // Module-level declarations
  for (const node of body) {
    if (!node) continue;
    switch (node.type) {
      case 'ImportDeclaration':
        if (typeof node.source?.value === 'string') {
          out.push({
            specifier: node.source.value,
            kind: node.importKind === 'type' ? 'type-import' : 'import',
            line: node.loc?.start?.line ?? 0,
            names: bindingNames(node),
          });
        }
        break;
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
        if (typeof node.source?.value === 'string') {
          // `export … from 'm'` re-exports: tracked as a file-level edge via
          // `specifier`, but binds no local name → no symbol-resolver names.
          out.push({
            specifier: node.source.value,
            kind: node.exportKind === 'type' ? 'type-import' : 'import',
            line: node.loc?.start?.line ?? 0,
            names: [],
          });
        }
        break;
    }
  }

  // Dynamic imports + requires live anywhere, so walk the full tree.
  walkAst(pf.ast, (n) => {
    if (!n) return;
    // import('…')
    if (n.type === 'CallExpression' && n.callee?.type === 'Import') {
      const arg = n.arguments?.[0];
      if (arg?.type === 'StringLiteral' && typeof arg.value === 'string') {
        out.push({
          specifier: arg.value,
          kind: 'dynamic-import',
          line: n.loc?.start?.line ?? 0,
          names: [],
        });
      }
    }
    // require('…')
    if (
      n.type === 'CallExpression' &&
      n.callee?.type === 'Identifier' &&
      n.callee.name === 'require'
    ) {
      const arg = n.arguments?.[0];
      if (arg?.type === 'StringLiteral' && typeof arg.value === 'string') {
        out.push({
          specifier: arg.value,
          kind: 'require',
          line: n.loc?.start?.line ?? 0,
          names: [],
        });
      }
    }
  });

  return dedupe(out);
}

/* Dedup by (specifier, kind), preserving first-seen order. When the same
   module is imported twice (`import { a } from 'm'; import { b } from 'm'`),
   union the binding names onto the first entry rather than dropping the
   second — otherwise the resolver would lose `b`. */
function dedupe(xs: RawImport[]): RawImport[] {
  const byKey = new Map<string, RawImport>();
  const order: string[] = [];
  for (const x of xs) {
    const k = x.specifier + '|' + x.kind;
    const prev = byKey.get(k);
    if (prev) {
      for (const n of x.names) if (!prev.names.includes(n)) prev.names.push(n);
    } else {
      byKey.set(k, { ...x, names: [...x.names] });
      order.push(k);
    }
  }
  return order.map((k) => byKey.get(k)!);
}
