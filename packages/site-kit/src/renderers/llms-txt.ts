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

/** The MCP launch that works from a clone today. */
function mcpCloneCmd(reg: SiteRegistry): string {
  return [reg.mcp.cloneLaunchCommand.command, ...reg.mcp.cloneLaunchCommand.args].join(' ');
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
  lines.push(
    `- [${reg.data.summary}](${reg.data.summary}) — start here: a few-KB digest (project, stack, health grade, top risks, entry points, counts).`,
  );
  lines.push(
    `- [${reg.data.dataset}](${reg.data.dataset}) — the complete analysis (~2 MB JSON): dependency graph, routes, risks, docs, history.`,
  );
  lines.push(
    `- [${reg.data.pack}](${reg.data.pack}) — the same data as a compact line-oriented pack (~80% smaller than the JSON).`,
  );
  lines.push('');

  lines.push('## Drive it from a coding agent (CLI + MCP)');
  lines.push('');
  /* Honest gating, PER PACKAGE: a name not on npm yet is never handed to a
     chatbot as a working command (it 404s, or runs whoever claims the name).
     It gets the pending name + the clone command that works today. Each line
     reads its own flag, so publishing the MCP server first does not
     advertise the CLI. */
  const counts = `${reg.mcp.tools.length} tools + ${reg.mcp.resources.length} resources`;
  lines.push(
    reg.cli.published
      ? `- **CLI**: \`${reg.cli.command}\` — the \`${reg.cli.binName}\` binary (analyze · ui · query · export).`
      : `- **CLI**: \`${reg.cli.publishedPackage}\` is **not on npm yet** (when published: \`${reg.cli.command}\`). Today, from a clone of the repo: \`${reg.cli.cloneCommand}\` (analyze · ui · query · export).`,
  );
  lines.push(
    reg.mcp.published
      ? `- **MCP server**: \`${mcpCmd(reg)}\` — the \`${reg.mcp.binName}\` stdio server exposing ${counts}.`
      : `- **MCP server**: \`${reg.mcp.publishedPackage}\` is **not on npm yet** (when published: \`${mcpCmd(reg)}\`). Today, from a clone of the repo: \`${mcpCloneCmd(reg)}\` (${counts}).`,
  );
  if (reg.mcp.onboardingSequence.length) {
    lines.push(
      `- **First-contact tool order**: ` +
        reg.mcp.onboardingSequence.map((n) => `\`${n}\``).join(' → ') +
        '.',
    );
  }
  lines.push('');

  lines.push('## More');
  lines.push('');
  lines.push('- [/llms-full.txt](/llms-full.txt) — full tool + resource reference.');
  lines.push('- [/.well-known/mcp.json](/.well-known/mcp.json) — machine-readable MCP manifest.');
  lines.push(
    '- [Dashboard](/) — interactive browser UI (requires JavaScript; use the fetch endpoints above for data).',
  );
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
  lines.push(
    `- ${reg.data.summary} — small digest (project, stack, health, top risks, entry points, counts).`,
  );
  lines.push(
    `- ${reg.data.dataset} — the complete analysis (~2 MB JSON). Top-level keys: project, summary, stats, tree, edges, cycles, nodeMetrics, entryPoints, routes, risks, config, dependencyManifests, vulnerabilities, docs, styles, history.`,
  );
  lines.push(`- ${reg.data.pack} — the same analysis as a compact line-oriented pack.`);
  lines.push('');

  lines.push('## Connect a coding agent (CLI + MCP)');
  lines.push('');
  // Gated per package, as in llms.txt.
  lines.push(
    reg.cli.published
      ? `- CLI: \`${reg.cli.command}\` (published as \`${reg.cli.publishedPackage}\`)`
      : `- CLI: \`${reg.cli.publishedPackage}\` is NOT yet on npm (when published: \`${reg.cli.command}\`). Today, from a repo clone: \`${reg.cli.cloneCommand}\`.`,
  );
  lines.push(
    reg.mcp.published
      ? `- MCP (stdio): \`${mcpCmd(reg)}\` (published as \`${reg.mcp.publishedPackage}\`)`
      : `- MCP (stdio): \`${reg.mcp.publishedPackage}\` is NOT yet on npm (when published: \`${mcpCmd(reg)}\`). Today, from a repo clone: \`${mcpCloneCmd(reg)}\`.`,
  );
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
      lines.push(
        `- Onboarding step ${tool.onboardingOrder}${tool.onboardingNote ? ` — ${tool.onboardingNote}` : ''}`,
      );
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
  lines.push(
    'These are client-rendered SPA pages: a raw fetch of any of them returns the same JS shell, not readable content. For DATA, use the fetch endpoints at the top of this file.',
  );
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
