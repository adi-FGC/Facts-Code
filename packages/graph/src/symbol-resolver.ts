/**
 * @factstack/graph — symbol-level graph builder (F2, "symbols-refs phase 2").
 *
 * Phase 1 (`@factstack/extractors` `extractSymbolRefs`) emits per-file,
 * SAME-FILE identifier references. This module is phase 2: it joins those
 * refs against the cross-file import graph + every file's declarations to
 * produce a SYMBOL graph — declarations as nodes, references as edges —
 * each edge tagged with F1 `confidence`:
 *
 *   - same-file declaration of the ref name        → `extracted`
 *   - resolved through an import (`./m` → target)   → `inferred`   (0.9)
 *   - a single top-level decl in one other file     → `inferred`   (0.7)
 *   - the name exists in several other files         → `ambiguous`  (0.4)
 *
 * Pure / isomorphic (INV1) and deterministic (INV2): all candidate lists are
 * id-sorted, the enclosing `from` is the innermost span, ambiguous resolution
 * always picks the lowest-id candidate, and the output is sorted on stable
 * keys. Two runs over the same inputs produce byte-identical output.
 *
 * Known v1 gaps (honest, not silent): a ref outside any declaration (module
 * top-level code) has no `from` symbol and is dropped; default/namespace
 * imports (`import X`, `import * as X`) resolve only via the global-name
 * fallback, not the import edge; dynamic dispatch is never inferred.
 */

import type {
  FileOutline,
  Symbol as SymbolDecl,
  SymbolNode,
  SymbolEdge,
  Confidence,
} from '@factstack/spec';
import { symbolId } from '@factstack/spec';
import type { RawRef } from '@factstack/extractors';

export interface SymbolGraph {
  symbolNodes: SymbolNode[];
  symbolEdges: SymbolEdge[];
}

/** Confidence precedence for edge dedup (higher wins). */
function rank(c: Confidence): number {
  return c === 'extracted' ? 3 : c === 'inferred' ? 2 : 1;
}

/** Flatten a file's declaration tree (incl. nested methods/members) into
 *  graph nodes. Each carries its source span so refs can be attributed to the
 *  innermost enclosing declaration. */
function flattenDecls(path: string, decls: readonly SymbolDecl[]): SymbolNode[] {
  const out: SymbolNode[] = [];
  const walk = (syms: readonly SymbolDecl[]): void => {
    for (const s of syms) {
      out.push({
        id: symbolId(path, s.name, s.startLine),
        path,
        name: s.name,
        kind: s.kind,
        startLine: s.startLine,
        endLine: s.endLine,
        exported: s.exported,
      });
      if (s.children && s.children.length) walk(s.children);
    }
  };
  walk(decls);
  return out;
}

/** The innermost declaration whose span contains `line` (smallest span;
 *  deeper-nested wins). Returns undefined for a line outside every decl. */
function enclosing(nodes: readonly SymbolNode[], line: number): SymbolNode | undefined {
  let best: SymbolNode | undefined;
  for (const n of nodes) {
    if (line < n.startLine || line > n.endLine) continue;
    if (!best) {
      best = n;
      continue;
    }
    const span = n.endLine - n.startLine;
    const bestSpan = best.endLine - best.startLine;
    if (span < bestSpan || (span === bestSpan && n.startLine > best.startLine)) best = n;
  }
  return best;
}

const byIdAsc = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Path-shape predicate for "this is test/fixture code, not application code."
 *  Inlined to keep @factstack/graph dependency-free (mirrors the helper in
 *  core's query engine). Artifact paths are already POSIX-normalized by the
 *  analyzer, so no backslash handling is needed here. */
function isTestPath(p: string): boolean {
  const n = p.toLowerCase();
  if (
    /(?:^|\/)(?:__tests__|__test__|tests|test|cypress|e2e|playwright|examples|fixtures)\//.test(n)
  )
    return true;
  return /\.(test|spec)\.[a-z]+$/.test(n);
}

/**
 * Build the symbol graph from file outlines + per-file references.
 *
 * @param outlines   every analyzed file (declarations + imports).
 * @param refsByFile path → identifier references in that file (from
 *                   `extractSymbolRefs`). Files absent from the map contribute
 *                   nodes but no outgoing edges.
 */
export function buildSymbolGraph(
  outlines: readonly FileOutline[],
  refsByFile: ReadonlyMap<string, readonly RawRef[]>,
): SymbolGraph {
  // 1. Nodes + indexes -----------------------------------------------------
  const allNodes: SymbolNode[] = [];
  const nodesByFile = new Map<string, SymbolNode[]>();
  for (const o of outlines) {
    const flat = flattenDecls(o.path, o.declarations);
    nodesByFile.set(o.path, flat);
    for (const n of flat) allNodes.push(n);
  }

  // Global name → nodes, sorted by id so candidate selection is deterministic.
  const byName = new Map<string, SymbolNode[]>();
  for (const n of allNodes) {
    const arr = byName.get(n.name);
    if (arr) arr.push(n);
    else byName.set(n.name, [n]);
  }
  for (const arr of byName.values()) arr.sort(byIdAsc);

  // Per-file name → nodes (same-file resolution), earliest declaration first.
  const fileNameIndex = new Map<string, Map<string, SymbolNode[]>>();
  for (const [path, nodes] of nodesByFile) {
    const m = new Map<string, SymbolNode[]>();
    for (const n of nodes) {
      const a = m.get(n.name);
      if (a) a.push(n);
      else m.set(n.name, [n]);
    }
    for (const a of m.values())
      a.sort((x, y) => x.startLine - y.startLine || (x.id < y.id ? -1 : 1));
    fileNameIndex.set(path, m);
  }

  // Per-file imported-name → resolved target file.
  const importTargetByFile = new Map<string, Map<string, string>>();
  for (const o of outlines) {
    const m = new Map<string, string>();
    for (const imp of o.imports) {
      if (!imp.resolved) continue;
      for (const spec of imp.specifiers) if (!m.has(spec)) m.set(spec, imp.resolved);
    }
    importTargetByFile.set(o.path, m);
  }

  // 2. Resolve refs → edges (dedup by from|to|kind, keep the strongest) ----
  const edges = new Map<string, SymbolEdge>();
  const weight = (e: SymbolEdge): number =>
    rank(e.confidence) * 100 + Math.round((e.confidenceScore ?? 1) * 100);

  for (const o of outlines) {
    const refs = refsByFile.get(o.path);
    if (!refs || refs.length === 0) continue;
    const localNodes = nodesByFile.get(o.path) ?? [];
    const localByName = fileNameIndex.get(o.path);
    const importTargets = importTargetByFile.get(o.path);

    for (const ref of refs) {
      const from = enclosing(localNodes, ref.line);
      if (!from) continue; // module-level ref → no symbol-to-symbol edge (v1 gap)

      let to: SymbolNode | undefined;
      let confidence: Confidence = 'extracted';
      let score: number | undefined;

      const sameFile = localByName?.get(ref.name);
      if (sameFile && sameFile.length) {
        to = sameFile[0]; // earliest same-file decl of this name
        confidence = 'extracted';
      } else {
        const targetFile = importTargets?.get(ref.name);
        const viaImport = targetFile ? fileNameIndex.get(targetFile)?.get(ref.name) : undefined;
        if (viaImport && viaImport.length) {
          to = viaImport[0];
          confidence = 'inferred';
          score = 0.9;
        } else {
          // F2 precision: exclude test/fixture files from the name-collision
          // fallback. A source ref resolving into a test helper (e.g. a local
          // `node` var matching a `node()` fixture builder) is almost always a
          // false edge; genuine test↔test refs resolve via the import path
          // above, not this fallback.
          const others = (byName.get(ref.name) ?? []).filter(
            (c) => c.path !== o.path && !isTestPath(c.path),
          );
          if (others.length === 1) {
            to = others[0];
            confidence = 'inferred';
            score = 0.7;
          } else if (others.length > 1) {
            to = others[0];
            confidence = 'ambiguous';
            score = 0.4;
          }
        }
      }

      if (!to || to.id === from.id) continue; // unresolved or self-reference
      const edge: SymbolEdge =
        score != null
          ? { from: from.id, to: to.id, kind: ref.kind, confidence, confidenceScore: score }
          : { from: from.id, to: to.id, kind: ref.kind, confidence };
      const key = `${edge.from}\u0000${edge.to}\u0000${edge.kind}`;
      const prev = edges.get(key);
      if (!prev || weight(edge) > weight(prev)) edges.set(key, edge);
    }
  }

  const symbolNodes = [...allNodes].sort(byIdAsc);
  const symbolEdges = [...edges.values()].sort(
    (a, b) =>
      (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) ||
      (a.to < b.to ? -1 : a.to > b.to ? 1 : 0) ||
      (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
  );
  return { symbolNodes, symbolEdges };
}
