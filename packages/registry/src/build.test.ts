/**
 * Tests for `buildSiteRegistry` — the aggregator IR builder.
 *
 * Locks the counts the discoverability artifacts depend on (17 tools,
 * 4 resources, 12 routes, a 6-step onboarding sequence) + the purity /
 * determinism contract (same `generatedAt` in → byte-identical out; no
 * clock read).
 */

import { describe, expect, it } from 'vitest';
import {
  CLI_NPM_PACKAGE,
  CLI_NPX,
  CLI_PUBLISHED,
  MCP_NPM_PACKAGE,
  MCP_NPX,
  MCP_PUBLISHED,
} from '@factstack/spec';
import { buildSiteRegistry } from './build.js';

const FIXED = { version: '1.2.3', generatedAt: '2026-07-04T00:00:00.000Z' };

describe('buildSiteRegistry', () => {
  it('lists all 17 MCP tools in ListTools order', () => {
    const reg = buildSiteRegistry(FIXED);
    expect(reg.mcp.tools).toHaveLength(17);
    expect(reg.mcp.tools[0]?.name).toBe('analyze');
    expect(reg.mcp.tools.at(-1)?.name).toBe('sync_pack');
  });

  it('carries the 4 concrete MCP resources', () => {
    const reg = buildSiteRegistry(FIXED);
    expect(reg.mcp.resources).toHaveLength(4);
    expect(reg.mcp.resources.map((r) => r.uri)).toEqual([
      'facts://project',
      'facts://graph',
      'facts://routes',
      'facts://risks',
    ]);
  });

  it('carries all 12 web routes in nav order', () => {
    const reg = buildSiteRegistry(FIXED);
    expect(reg.routes).toHaveLength(12);
    expect(reg.routes[0]).toEqual({ path: '/', label: 'Overview' });
    expect(reg.routes.at(-1)).toEqual({ path: '/about', label: 'About' });
  });

  it('derives a 6-step onboarding sequence sorted by onboardingOrder', () => {
    const reg = buildSiteRegistry(FIXED);
    expect(reg.mcp.onboardingSequence).toEqual([
      'read_memory',
      'analyze',
      'query_graph',
      'list_risks',
      'list_credentials',
      'list_vulnerabilities',
    ]);
  });

  it('threads version + generatedAt through without reading the clock', () => {
    const reg = buildSiteRegistry(FIXED);
    expect(reg.product.version).toBe('1.2.3');
    expect(reg.generatedAt).toBe('2026-07-04T00:00:00.000Z');
  });

  it('pins the CLI + MCP launch facts to the ONE npx pair in @factstack/spec', () => {
    const reg = buildSiteRegistry(FIXED);
    expect(reg.cli.publishedPackage).toBe(CLI_NPM_PACKAGE);
    expect(reg.cli.binName).toBe('factstack');
    expect(reg.cli.command).toBe(CLI_NPX);
    expect(reg.cli.command).toBe('npx factstack');
    expect(reg.mcp.publishedPackage).toBe(MCP_NPM_PACKAGE);
    expect(reg.mcp.binName).toBe('factstack-mcp');
    expect(reg.mcp.launchCommand).toEqual({ command: 'npx', args: ['-y', 'factstack-mcp'] });
    expect([reg.mcp.launchCommand.command, ...reg.mcp.launchCommand.args].join(' ')).toBe(MCP_NPX);
    /* Honest flags: the ONE per-package flag the owner flips on publish lives
       in spec and nothing mirrors it, so this holds before and after the flip
       (renderers test both states explicitly). The clone path works today. */
    expect(reg.cli.published).toBe(CLI_PUBLISHED);
    expect(reg.mcp.published).toBe(MCP_PUBLISHED);
    expect(reg.cli.cloneCommand).toBe('npx tsx apps/cli/src/cli.ts');
    expect(reg.mcp.cloneLaunchCommand).toEqual({
      command: 'npx',
      args: ['tsx', 'apps/mcp-server/src/server.ts'],
    });
    expect(JSON.stringify(reg)).not.toContain('@factstack/cli');
    expect(JSON.stringify(reg)).not.toContain('@factstack/mcp-server');
  });

  it('exposes both static hosts', () => {
    const reg = buildSiteRegistry(FIXED);
    expect(reg.hosts.netlify).toBe('https://factstack-demo.netlify.app');
    expect(reg.hosts.cloudflare).toBe('https://factstack.pages.dev');
  });

  it('is deterministic — same input yields byte-identical output', () => {
    const a = JSON.stringify(buildSiteRegistry(FIXED));
    const b = JSON.stringify(buildSiteRegistry(FIXED));
    expect(a).toBe(b);
  });
});
