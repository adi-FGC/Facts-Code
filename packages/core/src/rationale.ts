/**
 * F10 — rationale linker. Attaches "the why" (NOTE/HACK/FIXME/TODO/XXX
 * comments + docstrings) to the code it explains, so retrieval can surface
 * intent, not just structure.
 *
 * Pure / isomorphic (INV1) and deterministic (INV2): same inputs → byte-
 * identical output. All inputs already live on the artifact:
 *   - FileOutline.todos[]                  NOTE/HACK/XXX/FIXME/TODO + line
 *   - FileOutline.declarations[].docstring per-symbol doc comment
 *   - graph.symbolNodes[]                  F2 — gives the enclosing symbol
 *
 * Attribution: a comment is linked to the INNERMOST symbol whose line span
 * contains it (line-span containment, like the symbol resolver). A docstring
 * links to its own declaration exactly (the decl's name+startLine IS the F2
 * symbolId). Without symbol resolution (no `--symbols`), `symbolNodes` is
 * empty and items attach at FILE level (`symbol: null`) — "works at file
 * level without F2" per the plan.
 */

import type { FileOutline, Symbol as SymbolDecl, SymbolNode, Rationale, RationaleKind } from '@factstack/spec';
import { symbolId } from '@factstack/spec';

/** Cap rationale text so a giant block comment can't bloat the artifact. */
const TEXT_CAP = 280;

function cap(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= TEXT_CAP ? t : t.slice(0, TEXT_CAP - 1) + '…';
}

/**
 * Innermost symbol node whose span contains `line` (smallest span wins;
 * deeper-nested beats its parent on a tie via the later `startLine`).
 * Undefined when the line is outside every declaration (module-level) — such
 * items attach at file level.
 */
function enclosing(nodes: readonly SymbolNode[], line: number): SymbolNode | undefined {
  let best: SymbolNode | undefined;
  for (const n of nodes) {
    if (line < n.startLine || line > n.endLine) continue;
    if (!best) { best = n; continue; }
    const span = n.endLine - n.startLine;
    const bestSpan = best.endLine - best.startLine;
    if (span < bestSpan || (span === bestSpan && n.startLine > best.startLine)) best = n;
  }
  return best;
}

function walkDecls(decls: readonly SymbolDecl[], visit: (d: SymbolDecl) => void): void {
  for (const d of decls) {
    visit(d);
    if (d.children && d.children.length) walkDecls(d.children, visit);
  }
}

/**
 * Build the rationale facts for an analyzed project.
 *
 * @param files       every analyzed file (todos + declarations).
 * @param symbolNodes F2 symbol nodes (empty when analysis ran without --symbols).
 */
export function buildRationale(
  files: readonly FileOutline[],
  symbolNodes: readonly SymbolNode[] = [],
): Rationale[] {
  // Index symbol nodes by file once for O(1) enclosing lookups.
  const nodesByFile = new Map<string, SymbolNode[]>();
  for (const n of symbolNodes) {
    const arr = nodesByFile.get(n.path);
    if (arr) arr.push(n); else nodesByFile.set(n.path, [n]);
  }

  const out: Rationale[] = [];
  for (const f of files) {
    const fileNodes = nodesByFile.get(f.path) ?? [];

    // 1. TODO-family comments → innermost enclosing symbol (or file-level).
    for (const t of f.todos ?? []) {
      const text = cap(t.text);
      if (!text) continue;
      const sym = enclosing(fileNodes, t.line);
      out.push({
        id: `${f.path}@${t.line}#${t.kind.toLowerCase()}`,
        symbol: sym ? sym.id : null,
        file: f.path,
        line: t.line,
        kind: t.kind.toLowerCase() as RationaleKind,
        text,
      });
    }

    // 2. Docstrings → their own declaration's symbol id (exact, not span-based:
    //    the decl's name+startLine is precisely the F2 symbolId).
    walkDecls(f.declarations ?? [], (d) => {
      if (!d.docstring) return;
      const text = cap(d.docstring);
      if (!text) return;
      out.push({
        id: `${f.path}@${d.startLine}#docstring`,
        symbol: symbolId(f.path, d.name, d.startLine),
        file: f.path,
        line: d.startLine,
        kind: 'docstring',
        text,
      });
    });
  }

  // Deterministic order: file → line → kind → id (stable on ties).
  out.sort((a, b) =>
    (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
    (a.line - b.line) ||
    (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return out;
}
