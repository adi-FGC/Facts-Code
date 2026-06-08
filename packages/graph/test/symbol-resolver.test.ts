import { describe, expect, it } from 'vitest';
import { buildSymbolGraph } from '../src/symbol-resolver.js';
import type { FileOutline, Symbol as SymbolDecl } from '@factstack/spec';
import type { RawRef } from '@factstack/extractors';

/* Minimal fixtures — the resolver reads only path/declarations/imports, so we
   build partial outlines (the test runner doesn't type-check, and the resolver
   never validates the rest of the FileOutline shape). */
function decl(
  name: string,
  startLine: number,
  endLine: number,
  opts: { kind?: SymbolDecl['kind']; exported?: boolean; children?: SymbolDecl[] } = {},
): SymbolDecl {
  return {
    name,
    kind: opts.kind ?? 'function',
    startLine,
    endLine,
    exported: opts.exported ?? false,
    ...(opts.children ? { children: opts.children } : {}),
  } as SymbolDecl;
}
function imp(resolved: string, specifiers: string[]): FileOutline['imports'][number] {
  return { source: resolved, resolved, specifiers, isTypeOnly: false };
}
function outline(path: string, declarations: SymbolDecl[], imports: FileOutline['imports'] = []): FileOutline {
  return { path, declarations, imports } as unknown as FileOutline;
}
function ref(name: string, line: number, kind: RawRef['kind'] = 'call'): RawRef {
  return { name, line, kind, heuristic: false };
}

describe('buildSymbolGraph (F2)', () => {
  it('builds nodes from every declaration (flattening nested members)', () => {
    const a = outline('a.ts', [
      decl('Service', 1, 20, { kind: 'class', children: [decl('run', 5, 15, { kind: 'method' })] }),
    ]);
    const g = buildSymbolGraph([a], new Map());
    expect(g.symbolNodes.map((n) => n.id)).toEqual(['a.ts#Service@1', 'a.ts#run@5']);
  });

  it('same-file reference → extracted edge (no score)', () => {
    const a = outline('a.ts', [decl('caller', 1, 10), decl('helper', 12, 14)]);
    const g = buildSymbolGraph([a], new Map([['a.ts', [ref('helper', 5)]]]));
    expect(g.symbolEdges).toHaveLength(1);
    expect(g.symbolEdges[0]).toMatchObject({
      from: 'a.ts#caller@1',
      to: 'a.ts#helper@12',
      kind: 'call',
      confidence: 'extracted',
    });
    expect(g.symbolEdges[0]!.confidenceScore).toBeUndefined();
  });

  it('import-resolved reference → inferred 0.9', () => {
    const a = outline('a.ts', [decl('caller', 1, 10)], [imp('b.ts', ['target'])]);
    const b = outline('b.ts', [decl('target', 1, 5, { exported: true })]);
    const g = buildSymbolGraph([a, b], new Map([['a.ts', [ref('target', 5)]]]));
    expect(g.symbolEdges[0]).toMatchObject({
      from: 'a.ts#caller@1',
      to: 'b.ts#target@1',
      confidence: 'inferred',
      confidenceScore: 0.9,
    });
  });

  it('single cross-file match without an import → inferred 0.7', () => {
    const a = outline('a.ts', [decl('caller', 1, 10)]);
    const b = outline('b.ts', [decl('lonely', 1, 5)]);
    const g = buildSymbolGraph([a, b], new Map([['a.ts', [ref('lonely', 5)]]]));
    expect(g.symbolEdges[0]).toMatchObject({ to: 'b.ts#lonely@1', confidence: 'inferred', confidenceScore: 0.7 });
  });

  it('name in several other files → ambiguous 0.4, picks lowest id', () => {
    const a = outline('a.ts', [decl('caller', 1, 10)]);
    const b = outline('b.ts', [decl('dup', 1, 5)]);
    const c = outline('c.ts', [decl('dup', 1, 5)]);
    const g = buildSymbolGraph([a, b, c], new Map([['a.ts', [ref('dup', 5)]]]));
    expect(g.symbolEdges[0]).toMatchObject({ to: 'b.ts#dup@1', confidence: 'ambiguous', confidenceScore: 0.4 });
  });

  it('attributes a ref to the innermost enclosing declaration', () => {
    const a = outline('a.ts', [
      decl('Service', 1, 20, { kind: 'class', children: [decl('run', 5, 15, { kind: 'method' })] }),
      decl('helper', 22, 24),
    ]);
    const g = buildSymbolGraph([a], new Map([['a.ts', [ref('helper', 10)]]]));
    expect(g.symbolEdges[0]!.from).toBe('a.ts#run@5'); // method, not the enclosing class
  });

  it('drops a module-level ref with no enclosing declaration (honest v1 gap)', () => {
    const a = outline('a.ts', [decl('helper', 5, 8)]);
    const g = buildSymbolGraph([a], new Map([['a.ts', [ref('helper', 1)]]]));
    expect(g.symbolEdges).toHaveLength(0);
  });

  it('dedups same from→to→kind into one edge', () => {
    const a = outline('a.ts', [decl('caller', 1, 10), decl('helper', 12, 14)]);
    const g = buildSymbolGraph([a], new Map([['a.ts', [ref('helper', 5), ref('helper', 6)]]]));
    expect(g.symbolEdges).toHaveLength(1);
  });

  it('is deterministic — two runs are byte-identical', () => {
    const a = outline('a.ts', [decl('c', 1, 10)], [imp('b.ts', ['t'])]);
    const b = outline('b.ts', [decl('t', 1, 5, { exported: true })]);
    const refs = new Map([['a.ts', [ref('t', 5), ref('t', 6, 'read')]]]);
    expect(JSON.stringify(buildSymbolGraph([a, b], refs))).toBe(JSON.stringify(buildSymbolGraph([a, b], refs)));
  });
});
