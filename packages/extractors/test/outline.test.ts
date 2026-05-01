import { describe, expect, it } from 'vitest';
import { extractOutline } from '../src/outline.js';

/**
 * Tests for `extractOutline` — VS-Code-style declaration tree (function /
 * method / class / interface / type / enum / variable / property /
 * import / export). Covers JS/TS via Babel and Python via line-based
 * regex.
 */

describe('extractOutline — JS/TS', () => {
  it('lists top-level functions', () => {
    const src = `function a() {}\nfunction b() {}\n`;
    const out = extractOutline(src, '.ts');
    const names = out.map((n) => n.name);
    expect(names).toContain('a');
    expect(names).toContain('b');
  });

  it('lists classes with methods nested as children', () => {
    const src = `
      class Foo {
        bar() {}
        baz() {}
      }
    `;
    const out = extractOutline(src, '.ts');
    const cls = out.find((n) => n.kind === 'class' && n.name === 'Foo');
    expect(cls).toBeDefined();
    expect(cls!.children?.map((c) => c.name).sort()).toEqual(['bar', 'baz']);
  });

  it('captures the function signature in `signature`', () => {
    const src = `function add(a, b) { return a + b; }`;
    const out = extractOutline(src, '.ts');
    const fn = out.find((n) => n.name === 'add');
    expect(fn?.signature).toContain('add');
  });

  it('lists interfaces', () => {
    const src = `interface User { id: string; }`;
    const out = extractOutline(src, '.ts');
    expect(out.find((n) => n.kind === 'interface')?.name).toBe('User');
  });

  it('lists type aliases', () => {
    const src = `type ID = string;`;
    const out = extractOutline(src, '.ts');
    expect(out.find((n) => n.kind === 'type')?.name).toBe('ID');
  });

  it('lists imports', () => {
    const src = `import { useState } from 'react';\nimport fs from 'node:fs';`;
    const out = extractOutline(src, '.ts');
    const imports = out.filter((n) => n.kind === 'import');
    expect(imports.map((i) => i.name).sort()).toEqual(['node:fs', 'react']);
  });

  it('returns [] for empty source', () => {
    expect(extractOutline('', '.ts')).toEqual([]);
  });

  it('returns [] for non-parseable extension', () => {
    expect(extractOutline('hi', '.txt')).toEqual([]);
  });
});

describe('extractOutline — Python', () => {
  it('lists def functions', () => {
    const src = `def hello():\n    return 1\n\ndef world():\n    return 2\n`;
    const out = extractOutline(src, '.py');
    expect(out.map((n) => n.name)).toEqual(['hello', 'world']);
    expect(out.every((n) => n.kind === 'function')).toBe(true);
  });

  it('lists classes with methods nested', () => {
    const src = `class Foo:\n    def bar(self):\n        return 1\n    def baz(self):\n        return 2\n`;
    const out = extractOutline(src, '.py');
    const cls = out.find((n) => n.kind === 'class' && n.name === 'Foo');
    expect(cls).toBeDefined();
    expect(cls!.children?.map((c) => c.name).sort()).toEqual(['bar', 'baz']);
  });

  it('handles async def functions', () => {
    const src = `async def fetch():\n    return 1\n`;
    const out = extractOutline(src, '.py');
    expect(out[0]?.signature).toContain('async');
  });

  it('lists module-level UPPER_CASE constants', () => {
    const src = `MAX_SIZE = 1024\nDEBUG = True\n`;
    const out = extractOutline(src, '.py');
    const consts = out.filter((n) => n.kind === 'variable');
    expect(consts.map((c) => c.name).sort()).toEqual(['DEBUG', 'MAX_SIZE']);
  });

  it('handles multi-line def signatures', () => {
    const src = `def long_signature(\n    a: int,\n    b: str,\n    c: float = 1.0,\n) -> None:\n    pass\n`;
    const out = extractOutline(src, '.py');
    expect(out[0]?.name).toBe('long_signature');
  });
});
