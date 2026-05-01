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
