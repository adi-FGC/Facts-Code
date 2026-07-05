/**
 * MCP_TOOL_CATALOG — the single source of truth for the MCP tool surface.
 *
 * These lock the completeness + onboarding invariants the discoverability
 * artifacts (and the drift-prone README) depend on: 17 tools listed in
 * MCP_TOOL_NAMES order, exactly 6 onboarding tools with the curated 1..6
 * ordering, and no onboarding metadata on the other 11.
 */

import { describe, expect, it } from 'vitest';
import { MCP_TOOL_NAMES } from '../src/mcp.js';
import { MCP_TOOL_CATALOG, mcpCatalogMatchesNames } from '../src/mcp-catalog.js';

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
    expect(onboarding.map((t) => t.onboardingOrder).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1, 2, 3, 4, 5, 6]);
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

  it('leaves onboardingOrder undefined on the other 11 tools', () => {
    const nonOnboarding = MCP_TOOL_CATALOG.filter((t) => t.onboardingOrder === undefined);
    expect(nonOnboarding).toHaveLength(11);
    for (const t of nonOnboarding) {
      expect(t.onboardingNote).toBeUndefined();
    }
  });
});
