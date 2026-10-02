/**
 * MCP_TOOL_CATALOG — the single source of truth for the MCP tool surface.
 *
 * These lock the completeness + onboarding invariants the discoverability
 * artifacts (and the drift-prone README) depend on: 17 tools listed in
 * MCP_TOOL_NAMES order, exactly 6 onboarding tools with the curated 1..6
 * ordering, and no onboarding metadata on the other 11.
 */

import { describe, expect, it } from 'vitest';
import { MAX_GLOB_LENGTH, MCP_TOOL_NAMES } from '../src/mcp.js';
import { MCP_TOOL_CATALOG, mcpCatalogMatchesNames } from '../src/mcp-catalog.js';
import { RiskSchema } from '../src/agent.js';

describe('MCP_TOOL_CATALOG', () => {
  it('lists all 17 tools in MCP_TOOL_NAMES order', () => {
    expect(MCP_TOOL_CATALOG).toHaveLength(17);
    expect(MCP_TOOL_CATALOG.map((t) => t.name)).toEqual([...MCP_TOOL_NAMES]);
  });

  it('mcpCatalogMatchesNames() confirms the runtime completeness check', () => {
    expect(mcpCatalogMatchesNames()).toBe(true);
  });

  it('every entry has a non-empty description + object inputSchema', () => {
    for (const t of MCP_TOOL_CATALOG) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema.type).toBe('object');
      expect(t.inputSchema.properties).toBeTypeOf('object');
    }
  });

  it('marks exactly the 6 onboarding tools with orders 1..6', () => {
    const onboarding = MCP_TOOL_CATALOG.filter((t) => t.onboardingOrder !== undefined);
    expect(onboarding).toHaveLength(6);
    // orders form the set {1,2,3,4,5,6}
    expect(onboarding.map((t) => t.onboardingOrder).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    // the curated sequence, sorted by order, matches the skills ONBOARDING_SEQUENCE
    const seq = onboarding
      .slice()
      .sort((a, b) => (a.onboardingOrder ?? 0) - (b.onboardingOrder ?? 0))
      .map((t) => t.name);
    expect(seq).toEqual([
      'read_memory',
      'analyze',
      'query_graph',
      'list_risks',
      'list_credentials',
      'list_vulnerabilities',
    ]);
  });

  /** The schema a client sees for one tool. */
  const props = (name: string): Record<string, Record<string, unknown>> =>
    MCP_TOOL_CATALOG.find((t) => t.name === name)!.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
  const describes = (name: string): string =>
    MCP_TOOL_CATALOG.find((t) => t.name === name)!.description;

  it('advertises what the server honours: analyze.symbols, the parse-cache useCache', () => {
    expect(props('analyze').symbols).toMatchObject({ type: 'boolean' });
    expect(String(props('analyze').useCache!.description)).toMatch(/parse cache/);
    expect(String(props('analyze').useCache!.description)).not.toMatch(/cached result/i);
  });

  it('since / review_change name the real baseline, not the snapshot dir', () => {
    for (const tool of ['since', 'review_change']) {
      expect(describes(tool)).toContain('.facts/baseline/agent.json');
      expect(describes(tool)).not.toMatch(/snapshots\//);
    }
    expect(describes('review_change')).toContain('{ok:false}');
  });

  it('query_learnings.limit is an integer from 1 to 5000 (what the server validates)', () => {
    expect(props('query_learnings').limit).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 5000,
    });
  });

  it('list_risks offers every risk category the artifact can carry (incl. read-error)', () => {
    expect(props('list_risks').category!.enum).toEqual([...RiskSchema.shape.category.options]);
  });

  it('caps query_graph.filter like the zod input schema does', () => {
    expect(props('query_graph').filter).toMatchObject({ maxLength: MAX_GLOB_LENGTH });
  });

  it('leaves onboardingOrder undefined on the other 11 tools', () => {
    const nonOnboarding = MCP_TOOL_CATALOG.filter((t) => t.onboardingOrder === undefined);
    expect(nonOnboarding).toHaveLength(11);
    for (const t of nonOnboarding) {
      expect(t.onboardingNote).toBeUndefined();
    }
  });
});
