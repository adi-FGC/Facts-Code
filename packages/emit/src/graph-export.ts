/**
 * F14 — graph export. Pure serializers that take the FACTS graph
 * (`AgentArtifact.graph`: file-level import graph + F2 symbol graph) into
 * external graph tooling formats:
 *   - GraphML       (XML; Gephi, yEd, Cytoscape, igraph, …)
 *   - JSON Graph    (https://github.com/jsongraph/json-graph-specification)
 *
 * Pure / isomorphic (no node:*), deterministic (INV2): nodes sorted by id,
 * edges by (source,target,kind) — same artifact ⇒ byte-identical output, so a
 * diff of two exports is meaningful. Both graph levels are emitted in one
 * graph; a `level` attribute ("file" | "symbol") distinguishes them, and the
 * two id-spaces never collide (file id = path; symbol id = `path#name@line`).
 * When analysis ran without `--symbols`, the symbol arrays are empty and the
 * export is simply the file dependency graph.
 */

import type { AgentArtifact } from '@factstack/spec';

export type GraphExportFormat = 'graphml' | 'json-graph';

interface ExpNode {
  id: string;
  label: string;
  kind: string;
  level: 'file' | 'symbol';
}
interface ExpEdge {
  source: string;
  target: string;
  kind: string;
  confidence: string | undefined;
}

/** Flatten both graph levels into a single, deterministically-ordered set of
 *  nodes + edges. File and symbol id-spaces are disjoint by construction. */
function collect(agent: AgentArtifact): { nodes: ExpNode[]; edges: ExpEdge[] } {
  const g = agent.graph;
  const nodes: ExpNode[] = [];
  const edges: ExpEdge[] = [];

  for (const n of g.nodes) {
    nodes.push({ id: n.id, label: n.path, kind: n.language || 'file', level: 'file' });
  }
  for (const e of g.edges) {
    edges.push({ source: e.from, target: e.to, kind: e.kind, confidence: e.confidence });
  }
  for (const n of g.symbolNodes ?? []) {
    nodes.push({ id: n.id, label: n.name, kind: n.kind, level: 'symbol' });
  }
  for (const e of g.symbolEdges ?? []) {
    edges.push({ source: e.from, target: e.to, kind: e.kind, confidence: e.confidence });
  }

  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  edges.sort(
    (a, b) =>
      (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) ||
      (a.target < b.target ? -1 : a.target > b.target ? 1 : 0) ||
      (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
  );
  return { nodes, edges };
}

function xmlEscape(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Serialize to GraphML (XML). */
export function toGraphML(agent: AgentArtifact): string {
  const { nodes, edges } = collect(agent);
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<graphml xmlns="http://graphml.graphdrawing.org/xmlns">');
  out.push('  <key id="label" for="node" attr.name="label" attr.type="string"/>');
  out.push('  <key id="kind" for="node" attr.name="kind" attr.type="string"/>');
  out.push('  <key id="level" for="node" attr.name="level" attr.type="string"/>');
  out.push('  <key id="ekind" for="edge" attr.name="kind" attr.type="string"/>');
  out.push('  <key id="conf" for="edge" attr.name="confidence" attr.type="string"/>');
  out.push(`  <graph id="${xmlEscape(agent.project.name)}" edgedefault="directed">`);
  for (const n of nodes) {
    out.push(`    <node id="${xmlEscape(n.id)}">`);
    out.push(`      <data key="label">${xmlEscape(n.label)}</data>`);
    out.push(`      <data key="kind">${xmlEscape(n.kind)}</data>`);
    out.push(`      <data key="level">${n.level}</data>`);
    out.push('    </node>');
  }
  edges.forEach((e, i) => {
    out.push(`    <edge id="e${i}" source="${xmlEscape(e.source)}" target="${xmlEscape(e.target)}">`);
    out.push(`      <data key="ekind">${xmlEscape(e.kind)}</data>`);
    if (e.confidence) out.push(`      <data key="conf">${xmlEscape(e.confidence)}</data>`);
    out.push('    </edge>');
  });
  out.push('  </graph>');
  out.push('</graphml>');
  return out.join('\n') + '\n';
}

/** Serialize to JSON Graph Format. */
export function toJsonGraph(agent: AgentArtifact): string {
  const { nodes, edges } = collect(agent);
  const doc = {
    graph: {
      directed: true,
      label: agent.project.name,
      metadata: {
        generator: 'factstack',
        generatedAt: agent.generatedAt,
        nodeCount: nodes.length,
        edgeCount: edges.length,
      },
      nodes: Object.fromEntries(
        nodes.map((n) => [n.id, { label: n.label, metadata: { kind: n.kind, level: n.level } }]),
      ),
      edges: edges.map((e) => ({
        source: e.source,
        target: e.target,
        relation: e.kind,
        ...(e.confidence ? { metadata: { confidence: e.confidence } } : {}),
      })),
    },
  };
  return JSON.stringify(doc, null, 2) + '\n';
}

/** Dispatch on format. */
export function exportGraph(agent: AgentArtifact, format: GraphExportFormat): string {
  return format === 'graphml' ? toGraphML(agent) : toJsonGraph(agent);
}

/** Default filename (sans dir) for a given format. */
export function graphExportFilename(format: GraphExportFormat): string {
  return format === 'graphml' ? 'factstack-graph.graphml' : 'factstack-graph.json';
}
