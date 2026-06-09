import { describe, expect, it } from 'vitest';
import { extractImports } from '../src/imports.js';
import { extractPythonImports } from '../src/imports-python.js';

describe('extractImports · JS/TS', () => {
  it('picks up default + named + type + re-export imports', () => {
    const src = `
      import React from 'react';
      import { useState, useEffect as fx } from 'react';
      import type { FC } from 'react';
      export { something } from './local';
      export * from '@scope/pkg';
    `;
    const out = extractImports(src, '.ts');
    // Dedupe is by (specifier, kind) — so 'react' import + 'react' type-import coexist.
    const specs = new Set(out.map((r) => r.specifier));
    expect([...specs].sort()).toEqual(['./local', '@scope/pkg', 'react']);
    // Type-only import → 'type-import' kind.
    expect(out.some((r) => r.specifier === 'react' && r.kind === 'type-import')).toBe(true);
  });

  it('captures local binding names (F2 symbol-graph import resolution)', () => {
    const src = `
      import React from 'react';
      import { useState, useEffect as fx } from 'react';
      import * as path from 'node:path';
      import './side-effect';
      export { something } from './local';
    `;
    const out = extractImports(src, '.ts');
    const value = out.find((r) => r.specifier === 'react' && r.kind === 'import');
    // default + named + aliased(local alias) bindings, in source order.
    expect(value?.names).toEqual(['React', 'useState', 'fx']);
    // namespace binding.
    expect(out.find((r) => r.specifier === 'node:path')?.names).toEqual(['path']);
    // side-effect import binds nothing.
    expect(out.find((r) => r.specifier === './side-effect')?.names).toEqual([]);
    // re-export creates no local binding.
    expect(out.find((r) => r.specifier === './local')?.names).toEqual([]);
  });

  it('unions binding names when the same module is imported twice', () => {
    const src = `
      import { a } from './m';
      import { b } from './m';
    `;
    const out = extractImports(src, '.ts');
    const m = out.filter((r) => r.specifier === './m' && r.kind === 'import');
    expect(m).toHaveLength(1); // deduped by (specifier, kind)
    expect(m[0]?.names).toEqual(['a', 'b']); // but names merged, not dropped
  });

  it('catches dynamic imports and require()', () => {
    const src = `
      const x = import('dynamic-thing');
      const y = require('cjs-thing');
    `;
    const out = extractImports(src, '.js');
    const specs = out.map((r) => r.specifier).sort();
    expect(specs).toEqual(['cjs-thing', 'dynamic-thing']);
    expect(out.find((r) => r.specifier === 'dynamic-thing')?.kind).toBe('dynamic-import');
  });

  it('returns [] for a non-code extension', () => {
    expect(extractImports('import x from "y"', '.css')).toEqual([]);
  });

  it('does not crash on a parse error', () => {
    // Trailing import with a clean subsequent import. With errorRecovery,
    // @babel/parser returns an AST with partial bodies — the second
    // import may or may not be recovered depending on Babel's heuristics.
    // We only assert that the function returns without throwing.
    const broken = 'import x from \nconst y = 1;\nimport z from "ok";';
    expect(() => extractImports(broken, '.ts')).not.toThrow();
  });
});

describe('extractPythonImports', () => {
  it('handles import / from / as / dotted', () => {
    const src = `
      import os, sys as system
      from pathlib import Path
      from ..utils import helper
      from pkg.subpkg import thing
      # import bogus_in_comment
      """import bogus_in_docstring"""
      importlib.import_module('dyn.mod')
    `;
    const specs = extractPythonImports(src).map((r) => r.specifier).sort();
    expect(specs).toEqual(['..utils', 'dyn.mod', 'os', 'pathlib', 'pkg.subpkg', 'sys']);
  });

  it('classifies dynamic imports', () => {
    const out = extractPythonImports('x = __import__("foo.bar")');
    expect(out[0]).toEqual({ specifier: 'foo.bar', kind: 'dynamic-import', line: 1, names: [] });
  });
});
