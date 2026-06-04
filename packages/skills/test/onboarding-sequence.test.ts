/**
 * Drift guard: ONBOARDING_SEQUENCE must reference only tools the FACTS
 * MCP server actually ships.
 *
 * The real enforcement is at compile time — ONBOARDING_SEQUENCE is typed
 * `readonly ShippedMcpToolName[]` (see types.ts), and that union derives
 * from `MCP_TOOL_NAMES` in @factstack/spec, which the server binds to via
 * `MCP_TOOL.<name>`. So a renamed/removed/typo'd tool name fails `tsc`
 * before these tests ever run.
 *
 * These runtime checks exist to (a) document the invariant in an
 * executable place, (b) catch the cases the type system can't express —
 * duplicates and an empty list — and (c) pin the ordering the renderers
 * lean on (every renderer leads with `read_memory`, the cold-start brief).
 */

import { describe, expect, it } from 'vitest';
import { MCP_TOOL_NAMES } from '@factstack/spec';
import { ONBOARDING_SEQUENCE } from '../src/index.js';

describe('ONBOARDING_SEQUENCE', () => {
  it('references only tools the FACTS MCP server ships', () => {
    const shipped = new Set<string>(MCP_TOOL_NAMES);
    const unknown = ONBOARDING_SEQUENCE.filter((tool) => !shipped.has(tool));
    /* If this fails, a tool was renamed/removed in @factstack/spec's
       MCP_TOOL_NAMES but ONBOARDING_SEQUENCE (or a renderer's prose)
       still points at the old name. */
    expect(unknown).toEqual([]);
  });

  it('is non-empty — the renderers build their "preparation" section from it', () => {
    expect(ONBOARDING_SEQUENCE.length).toBeGreaterThan(0);
  });

  it('contains no duplicates', () => {
    expect(new Set(ONBOARDING_SEQUENCE).size).toBe(ONBOARDING_SEQUENCE.length);
  });

  it('leads with read_memory — the cheapest cold-start call', () => {
    /* Claude SKILL.md, AGENTS.md, .cursorrules + Copilot all instruct the
       agent to call these in order. read_memory must come first: it's the
       2-10 KB brief that replaces a 40-200 KB cold read of agent.json. */
    expect(ONBOARDING_SEQUENCE[0]).toBe('read_memory');
  });
});
