/**
 * Tests for the v0.3.5 symbol-refs walker. Same-file scope; cross-file
 * resolution lands in phase 2.
 *
 * Coverage: every documented ref-kind happy path, plus the skip-set
 * cases (declarations, parameter names, property keys), plus dedupe.
 */

import { describe, expect, it } from 'vitest';
import { extractSymbolRefs, countRefsByName, type RawRef } from '../src/symbols-refs.js';

describe('extractSymbolRefs — call sites', () => {
  it('detects a direct call: foo()', () => {
    const refs = extractSymbolRefs('foo();', '.ts');
    expect(refs).toEqual<RawRef[]>([
      { name: 'foo', line: 1, kind: 'call', heuristic: false },
    ]);
  });

  it('detects a method-style call: x.foo() — records the root', () => {
    const refs = extractSymbolRefs('x.foo();', '.ts');
    const callRefs = refs.filter((r) => r.kind === 'call');
    expect(callRefs).toEqual([{ name: 'x', line: 1, kind: 'call', heuristic: false }]);
  });

  it('detects multiple distinct calls in one expression', () => {
    const refs = extractSymbolRefs('a(b(c()));', '.ts');
    expect(refs.filter((r) => r.kind === 'call').map((r) => r.name).sort()).toEqual(['a', 'b', 'c']);
  });

  it('does NOT count the function being declared as a call to itself', () => {
    const refs = extractSymbolRefs('function login() {}', '.ts');
    expect(refs.find((r) => r.name === 'login' && r.kind === 'call')).toBeUndefined();
  });
});

describe('extractSymbolRefs — JSX components', () => {
  it('detects <Component /> as a jsx ref', () => {
    const refs = extractSymbolRefs(
      'const x = <MyComponent />;',
      '.tsx',
    );
    const jsxRefs = refs.filter((r) => r.kind === 'jsx');
    expect(jsxRefs).toEqual([{ name: 'MyComponent', line: 1, kind: 'jsx', heuristic: false }]);
  });

  it('does NOT count lowercase HTML elements as refs', () => {
    const refs = extractSymbolRefs(
      'const x = <div><span /></div>;',
      '.tsx',
    );
    expect(refs.filter((r) => r.kind === 'jsx')).toEqual([]);
  });

  it('counts both component and its prop usage', () => {
    const refs = extractSymbolRefs(
      'const x = <MyComponent value={otherVar} />;',
      '.tsx',
    );
    expect(refs.filter((r) => r.name === 'MyComponent').length).toBeGreaterThan(0);
    expect(refs.filter((r) => r.name === 'otherVar').length).toBeGreaterThan(0);
  });
});

describe('extractSymbolRefs — TypeScript type references', () => {
  it('detects : SomeType as a type-ref', () => {
    const refs = extractSymbolRefs(
      'function f(x: User): void {}',
      '.ts',
    );
    const typeRefs = refs.filter((r) => r.kind === 'type-ref');
    expect(typeRefs.find((r) => r.name === 'User')).toBeDefined();
  });

  it('detects generic type args', () => {
    const refs = extractSymbolRefs(
      'const xs: Array<User> = [];',
      '.ts',
    );
    const typeRefs = refs.filter((r) => r.kind === 'type-ref');
    expect(typeRefs.map((r) => r.name).sort()).toEqual(['Array', 'User']);
  });
});

describe('extractSymbolRefs — skip set', () => {
  it('skips parameter names', () => {
    const refs = extractSymbolRefs('function f(login) { return login + 1; }', '.ts');
    /* `login` appears twice — as a param (skipped) and as a read in
       the body (kept). The read should be there. */
    expect(refs.find((r) => r.name === 'login' && r.kind === 'read')).toBeDefined();
  });

  it('skips object property keys (not shorthand)', () => {
    const refs = extractSymbolRefs(
      'const obj = { foo: someVar };',
      '.ts',
    );
    /* `foo` is a key — should NOT appear as a ref. `someVar` should. */
    expect(refs.find((r) => r.name === 'foo')).toBeUndefined();
    expect(refs.find((r) => r.name === 'someVar')).toBeDefined();
  });

  it('does NOT skip object property shorthand keys', () => {
    /* `{ foo }` is shorthand for `{ foo: foo }` — the key is also a
       value, so it IS a read of `foo`. The skip-set check is only for
       NON-shorthand keys. */
    const refs = extractSymbolRefs('const x = { foo };', '.ts');
    expect(refs.find((r) => r.name === 'foo')).toBeDefined();
  });

  it('skips variable declarator id', () => {
    const refs = extractSymbolRefs('const newVar = 5;', '.ts');
    expect(refs.find((r) => r.name === 'newVar')).toBeUndefined();
  });
});

describe('extractSymbolRefs — dedupe', () => {
  it('counts the same identifier on the same line + same kind once', () => {
    /* `f(x, x, x)` — `x` appears three times on line 1 as a read.
       After dedupe collapses (name, line, kind) triples, exactly one
       entry remains. */
    const refs = extractSymbolRefs('f(x, x, x);', '.ts');
    const xReads = refs.filter((r) => r.name === 'x' && r.kind === 'read');
    expect(xReads.length).toBe(1);
  });

  it('counts one ref when the same call appears on consecutive lines', () => {
    const refs = extractSymbolRefs(
      'foo();\nfoo();',
      '.ts',
    );
    const callRefs = refs.filter((r) => r.name === 'foo' && r.kind === 'call');
    expect(callRefs.length).toBe(2); // different lines, both kept
  });
});

describe('countRefsByName', () => {
  it('groups refs by name', () => {
    const refs: RawRef[] = [
      { name: 'a', line: 1, kind: 'call', heuristic: false },
      { name: 'a', line: 2, kind: 'call', heuristic: false },
      { name: 'b', line: 3, kind: 'call', heuristic: false },
    ];
    const counts = countRefsByName(refs);
    expect(counts.get('a')).toBe(2);
    expect(counts.get('b')).toBe(1);
  });
});

describe('extractSymbolRefs — output shape', () => {
  it('sorts deterministically by line then kind then name', () => {
    const refs = extractSymbolRefs(
      'foo();\nbar();\n<MyComp />\nfoo();',
      '.tsx',
    );
    const lines = refs.map((r) => r.line);
    const sorted = [...lines].sort((a, b) => a - b);
    expect(lines).toEqual(sorted);
  });

  it('returns empty for non-parseable extensions', () => {
    expect(extractSymbolRefs('whatever', '.txt')).toEqual([]);
    expect(extractSymbolRefs('{}', '.json')).toEqual([]);
  });

  it('returns empty for empty source', () => {
    expect(extractSymbolRefs('', '.ts')).toEqual([]);
  });
});

describe('determinism', () => {
  it('produces identical output across two runs of the same input', () => {
    const src = `
      import { Helper } from './helper';
      function login(user: User) {
        const token = Helper.sign(user);
        return <Avatar user={user} token={token} />;
      }
    `;
    const a = extractSymbolRefs(src, '.tsx');
    const b = extractSymbolRefs(src, '.tsx');
    expect(a).toEqual(b);
  });
});
