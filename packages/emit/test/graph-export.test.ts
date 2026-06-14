import { describe, expect, it } from 'vitest';
import { toGraphML, toJsonGraph, exportGraph, graphExportFilename } from '../src/graph-export.js';
import type { AgentArtifact } from '@factstack/spec';

/* Loose fixtures — the serializers read only graph + project.name + generatedAt;
   the runner doesn't type-check, so partial nodes/edges are fine. */
function makeAgent(overrides: Record<string, unknown> = {}): AgentArtifact {
  return {
    generatedAt: '2026-05-01T00:00:00Z',
    project: { name: 'demo' },
    graph: {
      nodes: [
        { id: 'a.ts', path: 'a.ts', language: 'typescript' },
        { id: 'b.ts', path: 'b.ts', language: 'typescript' },
      ],
      edges: [{ from: 'a.ts', to: 'b.ts', kind: 'import', confidence: 'extracted' }],
      cycles: [],
      symbolNodes: [{ id: 'a.ts#foo@1', path: 'a.ts', name: 'foo', kind: 'function', startLine: 1, endLine: 5, exported: true }],
      symbolEdges: [{ from: 'a.ts#foo@1', to: 'b.ts#bar@1', kind: 'call', confidence: 'inferred', confidenceScore: 0.9 }],
    },
    ...overrides,
  } as unknown as AgentArtifact;
}

describe('graph export (F14)', () => {
  it('json-graph round-trips node + edge counts (file + symbol levels)', () => {
    const doc = JSON.parse(toJsonGraph(makeAgent()));
    expect(doc.graph.metadata.nodeCount).toBe(3); // 2 file + 1 symbol
    expect(doc.graph.metadata.edgeCount).toBe(2); // 1 file + 1 symbol
    expect(Object.keys(doc.graph.nodes)).toHaveLength(3);
    expect(doc.graph.edges).toHaveLength(2);
    expect(doc.graph.directed).toBe(true);
    expect(doc.graph.label).toBe('demo');
    const sym = doc.graph.edges.find((e: { source: string }) => e.source === 'a.ts#foo@1');
    expect(sym).toMatchObject({ target: 'b.ts#bar@1', relation: 'call', metadata: { confidence: 'inferred' } });
  });

  it('graphml round-trips node + edge counts', () => {
    const xml = toGraphML(makeAgent());
    expect((xml.match(/<node /g) || [])).toHaveLength(3);
    expect((xml.match(/<edge /g) || [])).toHaveLength(2);
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(xml).toContain('edgedefault="directed"');
    expect(xml).toContain('<data key="ekind">import</data>');
  });

  it('escapes XML special chars in ids/labels', () => {
    const a = makeAgent({ graph: { nodes: [{ id: 'a&b<c>.ts', path: 'a&b<c>.ts', language: 'ts' }], edges: [], cycles: [], symbolNodes: [], symbolEdges: [] } });
    const xml = toGraphML(a);
    expect(xml).toContain('id="a&amp;b&lt;c&gt;.ts"');
    expect(xml).not.toContain('<c>.ts');
  });

  it('is deterministic — two exports are byte-identical', () => {
    const a = makeAgent();
    expect(toGraphML(a)).toBe(toGraphML(a));
    expect(toJsonGraph(a)).toBe(toJsonGraph(a));
  });

  it('degrades to the file graph when no symbols are present', () => {
    const a = makeAgent({ graph: { nodes: [{ id: 'a.ts', path: 'a.ts', language: 'ts' }], edges: [], cycles: [], symbolNodes: [], symbolEdges: [] } });
    const doc = JSON.parse(toJsonGraph(a));
    expect(doc.graph.metadata.nodeCount).toBe(1);
    expect(doc.graph.metadata.edgeCount).toBe(0);
  });

  it('exportGraph dispatches on format + provides filenames', () => {
    expect(exportGraph(makeAgent(), 'graphml').startsWith('<?xml')).toBe(true);
    expect(JSON.parse(exportGraph(makeAgent(), 'json-graph')).graph).toBeDefined();
    expect(graphExportFilename('graphml')).toBe('factstack-graph.graphml');
    expect(graphExportFilename('json-graph')).toBe('factstack-graph.json');
  });
});
