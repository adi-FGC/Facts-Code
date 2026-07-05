/**
 * `.well-known/mcp.json` renderer — a machine-readable manifest telling
 * an MCP-aware client how to launch the FACTS server + what it exposes.
 *
 * Not (yet) a ratified spec, so we emit a self-describing document: a
 * `$schema` pointer, the product identity, and an `mcp` block with the
 * stdio launch command + tool/resource counts + tool names. Deterministic
 * (2-space JSON, keys in a fixed order) so the drift guard can byte-compare.
 */

import type { SiteRegistry } from '@factstack/registry';
import type { SiteRenderer } from '../types.js';

export const mcpManifestRenderer: SiteRenderer = {
  id: 'mcp-manifest',
  render(reg: SiteRegistry): Record<string, string> {
    const manifest = {
      $schema: 'https://modelcontextprotocol.io/schema/mcp.json',
      name: 'factstack',
      version: reg.product.version,
      description: reg.product.description,
      mcp: {
        transport: 'stdio',
        // Honest: false until @factstack/mcp-server is on npm, so a client
        // doesn't blindly run an `npx` command that 404s.
        published: reg.mcp.published,
        launch: {
          command: reg.mcp.launchCommand.command,
          args: reg.mcp.launchCommand.args,
        },
        toolCount: reg.mcp.tools.length,
        resourceCount: reg.mcp.resources.length,
        toolNames: reg.mcp.tools.map((t) => t.name),
      },
      // Fetch-only path for browsing models that can't run a CLI/MCP client.
      data_endpoints: {
        summary: reg.data.summary,
        dataset: reg.data.dataset,
        pack: reg.data.pack,
      },
      documentation: '/llms-full.txt',
      generatedAt: reg.generatedAt,
    };
    return { '.well-known/mcp.json': JSON.stringify(manifest, null, 2) + '\n' };
  },
};
