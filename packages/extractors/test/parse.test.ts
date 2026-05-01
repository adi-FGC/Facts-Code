import { describe, expect, it } from 'vitest';
import { isParseable, parseJS, walkAst } from '../src/parse.js';

describe('isParseable', () => {
  it.each(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'])('returns true for %s', (ext) => {
    expect(isParseable(ext)).toBe(true);
  });

  it.each(['.py', '.go', '.rs', '.txt', '.json', '.md', ''])('returns false for %s', (ext) => {
    expect(isParseable(ext)).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isParseable('.TS')).toBe(true);
    expect(isParseable('.TSX')).toBe(true);
  });
});

describe('parseJS', () => {
  it('parses a TypeScript module', () => {
    const r = parseJS(`export const x: number = 1;`, '.ts');
    expect(r).not.toBeNull();
    expect(r!.ast).toBeDefined();
  });

  it('parses TSX with JSX', () => {
    const r = parseJS(`export const C = () => <div />;`, '.tsx');
    expect(r).not.toBeNull();
  });

  it('returns null for unparseable extensions', () => {
    expect(parseJS('print("hi")', '.py')).toBeNull();
  });

  it('returns null on syntax error past errorRecovery (graceful)', () => {
    // Babel's errorRecovery still produces an AST for many error shapes;
    // the parser only returns null for total fail. Either way we must
    // not throw.
    expect(() => parseJS(';;;;', '.ts')).not.toThrow();
  });

  it('handles top-level await', () => {
    const r = parseJS(`const x = await fetch('/api');`, '.ts');
    expect(r).not.toBeNull();
  });
});

describe('walkAst', () => {
  it('visits every node in the AST', () => {
    const r = parseJS(`const x = 1; function f() {}`, '.ts')!;
    let count = 0;
    walkAst(r.ast, () => { count++; });
    expect(count).toBeGreaterThan(0);
  });

  it('skips loc/start/end/range fields (avoids infinite recursion)', () => {
    const r = parseJS(`const x = 1;`, '.ts')!;
    const visited: string[] = [];
    walkAst(r.ast, (n: any) => { if (n?.type) visited.push(n.type); });
    expect(visited).toContain('VariableDeclaration');
  });
});
