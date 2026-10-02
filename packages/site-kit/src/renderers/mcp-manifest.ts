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
        // Honest: false until the npm package is published.
        published: reg.mcp.published,
        package: reg.mcp.publishedPackage,
        /* `published` is non-standard and a client may ignore it, so an
           unpublished server gets NO runnable `launch` — an auto-launching
           client must never `npx -y` a package that isn't on npm (security#5).
           Until then: the stdio launch that works from a clone of the repo. */
        ...(reg.mcp.published
          ? {
              launch: {
                command: reg.mcp.launchCommand.command,
                args: reg.mcp.launchCommand.args,
              },
            }
          : {
              launchFromClone: {
                command: reg.mcp.cloneLaunchCommand.command,
                args: reg.mcp.cloneLaunchCommand.args,
                note: 'Run inside a clone of the FACTS repository; add --root <project dir>.',
              },
            }),
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
