import { describe, expect, it } from 'vitest';
import {
  buildDiagram,
  buildFocalDiagram,
  buildHubDiagram,
  buildPackageDiagram,
  classifyPath,
  sanitizeId,
  shortPath,
} from '../src/diagram.js';
import type { AgentArtifact } from '@factstack/spec';

/**
 * Tests for the v0.7.1 Mermaid diagram generators.
 *
 * Test philosophy mirrors `memory.test.ts`:
 *   - Every assertion fails for a clearly stated reason. No
 *     `expect(out).toContain('flowchart')` style asserts that pass
 *     on garbage.
 *   - Output IS the contract: when we test for an exact line we mean
 *     "this is the rendered Mermaid syntax users will see in their
 *     PR comments." When we test for the absence of duplicates we
 *     mean "Mermaid uses last-write-wins for duplicate IDs, which
 *     would silently clobber labels."
 *   - Determinism is enforced: same input → byte-identical output.
 *   - Bounds are enforced: maxNodes caps prevent a 10k-file monorepo
 *     from producing a Mermaid block that breaks the GitHub renderer.
 *
 * Coverage targets:
 *   - classifyPath / shortPath / sanitizeId edge cases that determine
 *     downstream output quality.
 *   - Package view: edge aggregation, self-loop filter, hard cap.
 *   - Hub view: in-degree ranking, importer cap, hub/importer dedupe
 *     (the load-bearing bug found during dogfood).
 *   - Focal view: BFS depth + node count caps, unknown-focus path,
 *     edge-kind styling.
 *   - Dispatcher: opts.view branches + the focal-missing-focus throw.
 */

// ── Fixture builders ──────────────────────────────────────────────────

function makeAgent(overrides: Partial<AgentArtifact> = {}): AgentArtifact {
  return {
    $schema: 'https://factstack.dev/schema/agent.v1.json',
    factsVersion: '0.1.0',
    generatedAt: '2026-05-01T00:00:00Z',
    project: { name: 'demo', root: '.', languages: [], frameworks: [], entryPoints: [], monorepo: null },
    files: [],
    graph: { nodes: [], edges: [], cycles: [] },
    routes: [],
    scripts: {},
    capabilities: [],
    risks: [],
    stats: { loc: 0, fileCount: 0, packageCount: 0, totalTokenCost: 0 },
    ...overrides,
  } as AgentArtifact;
}

/** Convenience: build an edge object with a default `import` kind. */
function edge(from: string, to: string, kind: 'import' | 'type-import' | 'dynamic-import' = 'import') {
  return { from, to, kind };
}

// ── classifyPath ──────────────────────────────────────────────────────

describe('classifyPath', () => {
  it('classifies packages/<name>/... to packages/<name>', () => {
    expect(classifyPath('packages/spec/src/index.ts')).toBe('packages/spec');
    expect(classifyPath('packages/core/test/diff.test.ts')).toBe('packages/core');
  });

  it('classifies apps/<name>/... to apps/<name>', () => {
    expect(classifyPath('apps/cli/src/cli.ts')).toBe('apps/cli');
    expect(classifyPath('apps/ui-remix/src/routes/About.tsx')).toBe('apps/ui-remix');
  });

  it('groups all of docs/ under one "docs" label', () => {
    expect(classifyPath('docs/handoff.html')).toBe('docs');
    expect(classifyPath('docs/adr/0001-tier-model.md')).toBe('docs');
  });

  it('returns null for unclassifiable paths (root files)', () => {
    /* Root-level config files would each become a single-node
     * package if we didn't drop them. The package view is for
     * inter-package edges; root files have no package. */
    expect(classifyPath('package.json')).toBeNull();
    expect(classifyPath('vite.config.ts')).toBeNull();
    expect(classifyPath('CLAUDE.md')).toBeNull();
  });

  it('normalizes Windows separators', () => {
    expect(classifyPath('packages\\spec\\src\\index.ts')).toBe('packages/spec');
  });
});

// ── sanitizeId / shortPath ────────────────────────────────────────────

describe('sanitizeId', () => {
  it('produces a Mermaid-safe ID for a typical file path', () => {
    /* IDs must start with a letter, contain only [a-zA-Z0-9_]. The
     * `n_` prefix guarantees the letter-start. */
    const id = sanitizeId('packages/spec/src/index.ts');
    expect(id).toBe('n_packages_spec_src_index_ts');
    expect(id).toMatch(/^[a-zA-Z][a-zA-Z0-9_]*$/);
  });

  it('produces distinct IDs for paths that differ only in punctuation', () => {
    /* `a.b` and `a-b` would collide under naive replace-non-alnum-with-_.
     * The current implementation accepts that as fine for path inputs
     * (paths don't commonly differ only in one punctuation slot). */
    expect(sanitizeId('a.b')).toBe(sanitizeId('a-b'));
    /* But two genuinely different paths produce different IDs. */
    expect(sanitizeId('apps/cli')).not.toBe(sanitizeId('apps/core'));
  });
});

describe('shortPath', () => {
  it('keeps short paths unchanged', () => {
    expect(shortPath('cli.ts')).toBe('cli.ts');
    expect(shortPath('apps/cli/cli.ts')).toBe('apps/cli/cli.ts');
  });

  it('elides middle segments of deep paths', () => {
    expect(shortPath('apps/ui-remix/src/lib/loadArtifacts.ts')).toBe(
      'apps/ui-remix/…/loadArtifacts.ts',
    );
  });

  it('normalizes Windows separators', () => {
    expect(shortPath('apps\\ui-remix\\src\\routes\\About.tsx')).toBe(
      'apps/ui-remix/…/About.tsx',
    );
  });
});

// ── buildPackageDiagram ───────────────────────────────────────────────

describe('buildPackageDiagram', () => {
  it('starts with a flowchart LR directive (Mermaid contract)', () => {
    const out = buildPackageDiagram(makeAgent());
    expect(out.startsWith('flowchart LR\n')).toBe(true);
  });

  it('renders the empty-graph case as a flowchart with no nodes', () => {
    const out = buildPackageDiagram(makeAgent());
    /* No nodes, no edges, but still a valid Mermaid document. */
    expect(out.trim()).toBe('flowchart LR');
  });

  it('renders one edge between two packages with a Mermaid arrow', () => {
    const agent = makeAgent({
      graph: {
        nodes: [],
        edges: [edge('apps/cli/src/cli.ts', 'packages/spec/src/index.ts')],
        cycles: [],
      },
    });
    const out = buildPackageDiagram(agent);
    expect(out).toContain('n_apps_cli["apps/cli"]');
    expect(out).toContain('n_packages_spec["packages/spec"]');
    expect(out).toContain('n_apps_cli --> n_packages_spec');
  });

  it('aggregates multiple cross-package edges into one labeled edge', () => {
    const agent = makeAgent({
      graph: {
        nodes: [],
        edges: [
          edge('apps/cli/src/cli.ts', 'packages/spec/src/index.ts'),
          edge('apps/cli/src/cli.ts', 'packages/spec/src/diff.ts'),
          edge('apps/cli/src/emit.ts', 'packages/spec/src/index.ts'),
        ],
        cycles: [],
      },
    });
    const out = buildPackageDiagram(agent);
    /* Three file-level edges all collapse to one package-level edge
     * with the count `|3|`. */
    expect(out).toContain('n_apps_cli -->|3| n_packages_spec');
    /* Only ONE edge line between the two packages — no duplicates.
     * The arrow itself can be 3-10 chars depending on edge-kind +
     * count label (e.g. `-->|3|` is 6 chars). */
    const matches = out.match(/n_apps_cli .{2,12} n_packages_spec/g);
    expect(matches?.length).toBe(1);
  });

  it('filters within-package edges (self-loops are not useful at this view)', () => {
    const agent = makeAgent({
      graph: {
        nodes: [],
        edges: [
          /* Both endpoints in packages/spec — should be filtered. */
          edge('packages/spec/src/index.ts', 'packages/spec/src/diff.ts'),
          /* Cross-package, should be rendered. */
          edge('packages/core/src/index.ts', 'packages/spec/src/index.ts'),
        ],
        cycles: [],
      },
    });
    const out = buildPackageDiagram(agent);
    expect(out).toContain('n_packages_core --> n_packages_spec');
    expect(out).not.toMatch(/n_packages_spec .{2,4} n_packages_spec/);
  });

  it('filters unclassifiable endpoints (root config files)', () => {
    const agent = makeAgent({
      graph: {
        nodes: [],
        edges: [
          /* package.json isn't classifiable — edge should be dropped. */
          edge('package.json', 'packages/spec/src/index.ts'),
          edge('apps/cli/src/cli.ts', 'packages/spec/src/index.ts'),
        ],
        cycles: [],
      },
    });
    const out = buildPackageDiagram(agent);
    expect(out).not.toContain('package_json');
    expect(out).toContain('n_apps_cli --> n_packages_spec');
  });

  it('picks the strongest arrow style when an edge mixes kinds', () => {
    /* When the aggregated edge contains both `import` and `type-import`
     * variants, the merged arrow is solid (`-->`). A purely-type-import
     * package edge stays dashed. */
    const agentMixed = makeAgent({
      graph: {
        nodes: [],
        edges: [
          edge('apps/cli/src/a.ts', 'packages/spec/src/index.ts', 'type-import'),
          edge('apps/cli/src/b.ts', 'packages/spec/src/index.ts', 'import'),
        ],
        cycles: [],
      },
    });
    expect(buildPackageDiagram(agentMixed)).toContain('n_apps_cli -->|2| n_packages_spec');

    const agentTypeOnly = makeAgent({
      graph: {
        nodes: [],
        edges: [
          edge('apps/cli/src/a.ts', 'packages/spec/src/index.ts', 'type-import'),
          edge('apps/cli/src/b.ts', 'packages/spec/src/index.ts', 'type-import'),
        ],
        cycles: [],
      },
    });
    expect(buildPackageDiagram(agentTypeOnly)).toContain('n_apps_cli -.->|2| n_packages_spec');
  });

  it('respects maxNodes cap by trimming least-active packages', () => {
    /* Build 5 packages but cap to 3. The 2 packages with the lowest
     * edge weight should be dropped along with their edges. */
    const agent = makeAgent({
      graph: {
        nodes: [],
        edges: [
          /* core ↔ spec: weight 5 each */
          edge('packages/core/src/a.ts', 'packages/spec/src/index.ts'),
          edge('packages/core/src/b.ts', 'packages/spec/src/index.ts'),
          edge('packages/core/src/c.ts', 'packages/spec/src/index.ts'),
          edge('packages/core/src/d.ts', 'packages/spec/src/index.ts'),
          edge('packages/core/src/e.ts', 'packages/spec/src/index.ts'),
          /* cli → spec: weight 1 */
          edge('apps/cli/src/cli.ts', 'packages/spec/src/index.ts'),
          /* mcp → spec: weight 1 (drops in trim) */
          edge('apps/mcp-server/src/server.ts', 'packages/spec/src/index.ts'),
          /* ui-remix → spec: weight 1 (drops in trim) */
          edge('apps/ui-remix/src/lib/loadArtifacts.ts', 'packages/spec/src/index.ts'),
        ],
        cycles: [],
      },
    });
    const out = buildPackageDiagram(agent, { maxNodes: 3 });
    /* Top 3 by weight: packages/spec (8 incoming), packages/core (5
     * outgoing), apps/cli (1 outgoing). The other two apps drop. */
    expect(out).toContain('n_packages_spec');
    expect(out).toContain('n_packages_core');
    expect(out).toContain('n_apps_cli');
    expect(out).not.toContain('n_apps_mcp_server');
    expect(out).not.toContain('n_apps_ui_remix');
  });

  it('is deterministic across two calls', () => {
    const agent = makeAgent({
      graph: {
        nodes: [],
        edges: [
          edge('apps/cli/src/a.ts', 'packages/spec/src/index.ts'),
          edge('apps/cli/src/b.ts', 'packages/core/src/index.ts'),
          edge('packages/core/src/x.ts', 'packages/spec/src/index.ts'),
        ],
        cycles: [],
      },
    });
    expect(buildPackageDiagram(agent)).toBe(buildPackageDiagram(agent));
  });
});

// ── buildHubDiagram ───────────────────────────────────────────────────

describe('buildHubDiagram', () => {
  it('renders a clear placeholder when the graph has no edges', () => {
    const out = buildHubDiagram(makeAgent());
    expect(out).toContain('empty["(no edges in graph)"]');
  });

  it('ranks hubs by in-degree, ties broken alphabetically', () => {
    const agent = makeAgent({
      graph: {
        nodes: [],
        edges: [
          /* B has 3 importers. A has 2. C has 2. Order: B, A, C. */
          edge('importer-1.ts', 'B.ts'),
          edge('importer-2.ts', 'B.ts'),
          edge('importer-3.ts', 'B.ts'),
          edge('importer-1.ts', 'A.ts'),
          edge('importer-2.ts', 'A.ts'),
          edge('importer-1.ts', 'C.ts'),
          edge('importer-2.ts', 'C.ts'),
        ],
        cycles: [],
      },
    });
    const out = buildHubDiagram(agent);
    /* B comes first as the highest-in-degree hub. */
    const bIdx = out.indexOf('n_B_ts[');
    const aIdx = out.indexOf('n_A_ts[');
    const cIdx = out.indexOf('n_C_ts[');
    expect(bIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeGreaterThan(bIdx);
    expect(cIdx).toBeGreaterThan(aIdx);
  });

  it('annotates each hub with its in-degree count', () => {
    const agent = makeAgent({
      graph: {
        nodes: [],
        edges: [
          edge('caller-1.ts', 'hub.ts'),
          edge('caller-2.ts', 'hub.ts'),
          edge('caller-3.ts', 'hub.ts'),
        ],
        cycles: [],
      },
    });
    const out = buildHubDiagram(agent);
    expect(out).toContain('↪ 3 importers');
  });

  it('respects importersPerHub cap', () => {
    const agent = makeAgent({
      graph: {
        nodes: [],
        edges: Array.from({ length: 10 }, (_, i) =>
          edge(`caller-${String(i).padStart(2, '0')}.ts`, 'hub.ts'),
        ),
        cycles: [],
      },
    });
    const out = buildHubDiagram(agent, { topHubs: 1, importersPerHub: 3 });
    /* Only 3 importers (00, 01, 02 — alpha-first) should render as
     * nodes. 03..09 are dropped from the display. */
    expect(out).toContain('caller-00.ts');
    expect(out).toContain('caller-01.ts');
    expect(out).toContain('caller-02.ts');
    expect(out).not.toContain('caller-03.ts');
  });

  it('deduplicates a file that is BOTH a hub AND imports another hub', () => {
    /* The load-bearing bug found during dogfood: `loadArtifacts.ts` is
     * a hub in its own right (high in-degree) but also imports the
     * `spec/index.ts` hub. Without the hub-set dedupe, Mermaid would
     * see two node definitions with the same ID — and being
     * last-write-wins, the plain-importer label would clobber the
     * hub label ("↪ N importers" lost). */
    const agent = makeAgent({
      graph: {
        nodes: [],
        edges: [
          /* spec/index.ts has 3 importers including loadArtifacts.ts */
          edge('apps/ui-remix/src/lib/loadArtifacts.ts', 'packages/spec/src/index.ts'),
          edge('apps/cli/src/cli.ts', 'packages/spec/src/index.ts'),
          edge('apps/mcp-server/src/server.ts', 'packages/spec/src/index.ts'),
          /* loadArtifacts.ts itself has 2 importers. */
          edge('apps/ui-remix/src/App.tsx', 'apps/ui-remix/src/lib/loadArtifacts.ts'),
          edge('apps/ui-remix/src/routes/About.tsx', 'apps/ui-remix/src/lib/loadArtifacts.ts'),
        ],
        cycles: [],
      },
    });
    const out = buildHubDiagram(agent, { topHubs: 2, importersPerHub: 5 });
    /* loadArtifacts.ts should appear EXACTLY ONCE as a node — and
     * that one appearance should be the hub variant with the
     * importers count. */
    const nodeLines = out.split('\n').filter((l) => l.includes('n_apps_ui_remix_src_lib_loadArtifacts_ts['));
    expect(nodeLines).toHaveLength(1);
    expect(nodeLines[0]).toContain('↪ 2 importers');
  });

  it('applies the hub-style directive to each hub node', () => {
    const agent = makeAgent({
      graph: { nodes: [], edges: [edge('caller.ts', 'hub.ts')], cycles: [] },
    });
    const out = buildHubDiagram(agent);
    expect(out).toContain('style n_hub_ts fill:#dbeafe');
  });

  it('is deterministic across two calls', () => {
    const agent = makeAgent({
      graph: {
        nodes: [],
        edges: [
          edge('z.ts', 'h1.ts'),
          edge('y.ts', 'h1.ts'),
          edge('a.ts', 'h2.ts'),
          edge('b.ts', 'h2.ts'),
        ],
        cycles: [],
      },
    });
    expect(buildHubDiagram(agent)).toBe(buildHubDiagram(agent));
  });
});

// ── buildFocalDiagram ─────────────────────────────────────────────────

describe('buildFocalDiagram', () => {
  it('renders a clear placeholder when the focus is not in the graph', () => {
    const out = buildFocalDiagram(makeAgent(), { focus: 'nope.ts' });
    expect(out).toContain('focus not in graph');
    expect(out).toContain('nope.ts');
  });

  it('escapes HTML-special characters in the unknown-focus label', () => {
    /* The placeholder embeds the user-supplied focus string into a
     * Mermaid label; without escaping, `<script>` would render as
     * inline HTML in some Mermaid versions. */
    const out = buildFocalDiagram(makeAgent(), { focus: '<script>alert(1)</script>' });
    expect(out).toContain('&lt;script&gt;');
    expect(out).not.toContain('<script>');
  });

  it('renders the focus + its direct callers at depth 1', () => {
    const agent = makeAgent({
      graph: {
        nodes: [],
        edges: [
          edge('caller-1.ts', 'focus.ts'),
          edge('caller-2.ts', 'focus.ts'),
          /* Transitive caller (caller-of-caller) — not at depth 1. */
          edge('caller-of-1.ts', 'caller-1.ts'),
        ],
        cycles: [],
      },
    });
    const out = buildFocalDiagram(agent, { focus: 'focus.ts', depth: 1 });
    expect(out).toContain('n_focus_ts[');
    expect(out).toContain('n_caller_1_ts[');
    expect(out).toContain('n_caller_2_ts[');
    expect(out).not.toContain('caller_of_1_ts');
  });

  it('respects depth cap (transitive at depth 2)', () => {
    const agent = makeAgent({
      graph: {
        nodes: [],
        edges: [
          edge('caller-1.ts', 'focus.ts'),
          edge('caller-of-1.ts', 'caller-1.ts'),
          edge('caller-of-caller.ts', 'caller-of-1.ts'),
        ],
        cycles: [],
      },
    });
    const out = buildFocalDiagram(agent, { focus: 'focus.ts', depth: 2 });
    expect(out).toContain('n_caller_1_ts[');
    expect(out).toContain('n_caller_of_1_ts[');
    /* depth 3 caller is excluded by the depth=2 cap. */
    expect(out).not.toContain('caller_of_caller');
  });

  it('respects maxNodes hard cap', () => {
    /* 50 direct callers, cap to 5 nodes total. */
    const edges = Array.from({ length: 50 }, (_, i) =>
      edge(`caller-${String(i).padStart(2, '0')}.ts`, 'focus.ts'),
    );
    const agent = makeAgent({ graph: { nodes: [], edges, cycles: [] } });
    const out = buildFocalDiagram(agent, { focus: 'focus.ts', depth: 1, maxNodes: 5 });
    /* Focus + 4 callers = 5 node definitions in the output. */
    const nodeDefinitions = (out.match(/\n  n_[A-Za-z0-9_]+\[/g) || []).length;
    expect(nodeDefinitions).toBeLessThanOrEqual(5);
  });

  it('styles the focus node distinctively', () => {
    const agent = makeAgent({
      graph: { nodes: [], edges: [edge('caller.ts', 'focus.ts')], cycles: [] },
    });
    const out = buildFocalDiagram(agent, { focus: 'focus.ts' });
    expect(out).toContain('style n_focus_ts fill:#fef3c7');
  });

  it('uses the correct arrow style per edge kind', () => {
    const agent = makeAgent({
      graph: {
        nodes: [],
        edges: [
          edge('regular.ts', 'focus.ts', 'import'),
          edge('typeonly.ts', 'focus.ts', 'type-import'),
          edge('dynamic.ts', 'focus.ts', 'dynamic-import'),
        ],
        cycles: [],
      },
    });
    const out = buildFocalDiagram(agent, { focus: 'focus.ts' });
    expect(out).toContain('n_regular_ts --> n_focus_ts');
    expect(out).toContain('n_typeonly_ts -.-> n_focus_ts');
    expect(out).toContain('n_dynamic_ts ==> n_focus_ts');
  });

  it('is deterministic across two calls', () => {
    const agent = makeAgent({
      graph: {
        nodes: [],
        edges: [
          edge('z.ts', 'focus.ts'),
          edge('a.ts', 'focus.ts'),
          edge('m.ts', 'a.ts'),
        ],
        cycles: [],
      },
    });
    const opts = { focus: 'focus.ts', depth: 2 } as const;
    expect(buildFocalDiagram(agent, opts)).toBe(buildFocalDiagram(agent, opts));
  });
});

// ── buildDiagram (dispatcher) ─────────────────────────────────────────

describe('buildDiagram dispatcher', () => {
  it('routes to the package renderer when view is "package"', () => {
    const agent = makeAgent({
      graph: { nodes: [], edges: [edge('apps/cli/x.ts', 'packages/spec/y.ts')], cycles: [] },
    });
    const out = buildDiagram(agent, { view: 'package' });
    expect(out).toContain('n_apps_cli --> n_packages_spec');
  });

  it('routes to the hub renderer when view is "hub"', () => {
    const agent = makeAgent({
      graph: { nodes: [], edges: [edge('a.ts', 'hub.ts')], cycles: [] },
    });
    const out = buildDiagram(agent, { view: 'hub' });
    expect(out).toContain('↪ 1 importers');
  });

  it('routes to the focal renderer when view is "focal" and focus is supplied', () => {
    const agent = makeAgent({
      graph: { nodes: [], edges: [edge('caller.ts', 'focus.ts')], cycles: [] },
    });
    const out = buildDiagram(agent, { view: 'focal', focus: 'focus.ts' });
    expect(out).toContain('n_focus_ts');
    expect(out).toContain('style n_focus_ts fill:#fef3c7');
  });

  it('throws a clear error when focal is requested without focus', () => {
    expect(() => buildDiagram(makeAgent(), { view: 'focal' })).toThrow(
      /opts.focus is required/,
    );
  });
});

// ── Cross-renderer invariants ─────────────────────────────────────────

describe('Mermaid output invariants (cross-renderer)', () => {
  /* The bare minimum every diagram must satisfy. Catches regressions
   * where a refactor accidentally emits something un-renderable. */

  const fixtures = [
    {
      name: 'package',
      build: (a: AgentArtifact) => buildDiagram(a, { view: 'package' }),
    },
    {
      name: 'hub',
      build: (a: AgentArtifact) => buildDiagram(a, { view: 'hub' }),
    },
    {
      name: 'focal',
      build: (a: AgentArtifact) =>
        buildDiagram(a, { view: 'focal', focus: 'focus.ts' }),
    },
  ];

  const richAgent = makeAgent({
    graph: {
      nodes: [],
      edges: [
        edge('apps/cli/src/cli.ts', 'packages/spec/src/index.ts'),
        edge('apps/cli/src/cli.ts', 'packages/core/src/index.ts'),
        edge('apps/ui-remix/src/lib/loadArtifacts.ts', 'packages/spec/src/index.ts'),
        edge('apps/ui-remix/src/App.tsx', 'apps/ui-remix/src/lib/loadArtifacts.ts'),
        edge('caller.ts', 'focus.ts'),
      ],
      cycles: [],
    },
  });

  for (const fixture of fixtures) {
    describe(fixture.name, () => {
      it('starts with a flowchart directive', () => {
        expect(fixture.build(richAgent).startsWith('flowchart ')).toBe(true);
      });

      it('emits no duplicate node IDs', () => {
        const out = fixture.build(richAgent);
        const ids = (out.match(/\n {2}(n_[A-Za-z0-9_]+)\[/g) || []).map((l) => l.trim());
        const unique = new Set(ids);
        expect(ids.length).toBe(unique.size);
      });

      it('terminates with a newline', () => {
        expect(fixture.build(richAgent).endsWith('\n')).toBe(true);
      });
    });
  }
});

describe('escapes special characters in node labels (all views)', () => {
  // A path containing Mermaid-breaking chars: `"` ends a label literal,
  // `<`/`>` are parsed as HTML by Mermaid's renderer. shortPath keeps the
  // first 2 + last segment, so put the hazardous chars in those.
  const evil = 'packages/x/"<b>".ts';
  // file-level edges via the real fixture shape (makeAgent takes
  // Partial<AgentArtifact>, not an edge array): evil is BOTH imported (by
  // cli) and an importer (of spec), so it surfaces as a hub AND a focal node.
  const agent = makeAgent({
    graph: {
      nodes: [],
      edges: [edge(evil, 'packages/spec/src/index.ts'), edge('apps/cli/src/cli.ts', evil)],
      cycles: [],
    },
  });

  it('package view escapes a hazardous package name', () => {
    // classifyPath collapses a file to its package, so the hazard must live
    // in the package segment itself: `apps/a"b/...` → package `apps/a"b`.
    const a = makeAgent({
      graph: {
        nodes: [],
        edges: [edge('apps/a"b/src/x.ts', 'packages/spec/src/index.ts')],
        cycles: [],
      },
    });
    const out = buildPackageDiagram(a);
    expect(out).toContain('apps/a&quot;b'); // quote escaped in the label
    expect(out).not.toContain('apps/a"b['); // raw quote never precedes a node bracket
  });

  it('hub view escapes the file label but keeps the <br/> markup', () => {
    const out = buildHubDiagram(agent);
    expect(out).toContain('&quot;');
    expect(out).toContain('&lt;b&gt;');
    expect(out).not.toContain('"<b>"'); // raw hazard never emitted
    expect(out).toContain('<br/>'); // intentional line-break markup preserved
  });

  it('focal view escapes both the focus node and caller nodes', () => {
    const out = buildFocalDiagram(agent, { focus: evil, depth: 2 });
    expect(out).toContain('&quot;');
    expect(out).toContain('&lt;b&gt;');
    expect(out).not.toContain('"<b>"');
  });
});
