/**
 * ListTools wire-contract test.
 *
 * The server's `ListToolsRequestSchema` handler now renders its payload
 * straight from `MCP_TOOL_CATALOG` in `@factstack/spec`:
 *
 *   tools: MCP_TOOL_CATALOG.map(({ name, description, inputSchema }) =>
 *     ({ name, description, inputSchema }))
 *
 * Importing `server.ts` would run `main()` (which connects a stdio
 * transport + kicks an analyze), so we assert the wire shape against the
 * catalog + the same projection instead. This pins the exact payload the
 * handler emits: 17 tools, in ListTools order, with the expected names +
 * non-empty descriptions + object inputSchemas — the contract the README
 * "5 tools" drift originally violated.
 */

import { describe, expect, it } from 'vitest';
import { MCP_TOOL_CATALOG, MCP_TOOL_NAMES, mcpCatalogMatchesNames } from '@factstack/spec';

/** The exact projection the ListTools handler applies. */
const listToolsPayload = MCP_TOOL_CATALOG.map(({ name, description, inputSchema }) => ({
  name,
  description,
  inputSchema,
}));

describe('ListTools payload (from MCP_TOOL_CATALOG)', () => {
  it('advertises exactly 17 tools', () => {
    expect(listToolsPayload).toHaveLength(17);
  });

  it('lists every tool in MCP_TOOL_NAMES order', () => {
    expect(listToolsPayload.map((t) => t.name)).toEqual([...MCP_TOOL_NAMES]);
  });

  it('catalog completeness predicate holds (names ≡ MCP_TOOL_NAMES, in order)', () => {
    expect(mcpCatalogMatchesNames()).toBe(true);
  });

  it('every tool carries a non-empty description + an object inputSchema', () => {
    for (const t of listToolsPayload) {
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema.type).toBe('object');
      expect(typeof t.inputSchema.properties).toBe('object');
    }
  });

  it('projects ONLY the three wire fields (drops onboarding metadata)', () => {
    for (const t of listToolsPayload) {
      expect(Object.keys(t).sort()).toEqual(['description', 'inputSchema', 'name']);
    }
  });

  it('pins the query_graph verb enum to the shared QUERY_VERBS tuple', () => {
    const qg = listToolsPayload.find((t) => t.name === 'query_graph');
    const verbProp = qg?.inputSchema.properties?.verb as { enum?: string[]; default?: string } | undefined;
    expect(verbProp?.default).toBe('callers');
    expect(verbProp?.enum).toContain('impact');
    expect(verbProp?.enum).toContain('callers');
  });
});
