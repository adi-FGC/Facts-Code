import { describe, expect, it } from 'vitest';
import { analyze } from '../src/index.js';
import { memoryFS } from '@factstack/fs-memory';

/**
 * F6 DoD — "a Go fixture produces symbols + import edges through the same
 * pipeline as TS." A two-package Go module analyzed end-to-end: go.mod gives
 * the module name, main imports the internal package, and the resolver turns
 * the module-absolute import into a project-internal file edge.
 */

const GO_MOD = 'module example.com/shop\n\ngo 1.22\n';

const MAIN_GO = `package main

import (
	"fmt"
	"example.com/shop/internal/store"
)

func main() {
	fmt.Println(store.Total())
}
`;

const STORE_GO = `package store

// Total returns the running total in cents.
func Total() int {
	return total
}

var total = 0

type Receipt struct {
	Cents int
}
`;

function makeFs() {
  return memoryFS({
    'go.mod': GO_MOD,
    'main.go': MAIN_GO,
    'internal/store/store.go': STORE_GO,
  });
}

describe('analyze — Go pipeline (F6 DoD)', () => {
  it('produces an import edge from main.go to the internal package', async () => {
    const { agent } = await analyze(makeFs(), { root: '.' });
    const edge = agent.graph.edges.find(
      (e) => e.from === 'main.go' && e.to === 'internal/store/store.go',
    );
    expect(edge).toBeDefined();
    expect(edge!.kind).toBe('import');
  });

  it('stdlib imports stay external (no edge for "fmt")', async () => {
    const { agent } = await analyze(makeFs(), { root: '.' });
    expect(agent.graph.edges.filter((e) => e.from === 'main.go')).toHaveLength(1);
  });

  it('Go files carry real declarations with Go-exact export flags', async () => {
    const { agent } = await analyze(makeFs(), { root: '.' });
    const store = agent.files.find((f) => f.path === 'internal/store/store.go')!;
    const names = Object.fromEntries(store.declarations.map((d) => [d.name, d]));
    expect(names['Total']!.kind).toBe('function');
    expect(names['Total']!.exported).toBe(true);
    expect(names['total']!.exported).toBe(false);
    expect(names['Receipt']!.kind).toBe('class');
    // Exports surface in the flat export list like any TS module's would.
    expect(store.exports.map((e) => e.name)).toContain('Total');
  });

  it('resolved import is backfilled on the outline (same as TS)', async () => {
    const { agent } = await analyze(makeFs(), { root: '.' });
    const main = agent.files.find((f) => f.path === 'main.go')!;
    const internal = main.imports.find((i) => i.source === 'example.com/shop/internal/store');
    expect(internal?.resolved).toBe('internal/store/store.go');
    const fmt = main.imports.find((i) => i.source === 'fmt');
    expect(fmt?.resolved).toBeNull();
  });
});
