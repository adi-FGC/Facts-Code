/**
 * `buildSiteRegistry` — the ONE place the discoverability IR is assembled.
 *
 * Pure + deterministic: it reads the three catalogs from `@factstack/spec`
 * (`MCP_TOOL_CATALOG`, `McpResourceCatalog`, `ROUTE_CATALOG`) and folds in
 * the fixed product / host / CLI / MCP facts. It never calls `Date.now()`
 * or `new Date()` — the build timestamp is passed in as `generatedAt` so
 * the same inputs always produce the same `SiteRegistry` (and thus
 * byte-identical rendered artifacts).
 */

import { MCP_TOOL_CATALOG, McpResourceCatalog, ROUTE_CATALOG } from '@factstack/spec';
import type { SiteRegistry, SiteResource, SiteRoute } from './types.js';

/** The two static hosts the same `apps/ui-remix/dist` is served from. */
const HOST_NETLIFY = 'https://factstack-demo.netlify.app';
const HOST_CLOUDFLARE = 'https://factstack.pages.dev';

export interface BuildSiteRegistryInput {
  /** Product version — usually the root/app package.json `version`. */
  version: string;
  /** ISO-8601 build timestamp. Threaded in so the builder is a pure fn. */
  generatedAt: string;
}

/**
 * Fold the spec catalogs + fixed facts into a `SiteRegistry`.
 *
 * `onboardingSequence` is derived (not hardcoded) from the tools that
 * carry an `onboardingOrder`, sorted ascending — so it always mirrors
 * the curated cold-start sequence encoded in `MCP_TOOL_CATALOG`.
 */
export function buildSiteRegistry(input: BuildSiteRegistryInput): SiteRegistry {
  const { version, generatedAt } = input;

  const resources: readonly SiteResource[] = McpResourceCatalog.map((r) => ({
    uri: r.uri,
    mimeType: r.mimeType,
    name: r.name,
    description: r.description,
  }));

  const routes: readonly SiteRoute[] = ROUTE_CATALOG.map((r) => ({
    path: r.path,
    label: r.label,
  }));

  /* Derive the onboarding sequence from the catalog's onboardingOrder,
     ascending. Sorting a filtered copy keeps MCP_TOOL_CATALOG's ListTools
     order untouched. */
  const onboardingSequence: readonly string[] = MCP_TOOL_CATALOG
    .filter((t) => t.onboardingOrder !== undefined)
    .slice()
    .sort((a, b) => (a.onboardingOrder ?? 0) - (b.onboardingOrder ?? 0))
    .map((t) => t.name);

  return {
    product: {
      name: 'FACTS',
      description:
        'FACTS turns any codebase into two artifacts from one analysis pass: an AI-agent-readable map and a CXO-readable dashboard — plus a live MCP surface for AI coding agents.',
      version,
      homepage: HOST_CLOUDFLARE,
    },
    hosts: {
      netlify: HOST_NETLIFY,
      cloudflare: HOST_CLOUDFLARE,
    },
    cli: {
      binName: 'factstack',
      publishedPackage: '@factstack/cli',
      command: 'npx -y @factstack/cli',
      // @factstack/cli is private:true / unpublished (404 on npm), and it
      // imports the whole unpublished @factstack/* workspace tree — so the
      // `npx` command does NOT work yet. Renderers gate the CTA on this.
      published: false,
    },
    mcp: {
      binName: 'factstack-mcp',
      publishedPackage: '@factstack/mcp-server',
      launchCommand: { command: 'npx', args: ['-y', '@factstack/mcp-server'] },
      tools: MCP_TOOL_CATALOG,
      resources,
      onboardingSequence,
      published: false, // @factstack/mcp-server is private:true / unpublished
    },
    routes,
    // Host-relative so they resolve against whichever origin served the file.
    data: {
      summary: '/data/summary.json',
      dataset: '/data/factstack.json',
      pack: '/factstack.pack',
    },
    generatedAt,
  };
}
