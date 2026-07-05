/**
 * `llms.txt` + `llms-full.txt` renderer (llmstxt.org convention).
 *
 * `llms.txt` is the concise entry point an LLM agent reads first:
 * an H1, a `>` blockquote summary, then a few `##` sections of markdown
 * links + one-liners on how to use FACTS from a terminal or an MCP client.
 *
 * `llms-full.txt` is the verbose companion: one section per MCP tool
 * (name + description + input shape), the resources, and the full route
 * list — everything an agent needs to drive FACTS without a round-trip.
 */

import type { SiteRegistry } from '@factstack/registry';
import type { McpToolMeta } from '@factstack/spec';
import type { SiteRenderer } from '../types.js';

/** Human-readable one-line summary of a tool's input shape, e.g.
 *  `{ path (required), format }`. Pure string derivation from the JSON
 *  Schema the catalog carries. */
function inputShape(tool: McpToolMeta): string {
  const props = Object.keys(tool.inputSchema.properties ?? {});
  if (props.length === 0) return '(no arguments)';
  const required = new Set(tool.inputSchema.required ?? []);
  return props.map((p) => (required.has(p) ? `${p} (required)` : p)).join(', ');
}

/** `npx ...` string for the MCP launch command. */
function mcpCmd(reg: SiteRegistry): string {
  return [reg.mcp.launchCommand.command, ...reg.mcp.launchCommand.args].join(' ');
}

function renderLlmsTxt(reg: SiteRegistry): string {
  const lines: string[] = [];
  lines.push(`# ${reg.product.name}`);
  lines.push('');
  lines.push(`> ${reg.product.description}`);
  lines.push('');

  // Lead with the path a plain, browsing chatbot can ACTUALLY use — a URL fetch,
  // no CLI, no MCP. Links are host-relative so they resolve against whichever
  // origin served this file (Netlify or Cloudflare).
  lines.push('## Fetch the analysis (works in any chat, no install)');
  lines.push('');
  lines.push(`- [${reg.data.summary}](${reg.data.summary}) — start here: a few-KB digest (project, stack, health grade, top risks, entry points, counts).`);
  lines.push(`- [${reg.data.dataset}](${reg.data.dataset}) — the complete analysis (~2 MB JSON): dependency graph, routes, risks, docs, history.`);
  lines.push(`- [${reg.data.pack}](${reg.data.pack}) — the same data as a compact line-oriented pack (~80% smaller than the JSON).`);
  lines.push('');

  lines.push('## Drive it from a coding agent (CLI + MCP)');
  lines.push('');
  if (reg.cli.published || reg.mcp.published) {
    lines.push(`- **CLI**: \`${reg.cli.command}\` — the \`${reg.cli.binName}\` binary (analyze · ui · query · export).`);
    lines.push(`- **MCP server**: \`${mcpCmd(reg)}\` — the \`${reg.mcp.binName}\` stdio server exposing ${reg.mcp.tools.length} tools + ${reg.mcp.resources.length} resources.`);
  } else {
    // Honest gating: the packages are NOT on npm yet, so don't hand a chatbot a
    // command that 404s. State the pending npm path + the working clone path.
    lines.push(`- The \`${reg.cli.publishedPackage}\` CLI and \`${reg.mcp.publishedPackage}\` MCP server are **not on npm yet**. When published: \`${reg.cli.command}\` and \`${mcpCmd(reg)}\` (${reg.mcp.tools.length} tools + ${reg.mcp.resources.length} resources).`);
    lines.push(`- Today, run them from a clone of the repo: \`npx tsx apps/cli/src/cli.ts\` and \`npx tsx apps/mcp-server/src/server.ts\`.`);
  }
  if (reg.mcp.onboardingSequence.length) {
    lines.push(`- **First-contact tool order**: ` + reg.mcp.onboardingSequence.map((n) => `\`${n}\``).join(' → ') + '.');
  }
  lines.push('');

  lines.push('## More');
  lines.push('');
  lines.push('- [/llms-full.txt](/llms-full.txt) — full tool + resource reference.');
  lines.push('- [/.well-known/mcp.json](/.well-known/mcp.json) — machine-readable MCP manifest.');
  lines.push('- [Dashboard](/) — interactive browser UI (requires JavaScript; use the fetch endpoints above for data).');
  lines.push('');

  return lines.join('\n');
}

function renderLlmsFullTxt(reg: SiteRegistry): string {
  const lines: string[] = [];
  lines.push(`# ${reg.product.name} — full reference`);
  lines.push('');
  lines.push(`> ${reg.product.description}`);
  lines.push('');
  lines.push(`Version ${reg.product.version} · generated ${reg.generatedAt}`);
  lines.push('');

  lines.push('## Fetch the analysis (no install, works in any chat)');
  lines.push('');
  lines.push(`- ${reg.data.summary} — small digest (project, stack, health, top risks, entry points, counts).`);
  lines.push(`- ${reg.data.dataset} — the complete analysis (~2 MB JSON). Top-level keys: project, summary, stats, tree, edges, cycles, nodeMetrics, entryPoints, routes, risks, config, dependencyManifests, vulnerabilities, docs, styles, history.`);
  lines.push(`- ${reg.data.pack} — the same analysis as a compact line-oriented pack.`);
  lines.push('');

  lines.push('## Connect a coding agent (CLI + MCP)');
  lines.push('');
  if (reg.cli.published || reg.mcp.published) {
    lines.push(`- CLI: \`${reg.cli.command}\` (published as \`${reg.cli.publishedPackage}\`)`);
    lines.push(`- MCP (stdio): \`${mcpCmd(reg)}\` (published as \`${reg.mcp.publishedPackage}\`)`);
  } else {
    lines.push(`- \`${reg.cli.publishedPackage}\` (CLI) and \`${reg.mcp.publishedPackage}\` (MCP server) are NOT yet on npm. When published: \`${reg.cli.command}\` and \`${mcpCmd(reg)}\`.`);
    lines.push(`- Today, run from a repo clone: \`npx tsx apps/cli/src/cli.ts\` (CLI) and \`npx tsx apps/mcp-server/src/server.ts\` (MCP stdio).`);
  }
  lines.push('');

  lines.push(`## MCP tools (${reg.mcp.tools.length})`);
  lines.push('');
  for (const tool of reg.mcp.tools) {
    lines.push(`### ${tool.name}`);
    lines.push('');
    lines.push(tool.description);
    lines.push('');
    lines.push(`- Input: ${inputShape(tool)}`);
    if (tool.onboardingOrder !== undefined) {
      lines.push(`- Onboarding step ${tool.onboardingOrder}${tool.onboardingNote ? ` — ${tool.onboardingNote}` : ''}`);
    }
    lines.push('');
  }

  lines.push(`## MCP resources (${reg.mcp.resources.length})`);
  lines.push('');
  for (const r of reg.mcp.resources) {
    lines.push(`- \`${r.uri}\` (${r.mimeType}) — ${r.name}: ${r.description}`);
  }
  lines.push('');

  lines.push(`## Web routes (${reg.routes.length}) — browser UI, JavaScript required`);
  lines.push('');
  lines.push('These are client-rendered SPA pages: a raw fetch of any of them returns the same JS shell, not readable content. For DATA, use the fetch endpoints at the top of this file.');
  lines.push('');
  for (const route of reg.routes) {
    lines.push(`- ${route.label}: ${route.path}`);
  }
  lines.push('');

  return lines.join('\n');
}

export const llmsTxtRenderer: SiteRenderer = {
  id: 'llms-txt',
  render(reg: SiteRegistry): Record<string, string> {
    return {
      'llms.txt': renderLlmsTxt(reg),
      'llms-full.txt': renderLlmsFullTxt(reg),
    };
  },
};
