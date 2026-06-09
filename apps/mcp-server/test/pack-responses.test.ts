import { describe, expect, it } from 'vitest';
import { decode, type DecodedTable } from '@factstack/factspack';
import { getOutlineToPack, subgraphToPack, verbResultNodes, type SubgraphLike } from '../src/pack-responses.js';
import type { AgentArtifact, SymbolNode, SymbolEdge } from '@factstack/spec';
import type { QueryResult } from '@factstack/core';
import type { ExtractedSymbol } from '@factstack/extractors';

/**
 * Unit coverage for the pure FactsPack converters in `src/pack-responses.ts`.
 *
 * These helpers turn MCP tool results into PACK strings. The end-to-end path
 * (analyze → tool → pack) is exercised by throwaway tsx scripts; here we pin
 * the *shape contract* of two converters that are easy to break silently:
 *
 *   - `getOutlineToPack`  → outline-v2: a `declarations` table AND a `refs`
 *                           table, always (the two-table shape is stable so no
 *                           caller branches on `--symbols`).
 *   - `subgraphToPack`    → subgraph-v1: `nodes` + `edges` + `citations` + a
 *                           1-row `meta` carrying the truncation marker.
 *
 * We assert by DECODING the produced pack with `@factstack/factspack`'s
 * `decode()` and inspecting the tables — round-tripping through the real wire
 * format proves the column order, interning, and null-handling all line up.
 *
 * Pure: no analyze run. Fixtures are hand-built the same way
 * `packages/core/test/query-engine.test.ts` builds its `mixed` artifact.
 */

const SNAP = '2026-06-09T00:00:00Z';

// ── fixture builders (mirroring query-engine.test.ts) ───────────────────────

function sym(
  id: string,
  path: string,
  name: string,
  kind: SymbolNode['kind'],
  start: number,
  end = start,
): SymbolNode {
  return { id, path, name, kind, startLine: start, endLine: end, exported: true };
}

function sedge(
  from: string,
  to: string,
  kind: SymbolEdge['kind'],
  confidence: SymbolEdge['confidence'] = 'extracted',
): SymbolEdge {
  return { from, to, kind, confidence };
}

function fileNode(path: string) {
  return { id: path, path, language: 'typescript', loc: 10, tokenCost: 50, status: 'ok' as const };
}

function makeArtifact(graph: Partial<AgentArtifact['graph']>): AgentArtifact {
  return {
    $schema: 'https://factstack.dev/schema/agent.v1.json',
    factsVersion: '0.1.0',
    generatedAt: SNAP,
    project: { name: 't', root: '/t', languages: [], frameworks: [], entryPoints: [], monorepo: null },
    files: [],
    graph: { nodes: [], edges: [], cycles: [], symbolNodes: [], symbolEdges: [], ...graph },
    routes: [],
    scripts: {},
    capabilities: [],
    risks: [],
    stats: { loc: 0, fileCount: 0, packageCount: 0, totalTokenCost: 0 },
  } as AgentArtifact;
}

/** Pull a decoded table by name, failing loudly if the converter dropped it. */
function table(pack: string, name: string): DecodedTable {
  const decoded = decode(pack);
  const t = decoded.tables.get(name);
  if (!t) throw new Error(`expected table '${name}', got [${[...decoded.tables.keys()].join(', ')}]`);
  return t;
}

// ── outline-v2 ──────────────────────────────────────────────────────────────

describe('getOutlineToPack → outline-v2', () => {
  // One top-level class with a child method (exercises the `parent` column),
  // plus two symbol-graph edges that should land in the `refs` table.
  const symbols: ExtractedSymbol[] = [
    {
      name: 'Widget',
      kind: 'class',
      startLine: 1,
      endLine: 20,
      exported: true,
      children: [{ name: 'render', kind: 'method', startLine: 5, endLine: 9, exported: false }],
    },
    { name: 'helper', kind: 'function', startLine: 22, endLine: 25, exported: false },
  ];
  const refs: SymbolEdge[] = [
    sedge('src/widget.ts#render@5', 'src/widget.ts#helper@22', 'call', 'inferred'),
    sedge('src/widget.ts#Widget@1', 'src/base.ts#Base@1', 'extends', 'extracted'),
  ];

  const pack = getOutlineToPack('src/widget.ts', symbols, SNAP, refs);

  it('pins the outline-v2 schema in the header', () => {
    expect(decode(pack).header.schema).toBe('outline-v2');
  });

  it('emits BOTH a declarations and a refs table', () => {
    const names = [...decode(pack).tables.keys()];
    expect(names).toContain('declarations');
    expect(names).toContain('refs');
  });

  it('flattens children into rows with a parent pointer; top-level parent is null', () => {
    const rows = table(pack, 'declarations').rows;
    // cols: id, name, kind, start, end, exp, parent
    expect(rows).toHaveLength(3); // Widget, render (child), helper
    const widget = rows.find((r) => r[1] === 'Widget')!;
    const render = rows.find((r) => r[1] === 'render')!;
    const helper = rows.find((r) => r[1] === 'helper')!;

    expect(widget[6]).toBeNull(); // top-level → null parent
    expect(widget[5]).toBe('1'); // exported flag
    expect(render[6]).toBe('Widget'); // child points at parent symbol
    expect(render[2]).toBe('method');
    expect(render[5]).toBe('0'); // not exported
    expect(helper[6]).toBeNull();
    expect([helper[3], helper[4]]).toEqual(['22', '25']); // start/end preserved
  });

  it('refs row carries from/to/kind/conf (S/T resolve back to full symbol ids)', () => {
    const rows = table(pack, 'refs').rows;
    // cols: id, S(from), T(to), kind, conf
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(['0', 'src/widget.ts#render@5', 'src/widget.ts#helper@22', 'call', 'inferred']);
    expect(rows[1]).toEqual(['1', 'src/widget.ts#Widget@1', 'src/base.ts#Base@1', 'extends', 'extracted']);
  });

  it('still emits an EMPTY refs table when no symbol edges were resolved', () => {
    // refs defaults to [] — the two-table shape must stay stable so callers
    // never branch on whether analysis ran with `--symbols`.
    const noRefs = getOutlineToPack('src/widget.ts', symbols, SNAP);
    expect([...decode(noRefs).tables.keys()]).toContain('refs');
    expect(table(noRefs, 'refs').rows).toHaveLength(0);
  });
});

// ── subgraph-v1 ───────────────────────────────────────────────────────────

describe('subgraphToPack → subgraph-v1', () => {
  // A file node + two symbol nodes layered on it. useHelper → helper (call).
  const agent = makeArtifact({
    nodes: [fileNode('src/a.ts')],
    symbolNodes: [
      sym('src/a.ts#helper@3', 'src/a.ts', 'helper', 'function', 3, 8),
      sym('src/a.ts#useHelper@1', 'src/a.ts', 'useHelper', 'function', 1, 2),
    ],
  });

  const baseResult: SubgraphLike = {
    nodes: ['src/a.ts#helper@3', 'src/a.ts'],
    edges: [{ from: 'src/a.ts#useHelper@1', to: 'src/a.ts#helper@3', kind: 'call', confidence: 'inferred' }],
    truncated: false,
  };

  const pack = subgraphToPack(agent, baseResult, SNAP);

  it('emits all four tables: nodes, edges, citations, meta', () => {
    const names = [...decode(pack).tables.keys()];
    expect(names).toEqual(expect.arrayContaining(['nodes', 'edges', 'citations', 'meta']));
  });

  it('nodes table recovers path/kind/name from the artifact, keyed by id', () => {
    const rows = table(pack, 'nodes').rows;
    // cols: id, node, F(path), kind, name
    const helper = rows.find((r) => r[1] === 'src/a.ts#helper@3')!;
    expect(helper.slice(2)).toEqual(['src/a.ts', 'function', 'helper']);
    const file = rows.find((r) => r[1] === 'src/a.ts')!;
    expect(file.slice(2)).toEqual(['src/a.ts', 'file', 'a.ts']);
  });

  it('edges table carries the traversed edge with S/T resolved to ids', () => {
    const rows = table(pack, 'edges').rows;
    // cols: id, S(from), T(to), kind, conf
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(['0', 'src/a.ts#useHelper@1', 'src/a.ts#helper@3', 'call', 'inferred']);
  });

  it('citations give a file:line#sym anchor for a symbol node', () => {
    const rows = table(pack, 'citations').rows;
    // cols: id, F(file), line, sym
    const symCite = rows.find((r) => r[3] === 'helper')!;
    expect(citationAnchor(symCite)).toBe('src/a.ts:3#helper');
    // A file node has no line/sym → the anchor degrades to the bare path.
    const fileCite = rows.find((r) => r[1] === 'src/a.ts' && r[3] === null)!;
    expect(fileCite[2]).toBeNull();
    expect(citationAnchor(fileCite)).toBe('src/a.ts');
  });

  it('meta is a single row; truncated flag is 0 when not capped', () => {
    const rows = table(pack, 'meta').rows;
    expect(rows).toHaveLength(1);
    // cols: truncated, nodes, edges
    expect(rows[0]).toEqual(['0', '2', '1']);
  });

  it('meta truncated flag flips to 1 when the result was capped', () => {
    const cappedPack = subgraphToPack(agent, { ...baseResult, truncated: true }, SNAP);
    const metaRow = table(cappedPack, 'meta').rows[0]!;
    expect(metaRow[0]).toBe('1'); // no silent cap — truncation is visible
    expect(metaRow.slice(1)).toEqual(['2', '1']); // counts unchanged
  });
});

/**
 * Reconstruct the `file:line#sym` citation anchor an agent would render from a
 * decoded `citations` row (cols: id, F, line, sym).
 *
 * The null-handling here is a deliberate policy choice: degrade gracefully —
 * drop `:line` when there's no line, drop `#sym` when it's a file node — rather
 * than emitting `src/a.ts:#` for a bare file. Adjust if a stricter anchor format
 * is wanted downstream.
 */
function citationAnchor(row: (string | null)[]): string {
  const [, file, line, symName] = row;
  let anchor = file ?? '';
  if (line != null) anchor += `:${line}`;
  if (symName != null) anchor += `#${symName}`;
  return anchor;
}

/**
 * verbResultNodes — lifts a legacy-verb QueryResult into a flat node list for
 * the F3 `query` tool. The trap: `cycles` returns string[][], so a naive
 * string-filter silently drops every element (an empty subgraph for a real
 * "circular dependencies?" question). Regression guard for that bug.
 */
describe('verbResultNodes', () => {
  it('flattens + dedups + sorts cycles (string[][])', () => {
    const r = { verb: 'cycles', count: 2, results: [['b.ts', 'a.ts'], ['a.ts', 'c.ts']] } as unknown as QueryResult;
    expect(verbResultNodes(r)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('passes through a flat string list (orphans / path-between)', () => {
    const r = { verb: 'orphans', count: 2, results: ['x.ts', 'y.ts'] } as unknown as QueryResult;
    expect(verbResultNodes(r)).toEqual(['x.ts', 'y.ts']);
  });

  it('is empty-safe for a non-array result', () => {
    const r = { verb: 'orphans', count: 0, results: undefined } as unknown as QueryResult;
    expect(verbResultNodes(r)).toEqual([]);
  });
});
