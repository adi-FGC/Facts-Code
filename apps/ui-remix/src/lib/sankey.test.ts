import { describe, expect, it } from 'vitest';
import { computeSankey, type SankeyNodeInput, type SankeyLinkInput } from './sankey.ts';

const opts = { width: 300, height: 200, nodeWidth: 10, nodePadding: 10 };

describe('computeSankey', () => {
  it('places a simple a->b flow in two columns', () => {
    const nodes: SankeyNodeInput[] = [
      { id: 'a', label: 'A', column: 0 },
      { id: 'b', label: 'B', column: 1 },
    ];
    const links: SankeyLinkInput[] = [{ source: 'a', target: 'b', value: 10 }];
    const out = computeSankey(nodes, links, opts);
    expect(out.nodes).toHaveLength(2);
    expect(out.links).toHaveLength(1);
    const a = out.nodes.find((n) => n.id === 'a')!;
    const b = out.nodes.find((n) => n.id === 'b')!;
    expect(a.x).toBe(0);
    expect(b.x).toBe(opts.width - opts.nodeWidth); // last column hugs the right edge
    expect(out.links[0]!.width).toBeGreaterThan(0);
    expect(out.links[0]!.path).toMatch(/^M[\d.]+,[\d.]+ C/); // cubic bezier
    expect(a.value).toBe(10); // throughput = outflow
    expect(b.value).toBe(10); // throughput = inflow
  });

  it('drops zero-value and self links, and nodes carrying no flow', () => {
    const nodes: SankeyNodeInput[] = [
      { id: 'a', label: 'A', column: 0 },
      { id: 'b', label: 'B', column: 1 },
      { id: 'orphan', label: 'O', column: 1 },
    ];
    const links: SankeyLinkInput[] = [
      { source: 'a', target: 'b', value: 5 },
      { source: 'a', target: 'b', value: 0 }, // zero -> dropped
      { source: 'a', target: 'a', value: 3 }, // self -> dropped
    ];
    const out = computeSankey(nodes, links, opts);
    expect(out.nodes.map((n) => n.id).sort()).toEqual(['a', 'b']); // orphan carries no flow
    expect(out.links).toHaveLength(1);
  });

  it('stacks multiple targets and conserves ribbon widths against node height', () => {
    const nodes: SankeyNodeInput[] = [
      { id: 'src', label: 'S', column: 0 },
      { id: 't1', label: 'T1', column: 1 },
      { id: 't2', label: 'T2', column: 1 },
    ];
    const links: SankeyLinkInput[] = [
      { source: 'src', target: 't1', value: 6 },
      { source: 'src', target: 't2', value: 4 },
    ];
    const out = computeSankey(nodes, links, opts);
    const src = out.nodes.find((n) => n.id === 'src')!;
    expect(src.value).toBe(10);
    // the two outgoing ribbons sum (within rounding) to the source node height
    const ribbonSum = out.links.reduce((s, l) => s + l.width, 0);
    expect(Math.abs(ribbonSum - src.height)).toBeLessThan(0.01);
  });

  it('is deterministic across runs', () => {
    const nodes: SankeyNodeInput[] = [
      { id: 'a', label: 'A', column: 0 },
      { id: 'b', label: 'B', column: 0 },
      { id: 'c', label: 'C', column: 1 },
    ];
    const links: SankeyLinkInput[] = [
      { source: 'a', target: 'c', value: 7 },
      { source: 'b', target: 'c', value: 3 },
    ];
    const a = computeSankey(nodes, links, opts);
    const b = computeSankey(nodes, links, opts);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('lets a link colour override the source node colour', () => {
    const nodes: SankeyNodeInput[] = [
      { id: 'a', label: 'A', column: 0, color: 'red' },
      { id: 'b', label: 'B', column: 1 },
      { id: 'c', label: 'C', column: 1 },
    ];
    const links: SankeyLinkInput[] = [
      { source: 'a', target: 'b', value: 5, color: 'blue' },
      { source: 'a', target: 'c', value: 5 }, // no override → inherits source 'red'
    ];
    const out = computeSankey(nodes, links, opts);
    expect(out.links.find((l) => l.target === 'b')!.color).toBe('blue');
    expect(out.links.find((l) => l.target === 'c')!.color).toBe('red');
  });

  it('returns an empty layout when there is no flow', () => {
    const out = computeSankey(
      [{ id: 'a', label: 'A', column: 0 }],
      [],
      opts,
    );
    expect(out.nodes).toEqual([]);
    expect(out.links).toEqual([]);
  });

  it('handles a 3-column chain', () => {
    const nodes: SankeyNodeInput[] = [
      { id: 'a', label: 'A', column: 0 },
      { id: 'b', label: 'B', column: 1 },
      { id: 'c', label: 'C', column: 2 },
    ];
    const links: SankeyLinkInput[] = [
      { source: 'a', target: 'b', value: 4 },
      { source: 'b', target: 'c', value: 4 },
    ];
    const out = computeSankey(nodes, links, opts);
    const xs = [...new Set(out.nodes.map((n) => n.x))].sort((x, y) => x - y);
    expect(xs).toHaveLength(3); // three distinct columns
    expect(xs[0]).toBe(0);
    expect(xs[2]).toBe(opts.width - opts.nodeWidth);
  });
});
