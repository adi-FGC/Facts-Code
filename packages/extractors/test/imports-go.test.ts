import { describe, expect, it } from 'vitest';
import { extractGoImports, extractGoSymbols, isGo } from '../src/imports-go.js';

/** F6 — Go extractor: imports (single + block, aliases) and top-level symbols
 *  (func/method/type/var/const; exported = uppercase, Go's own rule). */

const SRC = `// Package shop implements the store.
package shop

import "fmt"
import alias "example.com/shop/internal/auth"

import (
	"strings"
	_ "embed"
	. "example.com/shop/internal/db"
	model "example.com/shop/models/user"
)

// Tax is the flat rate.
const Tax = 0.2

var registry = map[string]string{}

const (
	StatusOpen   = "open"
	statusHidden = "hidden"
)

type Order struct {
	ID string
}

type Pricer interface {
	Price() int
}

type cents = int

// Total sums the order. "import \\"fake\\"" inside this string must not count.
func Total(o Order) int {
	s := "import \\"fake/pkg\\""
	_ = s
	return 0
}

func (o *Order) describe() string {
	return fmt.Sprintf("%v", o.ID)
}
`;

describe('extractGoImports (F6)', () => {
  const imports = extractGoImports(SRC);
  const specs = imports.map((i) => i.specifier);

  it('captures single-line, aliased, blank, dot, and block imports', () => {
    expect(specs).toEqual([
      'fmt',
      'example.com/shop/internal/auth',
      'strings',
      'embed',
      'example.com/shop/internal/db',
      'example.com/shop/models/user',
    ]);
  });

  it('ignores import-looking text inside strings and comments', () => {
    expect(specs).not.toContain('fake/pkg');
  });

  it('records 1-based line numbers', () => {
    expect(imports.find((i) => i.specifier === 'fmt')!.line).toBe(4);
  });
});

describe('extractGoSymbols (F6)', () => {
  const syms = extractGoSymbols(SRC);
  const byName = Object.fromEntries(syms.map((s) => [s.name, s]));

  it('extracts funcs, methods, types, vars, consts (incl. grouped)', () => {
    expect(byName['Total']!.kind).toBe('function');
    expect(byName['describe']!.kind).toBe('method');
    expect(byName['Order']!.kind).toBe('class');
    expect(byName['Pricer']!.kind).toBe('interface');
    expect(byName['cents']!.kind).toBe('type');
    expect(byName['Tax']!.kind).toBe('constant');
    expect(byName['registry']!.kind).toBe('variable');
    expect(byName['StatusOpen']!.kind).toBe('constant');
  });

  it('exported is exact — uppercase first letter is the rule', () => {
    expect(byName['Total']!.exported).toBe(true);
    expect(byName['describe']!.exported).toBe(false);
    expect(byName['StatusOpen']!.exported).toBe(true);
    expect(byName['statusHidden']!.exported).toBe(false);
  });

  it('brace tracking recovers the function span', () => {
    const total = byName['Total']!;
    expect(total.endLine).toBeGreaterThan(total.startLine);
    // The struct body spans its braces too.
    expect(byName['Order']!.endLine).toBe(byName['Order']!.startLine + 2);
  });
});

describe('isGo', () => {
  it('matches only .go', () => {
    expect(isGo('.go')).toBe(true);
    expect(isGo('.ts')).toBe(false);
  });
});

describe('extractGoSymbols — review fixes (F6)', () => {
  it('braces inside string literals do not bleed endLine into the next decl', () => {
    const src = `package p

func Render(n int) string {
	return fmt.Sprintf("{%d}", n)
}

func Next() int {
	return 1
}
`;
    const syms = extractGoSymbols(src);
    const render = syms.find((s) => s.name === 'Render')!;
    const next = syms.find((s) => s.name === 'Next')!;
    // Without string-blanking, the "{" inside Sprintf inflates brace depth and
    // Render's endLine swallows Next's body.
    expect(render.endLine).toBe(5);
    expect(next.startLine).toBe(7);
  });

  it('multi-line (gofmt-wrapped) signatures get the full body span, not a truncated one', () => {
    // gofmt wraps long parameter lists across lines, so the opening `{` lands
    // on a later line than the `func` keyword. braceEnd must scan to the real
    // `}` instead of concluding "braceless" at the first line.
    const src = `package p

func Sum(
  a int,
  b int,
) int {
  return a + b
}

func After() int {
  return 1
}
`;
    const syms = extractGoSymbols(src);
    const sum = syms.find((s) => s.name === 'Sum')!;
    const after = syms.find((s) => s.name === 'After')!;
    expect(sum.startLine).toBe(3);
    expect(sum.endLine).toBe(8); // the wrapped body's closing brace, not start+1
    // The following declaration must keep its own span — not be swallowed.
    expect(after.startLine).toBe(10);
    expect(after.endLine).toBe(12);
  });

  it('grouped type ( ... ) blocks yield every member, incl. struct bodies', () => {
    const src = `package p

type (
	OrderStatus int
	PaymentState string
	Receipt struct {
		Cents int
	}
)

func After() {}
`;
    const syms = extractGoSymbols(src);
    const names = Object.fromEntries(syms.map((s) => [s.name, s]));
    expect(names['OrderStatus']!.kind).toBe('type');
    expect(names['PaymentState']!.kind).toBe('type');
    expect(names['Receipt']!.kind).toBe('class');
    // The struct's MEMBER line must not register as a bogus sibling entry.
    expect(names['Cents']).toBeUndefined();
    expect(names['After']!.kind).toBe('function');
  });
});
