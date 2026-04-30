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
  type AnyNode = { type?: string; source?: { value?: unknown }; importKind?: string; exportKind?: string; loc?: { start?: { line?: number } }; callee?: { type?: string }; arguments?: AnyNode[]; value?: unknown };
  const ast = pf.ast as { program?: { body?: AnyNode[] } };

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
          });
        }
        break;
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
        if (typeof node.source?.value === 'string') {
          out.push({
            specifier: node.source.value,
            kind: node.exportKind === 'type' ? 'type-import' : 'import',
            line: node.loc?.start?.line ?? 0,
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
        });
      }
    }
  });

  return dedupe(out);
}

function dedupe(xs: RawImport[]): RawImport[] {
  const seen = new Set<string>();
  const out: RawImport[] = [];
  for (const x of xs) {
    const k = x.specifier + '|' + x.kind;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}
