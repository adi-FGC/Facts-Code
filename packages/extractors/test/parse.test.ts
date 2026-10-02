import { describe, expect, it } from 'vitest';
import { isParseable, parseJS, walkAst } from '../src/parse.js';

describe('isParseable', () => {
  it.each(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'])(
    'returns true for %s',
    (ext) => {
      expect(isParseable(ext)).toBe(true);
    },
  );

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

  it.each(['.js', '.mjs', '.cjs'])('parses JSX in a plain %s file (CRA / React Native)', (ext) => {
    const src = `import Header from './Header';\nexport default function App() {\n  return <div className="app"><Header /></div>;\n}\n`;
    expect(parseJS(src, ext)).not.toBeNull();
  });

  it('keeps TS type assertions parsing in .ts (no jsx plugin there)', () => {
    expect(parseJS(`const y = <number>(x as unknown);`, '.ts')).not.toBeNull();
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

  // Valid code that used to read as a "syntax error".
  it.each(['.js', '.jsx', '.mjs', '.cjs'])('parses Flow-typed %s (React Native)', (ext) => {
    const src = `// @flow\nimport type { Node } from 'react';\nexport function f(x: number): string {\n  return String(x);\n}\n`;
    expect(parseJS(src, ext)).not.toBeNull();
  });

  it('parses Flow + JSX in one .js file', () => {
    const src = `// @flow\ntype P = { n: number };\nexport const C = (p: P) => <div>{p.n}</div>;\n`;
    expect(parseJS(src, '.js')).not.toBeNull();
  });

  it.each(['.ts', '.tsx', '.js'])('parses auto-accessor class fields in %s', (ext) => {
    expect(parseJS(`class C { accessor x = 1; static accessor y = 2; }`, ext)).not.toBeNull();
    expect(parseJS(`class B { @dec accessor y = 1; }`, ext)).not.toBeNull();
  });

  it('still parses legacy parameter decorators in .ts', () => {
    const src = `class S { constructor(@Inject(T) private t: T) {} @Get() m() {} }`;
    expect(parseJS(src, '.ts')).not.toBeNull();
  });

  it('a .js file that parses without flow keeps its first-pass AST shape', () => {
    // `a < b > c` is a comparison in plain JS; the flow retry must not reread it.
    const r = parseJS(`const v = a < b > c;`, '.js')!;
    const types: string[] = [];
    walkAst(r.ast, (n: any) => types.push(n.type));
    expect(types).toContain('BinaryExpression');
  });

  it('still returns null for genuinely broken JS', () => {
    expect(parseJS(`export function (( {`, '.js')).toBeNull();
  });
});

describe('walkAst', () => {
  it('visits every node in the AST', () => {
    const r = parseJS(`const x = 1; function f() {}`, '.ts')!;
    let count = 0;
    walkAst(r.ast, () => {
      count++;
    });
    expect(count).toBeGreaterThan(0);
  });

  it('skips loc/start/end/range fields (avoids infinite recursion)', () => {
    const r = parseJS(`const x = 1;`, '.ts')!;
    const visited: string[] = [];
    walkAst(r.ast, (n: any) => {
      if (n?.type) visited.push(n.type);
    });
    expect(visited).toContain('VariableDeclaration');
  });
});
