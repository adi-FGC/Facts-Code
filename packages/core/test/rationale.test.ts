import { describe, expect, it } from 'vitest';
import { buildRationale } from '../src/rationale.js';
import type { FileOutline, Symbol as SymbolDecl, SymbolNode } from '@factstack/spec';

/* Loose fixtures — buildRationale only reads path/todos/declarations + symbol
   node spans; the test runner doesn't type-check, so partials are fine. */
function todo(kind: 'TODO' | 'FIXME' | 'HACK' | 'XXX' | 'NOTE', text: string, line: number) {
  return { kind, text, line, authoredAt: null };
}
function decl(name: string, startLine: number, endLine: number, docstring?: string): SymbolDecl {
  return { name, kind: 'function', startLine, endLine, exported: false, ...(docstring ? { docstring } : {}) } as SymbolDecl;
}
function outline(path: string, todos: ReturnType<typeof todo>[], declarations: SymbolDecl[] = []): FileOutline {
  return { path, todos, declarations } as unknown as FileOutline;
}
function snode(path: string, name: string, startLine: number, endLine: number): SymbolNode {
  return { id: `${path}#${name}@${startLine}`, path, name, kind: 'function', startLine, endLine, exported: false };
}

describe('buildRationale (F10)', () => {
  it('links a comment to its innermost enclosing symbol', () => {
    const r = buildRationale([outline('a.ts', [todo('NOTE', 'why we cache here', 5)])], [snode('a.ts', 'cache', 1, 10)]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ symbol: 'a.ts#cache@1', kind: 'note', line: 5, text: 'why we cache here', file: 'a.ts' });
    expect(r[0]!.id).toBe('a.ts@5#note');
  });

  it('attaches a module-level comment at file level (symbol: null)', () => {
    const r = buildRationale([outline('a.ts', [todo('TODO', 'top of file', 1)])], [snode('a.ts', 'cache', 5, 10)]);
    expect(r[0]!.symbol).toBeNull();
    expect(r[0]!.kind).toBe('todo');
  });

  it('picks the innermost symbol when nested (method over enclosing class)', () => {
    const r = buildRationale(
      [outline('a.ts', [todo('HACK', 'workaround', 7)])],
      [snode('a.ts', 'Service', 1, 20), snode('a.ts', 'run', 5, 15)],
    );
    expect(r[0]!.symbol).toBe('a.ts#run@5');
  });

  it('links a docstring to its own declaration symbol id', () => {
    const r = buildRationale([outline('a.ts', [], [decl('greet', 3, 8, 'Greets the user politely.')])], [snode('a.ts', 'greet', 3, 8)]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ symbol: 'a.ts#greet@3', kind: 'docstring', line: 3, text: 'Greets the user politely.' });
  });

  it('walks nested declarations for docstrings (class + method)', () => {
    const cls = { name: 'Service', kind: 'class', startLine: 1, endLine: 20, exported: true, docstring: 'A service.', children: [decl('run', 5, 10, 'Runs it.')] } as unknown as SymbolDecl;
    const r = buildRationale([outline('a.ts', [], [cls])], []);
    expect(r.map((x) => x.symbol)).toEqual(expect.arrayContaining(['a.ts#Service@1', 'a.ts#run@5']));
    expect(r.map((x) => x.text)).toEqual(expect.arrayContaining(['A service.', 'Runs it.']));
  });

  it('works at file level without a symbol graph (symbolNodes empty)', () => {
    const r = buildRationale([outline('a.ts', [todo('FIXME', 'broken', 4)])]);
    expect(r[0]!.symbol).toBeNull();
    expect(r[0]!.kind).toBe('fixme');
  });

  it('caps long text with an ellipsis', () => {
    const r = buildRationale([outline('a.ts', [todo('NOTE', 'x'.repeat(500), 2)])], [snode('a.ts', 'fn', 1, 5)]);
    expect(r[0]!.text.length).toBeLessThanOrEqual(280);
    expect(r[0]!.text.endsWith('…')).toBe(true);
  });

  it('is deterministic + stably ordered by file, line, kind', () => {
    const f1 = outline('b.ts', [todo('NOTE', 'n', 9)]);
    const f2 = outline('a.ts', [todo('TODO', 't', 3), todo('NOTE', 'm', 1)]);
    const r = buildRationale([f1, f2], []);
    expect(r.map((x) => `${x.file}:${x.line}`)).toEqual(['a.ts:1', 'a.ts:3', 'b.ts:9']);
    expect(JSON.stringify(buildRationale([f1, f2], []))).toBe(JSON.stringify(r));
  });
});
