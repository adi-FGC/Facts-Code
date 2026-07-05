/**
 * `SiteRegistry` — the aggregator IR that every discoverability artifact
 * is rendered from.
 *
 * One pure `buildSiteRegistry()` (see `./build.ts`) folds three catalogs
 * already exported by `@factstack/spec` — `MCP_TOOL_CATALOG`,
 * `McpResourceCatalog`, `ROUTE_CATALOG` — plus a handful of fixed
 * product/host/CLI/MCP facts into this shape. `@factstack/site-kit`'s
 * renderers then consume ONLY this IR, so adding a new artifact
 * (llms.txt, .well-known/mcp.json, sitemap.xml, …) is one renderer file
 * that reads from here — never a second copy of the tool list.
 *
 * Isomorphic + deterministic: no `node:*`, no DOM, and no clock reads.
 * `generatedAt` is threaded in by the caller so the same inputs always
 * produce byte-identical output (mirrors `SkillSpec`'s `generatedAt`
 * contract in @factstack/skills).
 */

import type { McpToolMeta } from '@factstack/spec';

/** One MCP resource as the registry carries it — the concrete-resource
 *  shape from `McpResourceCatalog` (the parametric `file` resource is a
 *  template advertised separately by the server, not listed here). */
export interface SiteResource {
  uri: string;
  mimeType: string;
  name: string;
  description: string;
}

/** One page in the web app: the pure label+path pair from ROUTE_CATALOG. */
export interface SiteRoute {
  path: string;
  label: string;
}

/** How an agent launches the MCP server over stdio. */
export interface McpLaunchCommand {
  command: string;
  args: string[];
}

/**
 * The complete, render-ready description of the deployed FACTS site +
 * its CLI/MCP entry points. Built once per deploy from the spec catalogs.
 */
export interface SiteRegistry {
  /** Product identity. */
  product: {
    name: string;
    description: string;
    version: string;
    homepage: string;
  };
  /** The two static hosts the same `dist/` is served from, byte-identical. */
  hosts: {
    netlify: string;
    cloudflare: string;
  };
  /** How to reach FACTS from a terminal. */
  cli: {
    binName: string;
    publishedPackage: string;
    /** Ready-to-paste one-liner (e.g. `npx -y @factstack/cli`). */
    command: string;
    /** Whether `publishedPackage` actually exists on npm yet. Renderers gate
     *  the `npx` call-to-action on this so the site never advertises a 404. */
    published: boolean;
  };
  /** How to reach FACTS from an MCP-speaking agent. */
  mcp: {
    binName: string;
    publishedPackage: string;
    launchCommand: McpLaunchCommand;
    /** Every shipped tool, in ListTools order (from MCP_TOOL_CATALOG). */
    tools: readonly McpToolMeta[];
    /** Concrete MCP resources (from McpResourceCatalog). */
    resources: readonly SiteResource[];
    /** Curated cold-start tool sequence, tool names in onboardingOrder. */
    onboardingSequence: readonly string[];
    /** Whether `publishedPackage` actually exists on npm yet. */
    published: boolean;
  };
  /** Every page in the web app (from ROUTE_CATALOG), in nav order. */
  routes: readonly SiteRoute[];
  /** Fetch-only data endpoints (host-relative) — the path a plain, browsing
   *  AI chat uses to consume FACTS with NO CLI and NO MCP client. */
  data: {
    /** Small (~KB) digest: project, stack, health, top risks, entry points. */
    summary: string;
    /** The complete analysis (~2 MB JSON). */
    dataset: string;
    /** The same analysis as a compact line-oriented pack (~80% smaller). */
    pack: string;
  };
  /** ISO-8601 build timestamp. Passed in by the caller — NEVER read from
   *  the clock inside the builder, so output stays deterministic. */
  generatedAt: string;
}
