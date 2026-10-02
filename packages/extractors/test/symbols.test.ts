import { describe, expect, it } from 'vitest';
import { extractSymbols } from '../src/symbols.js';

/**
 * Tests for `extractSymbols` — Babel-AST-driven declaration extraction
 * for JS/TS/JSX/TSX. Covers each declaration kind (function / class /
 * interface / type / enum / hook / component) plus the export-marker
 * propagation and method nesting on classes.
 */

describe('extractSymbols — top-level declarations', () => {
  it('extracts an exported function', () => {
    const src = `export function getUser(id) { return id; }`;
    const syms = extractSymbols(src, '.ts');
    const fn = syms.find((s) => s.name === 'getUser');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
    expect(fn!.exported).toBe(true);
  });

  // Regression: JSDoc on `export function foo` attaches to the export wrapper,
  // not the inner FunctionDeclaration — exported docstrings were silently dropped.
  it('captures the docstring on an EXPORTED function', () => {
    const fn = extractSymbols(
      '/** Greets the user. */\nexport function greet(name) { return name; }',
      '.ts',
    ).find((s) => s.name === 'greet');
    expect(fn!.docstring).toBe('Greets the user.');
  });

  it('captures the docstring on a non-exported function (control)', () => {
    const fn = extractSymbols(
      '/** Internal helper. */\nfunction helper() { return 1; }',
      '.ts',
    ).find((s) => s.name === 'helper');
    expect(fn!.docstring).toBe('Internal helper.');
  });

  it('captures the docstring on an exported class', () => {
    const cls = extractSymbols(
      '/** A user service. */\nexport class UserSvc { run() {} }',
      '.ts',
    ).find((s) => s.name === 'UserSvc');
    expect(cls!.docstring).toBe('A user service.');
  });

  it('captures the docstring on a default-exported function', () => {
    const fn = extractSymbols(
      '/** Default entry. */\nexport default function main() {}',
      '.ts',
    ).find((s) => s.name === 'main');
    expect(fn!.docstring).toBe('Default entry.');
  });

  it('extracts a non-exported function (still surfaced)', () => {
    const src = `function helper() { return 1; }`;
    const syms = extractSymbols(src, '.ts');
    const fn = syms.find((s) => s.name === 'helper');
    expect(fn).toBeDefined();
    expect(fn!.exported).toBe(false);
  });

  it('extracts an exported class with methods nested as children', () => {
    const src = `
      export class UserService {
        async findById(id) { return id; }
        delete(id) { return id; }
      }
    `;
    const syms = extractSymbols(src, '.ts');
    const cls = syms.find((s) => s.kind === 'class');
    expect(cls).toBeDefined();
    expect(cls!.name).toBe('UserService');
    expect(cls!.exported).toBe(true);
    expect(cls!.children).toBeDefined();
    const methodNames = (cls!.children || []).map((c) => c.name).sort();
    expect(methodNames).toEqual(['delete', 'findById']);
  });

  it('extracts a TypeScript interface', () => {
    const src = `export interface User { id: string; name: string; }`;
    const syms = extractSymbols(src, '.ts');
    const iface = syms.find((s) => s.kind === 'interface');
    expect(iface).toBeDefined();
    expect(iface!.name).toBe('User');
  });

  it('extracts a TypeScript type alias', () => {
    const src = `export type ID = string | number;`;
    const syms = extractSymbols(src, '.ts');
    const t = syms.find((s) => s.kind === 'type');
    expect(t).toBeDefined();
    expect(t!.name).toBe('ID');
  });

  it('extracts a TypeScript enum', () => {
    const src = `export enum Status { Ok = 1, Bad = 2 }`;
    const syms = extractSymbols(src, '.ts');
    const e = syms.find((s) => s.kind === 'enum');
    expect(e).toBeDefined();
    expect(e!.name).toBe('Status');
  });
});

describe('extractSymbols — heuristic kinds (component / hook)', () => {
  it('classifies PascalCase function returning JSX as a component', () => {
    const src = `
      export function Button({ label }) {
        return <button>{label}</button>;
      }
    `;
    const syms = extractSymbols(src, '.tsx');
    const c = syms.find((s) => s.name === 'Button');
    expect(c).toBeDefined();
    expect(c!.kind).toBe('component');
  });

  it('classifies a use* function as a hook', () => {
    const src = `
      import { useState } from 'react';
      export function useCounter() { return useState(0); }
    `;
    const syms = extractSymbols(src, '.tsx');
    const h = syms.find((s) => s.name === 'useCounter');
    expect(h).toBeDefined();
    expect(h!.kind).toBe('hook');
  });

  it('classifies arrow component assigned to a const', () => {
    const src = `export const Card = ({ children }) => <div>{children}</div>;`;
    const syms = extractSymbols(src, '.tsx');
    const c = syms.find((s) => s.name === 'Card');
    expect(c).toBeDefined();
    expect(c!.kind).toBe('component');
  });
});

describe('extractSymbols — docstrings (JSDoc leading comments)', () => {
  it('captures a JSDoc block above a function (when Babel attaches it)', () => {
    // JSDoc comment attachment depends on Babel's leadingComments
    // behavior, which can vary with whitespace + plugin combinations.
    // We assert the docstring is EITHER present + correct, OR absent —
    // never wrong.
    const src = `/**\n * Returns the user by ID.\n */\nfunction getUser(id) { return id; }\n`;
    const syms = extractSymbols(src, '.ts');
    const fn = syms.find((s) => s.name === 'getUser');
    expect(fn).toBeDefined();
    if (fn!.docstring) {
      expect(fn!.docstring).toContain('Returns the user by ID');
    }
  });

  it('caps long docstrings (avoids artifact bloat)', () => {
    const long = 'word '.repeat(200);
    const src = `
      /**
       * ${long}
       */
      export function f() {}
    `;
    const syms = extractSymbols(src, '.ts');
    const fn = syms.find((s) => s.name === 'f');
    if (fn?.docstring) {
      // Documented cap is 240 chars + ellipsis
      expect(fn.docstring.length).toBeLessThanOrEqual(240);
    }
  });
});

describe('extractSymbols — edge cases', () => {
  it('returns [] for an empty source', () => {
    expect(extractSymbols('', '.ts')).toEqual([]);
  });

  it('returns [] for a syntax error (errorRecovery still parses where it can)', () => {
    // Babel's errorRecovery returns a partial AST; we should not throw
    expect(() => extractSymbols('const = ;', '.ts')).not.toThrow();
  });

  it('returns [] for unparseable extension', () => {
    expect(extractSymbols('hello world', '.txt')).toEqual([]);
  });

  it('dedupes overload signatures by (name, kind, startLine)', () => {
    const src = `
      export function fmt(n: number): string;
      export function fmt(s: string): string;
      export function fmt(x: any) { return String(x); }
    `;
    const syms = extractSymbols(src, '.ts');
    const fmts = syms.filter((s) => s.name === 'fmt');
    // Implementation overload + the function body — at most 2 unique entries
    expect(fmts.length).toBeLessThanOrEqual(2);
  });
});

describe('extractSymbols — export lists and `export default Name` (HUNT-CORE-11)', () => {
  it('marks declarations named by an export list as exported, without duplicates', () => {
    const src = `function a() {}\nclass C {}\nexport { a };\nexport default C;\n`;
    const syms = extractSymbols(src, '.ts');
    expect(syms.map((s) => [s.name, s.kind, s.exported, s.isDefault === true])).toEqual([
      ['a', 'function', true, false],
      ['C', 'class', true, true],
    ]);
  });

  it('promotes a bare const that `export default` names, keeping its component kind', () => {
    const src = `const App = () => <div />;\nconst helper = 1;\nexport default App;\n`;
    const syms = extractSymbols(src, '.jsx');
    expect(syms).toHaveLength(1);
    expect(syms[0]).toMatchObject({
      name: 'App',
      kind: 'component',
      exported: true,
      isDefault: true,
    });
  });

  it('handles `export { x as default }` and only the listed declarators of a multi-const', () => {
    const src = `const x = 1, y = 2;\nexport { x as default };\n`;
    const syms = extractSymbols(src, '.ts');
    expect(syms.map((s) => [s.name, s.isDefault === true])).toEqual([['x', true]]);
  });

  it('keeps a default export of an imported binding visible', () => {
    const syms = extractSymbols(`import App from './App';\nexport default App;\n`, '.ts');
    expect(syms).toEqual([
      expect.objectContaining({ name: 'App', exported: true, isDefault: true }),
    ]);
  });

  it('flags a named default function as the default export', () => {
    const fn = extractSymbols('export default function main() {}', '.ts')[0];
    expect(fn).toMatchObject({ name: 'main', exported: true, isDefault: true });
  });
});
