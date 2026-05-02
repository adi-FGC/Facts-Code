/**
 * @factstack/intent — deterministic intent generator.
 *
 * Composes signals already detected by the analyzer (frameworks,
 * routes, capabilities, monorepo shape, sub-apps under `apps/`) into
 * a single CXO-readable sentence describing what the project IS.
 *
 * Examples:
 *   - "A pnpm monorepo containing a CLI, an MCP server, and a Remix dashboard."
 *   - "A FastAPI service with 12 routes."
 *   - "A Vite-built React UI."
 *   - "A Node CLI tool."
 *   - null when no signal is strong enough (caller falls through to
 *     human.summary.oneLiner / README.md)
 *
 * Pure / isomorphic: no LLM, no Date, no I/O, no Node imports.
 * Determinism is enforced by the test suite — same input MUST yield
 * byte-identical output.
 *
 * v0.3.10 ships the deterministic core. Richer narrative generation
 * (capability prose, decision archaeology, user-flow inference) is
 * v0.4 scope and lives in its own functions in this same package.
 */

import type { AgentArtifact, HumanArtifact } from '@factstack/spec';

/** The set of frameworks that imply "this serves an HTTP API". */
const SERVER_FRAMEWORKS = new Set([
  'Express', 'Hono', 'Koa', 'Fastify', 'NestJS',
  'FastAPI', 'Django', 'Flask',
]);

/** Frameworks that imply "this renders a React-shaped UI." */
const REACT_FRAMEWORKS = new Set(['React', 'Next.js', 'Remix', 'Gatsby']);

/** Other UI frameworks worth naming. */
const UI_FRAMEWORKS = new Set(['Vue', 'Svelte', 'Solid', 'Astro', 'Lit']);

/** Build-tool frameworks that, combined with a UI framework, produce
 *  the "<tool>-built X UI" phrasing. */
const BUILD_FRAMEWORKS = new Set(['Vite', 'Webpack', 'Parcel', 'Rollup', 'esbuild', 'Turbopack']);

/**
 * Top-level entry point — returns the intent sentence or `null`.
 */
export function inferIntent(agent: AgentArtifact, human: HumanArtifact): string | null {
  const monorepo = agent.project.monorepo;
  if (monorepo) {
    return monorepoIntent(agent, human, monorepo.manager);
  }
  return singleAppIntent(agent, human);
}

/* ───────────────────────────────────────────────────────────────────
 * Monorepo path: enumerate sub-apps under `apps/` and name each.
 * Falls back to single-app intent when nothing recognizable lives
 * under apps/.
 * ─────────────────────────────────────────────────────────────── */

function monorepoIntent(agent: AgentArtifact, human: HumanArtifact, manager: string): string | null {
  const subApps = enumerateSubApps(agent);
  if (subApps.length > 0) {
    /* "A pnpm monorepo containing a CLI, an MCP server, and a
       Remix dashboard." — the prefix names the manager + monorepo
       shape; the tail is the comma-list of sub-apps. */
    return `A ${manager} monorepo containing ${joinList(subApps)}.`;
  }
  /* Monorepo with no recognizable apps/ — fall back to single-app
     framework detection but keep the manager prefix so a CXO at
     least knows the topology. */
  const single = singleAppIntent(agent, human);
  if (single) {
    // Convert "A X" → "A pnpm monorepo with X" by lowercasing the
    // first letter and prepending.
    const tail = single.replace(/^A\s+/i, '').replace(/\.$/, '');
    return `A ${manager} monorepo with ${lowerFirst(tail)}.`;
  }
  return null;
}

/**
 * Walk `apps/*` directories visible in the file list, infer each app's
 * kind from its path + manifest data, and produce a labeled list.
 *
 * Heuristics (deterministic, pure-pattern):
 *   - apps/cli           → "a CLI"
 *   - apps/*-cli         → "a <name> CLI"
 *   - apps/mcp-server    → "an MCP server"
 *   - apps/ui-* / apps/web / apps/dashboard → "a React dashboard"
 *     when React/Remix/etc detected
 *   - apps/api / apps/server → "an HTTP API"
 *   - apps/extension / *-ext → "a browser extension"
 */
function enumerateSubApps(agent: AgentArtifact): string[] {
  const appDirs = new Set<string>();
  for (const f of agent.files) {
    const m = /^apps\/([^/]+)\//.exec(f.path);
    if (m && m[1]) appDirs.add(m[1]);
  }
  /* Stable sort for deterministic output. Dedupe by label so two
     directories that map to the same kind (e.g. `chrome-ext` +
     `firefox-ext` both → "a browser extension") only emit it once. */
  const out: string[] = [];
  const seenLabels = new Set<string>();
  for (const dir of Array.from(appDirs).sort()) {
    const label = labelForAppDir(dir, agent);
    if (label && !seenLabels.has(label)) {
      seenLabels.add(label);
      out.push(label);
    }
  }
  return out;
}

function labelForAppDir(dir: string, agent: AgentArtifact): string | null {
  const lower = dir.toLowerCase();
  if (lower === 'cli') return 'a CLI';
  if (/-cli$/.test(lower)) {
    const stem = dir.slice(0, -'-cli'.length);
    return `a ${stem} CLI`;
  }
  if (lower === 'mcp-server' || lower.endsWith('-mcp')) return 'an MCP server';
  /* VS Code / IDE extensions FIRST so vscode-ext doesn't get
     captured by the generic `-ext$` pattern below. */
  if (lower === 'vscode-ext' || /^vscode[-_]/.test(lower)) return 'a VS Code extension';
  if (lower === 'chrome-ext' || /^chrome[-_]/.test(lower)) return 'a browser extension';
  if (lower === 'extension' || /-ext$/.test(lower)) return 'a browser extension';
  if (lower === 'web' || lower === 'webui' || lower === 'webapp' ||
      lower === 'dashboard' || /^ui[-_]/.test(lower)) {
    /* Name the UI framework when one is detected. */
    const fw = findFirst(agent.project.frameworks, [
      'Remix', 'Next.js', 'Gatsby', 'Astro', 'Vue', 'Svelte', 'Solid', 'React',
    ]);
    if (fw) return `a ${fw} dashboard`;
    return 'a web UI';
  }
  if (lower === 'api' || lower === 'server' || /-api$/.test(lower) || /-server$/.test(lower)) {
    return 'an HTTP API';
  }
  /* Unknown app dir — skip rather than generate bad labels like
     "an webapp app". The intent generator's job is to be honest;
     when a directory's purpose isn't clear from naming heuristics,
     omit it instead of inventing a label. */
  return null;
}

/* ───────────────────────────────────────────────────────────────────
 * Single-app path: figure out what this is from frameworks, routes,
 * and capability hints.
 * ─────────────────────────────────────────────────────────────── */

function singleAppIntent(agent: AgentArtifact, human: HumanArtifact): string | null {
  const fwks = agent.project.frameworks;

  /* Strongest signals first. The test suite pins each branch so any
     drift in detection rules is caught. */

  // Pure FastAPI / Django / Flask service — Python web frameworks
  // get an explicit named branch because routes are how a CXO
  // verifies "this is an API."
  for (const py of ['FastAPI', 'Django', 'Flask']) {
    if (fwks.includes(py)) {
      const tail = agent.routes.length > 0
        ? ` with ${agent.routes.length} route${agent.routes.length === 1 ? '' : 's'}`
        : '';
      const noun = py === 'Django' ? 'web app' : 'service';
      return `A ${py} ${noun}${tail}.`;
    }
  }

  // JS/TS server framework
  const jsServer = findFirst(fwks, ['Next.js', 'Remix', 'NestJS', 'Express', 'Hono', 'Koa', 'Fastify']);
  if (jsServer && agent.routes.length > 0) {
    return `A ${jsServer} application with ${agent.routes.length} route${agent.routes.length === 1 ? '' : 's'}.`;
  }

  // Pure UI: React/Vue/etc + a build tool
  const reactFw = findFirst(fwks, Array.from(REACT_FRAMEWORKS));
  const otherUi = findFirst(fwks, Array.from(UI_FRAMEWORKS));
  const buildFw = findFirst(fwks, Array.from(BUILD_FRAMEWORKS));
  const uiFw = reactFw ?? otherUi;
  if (uiFw) {
    if (buildFw) return `A ${buildFw}-built ${uiFw} UI.`;
    return `A ${uiFw} UI.`;
  }

  // CLI-only (no frameworks but a cli.ts file)
  if (hasCliFile(agent)) {
    return 'A Node CLI tool.';
  }

  /* Last fallback intentionally returns null — a generic "A
     TypeScript project." or "A Python project." is too vague to
     justify the dashboard's headline real estate. The caller should
     fall through to human.summary.oneLiner (README first paragraph),
     which carries author voice. */
  return null;
}

/* ───────────────────────────────────────────────────────────────────
 * Helpers
 * ─────────────────────────────────────────────────────────────── */

/** Find the first item from `candidates` that appears in `haystack`,
 *  preserving the candidate's casing. Stable for deterministic output. */
function findFirst(haystack: string[], candidates: string[]): string | null {
  const set = new Set(haystack);
  for (const c of candidates) if (set.has(c)) return c;
  return null;
}

/** True when the project has a recognizable CLI entry (apps/cli/ or
 *  a top-level cli.ts/js file). Heuristic — fine for the v0.3.10
 *  intent generator. */
function hasCliFile(agent: AgentArtifact): boolean {
  for (const f of agent.files) {
    if (/(^|\/)cli\.(ts|js|mjs)$/.test(f.path)) return true;
  }
  return false;
}

/** "a, b, and c" — Oxford comma. Single item returns itself. */
export function joinList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return items.slice(0, -1).join(', ') + ', and ' + items[items.length - 1];
}

function lowerFirst(s: string): string {
  if (s.length === 0) return s;
  return s[0]!.toLowerCase() + s.slice(1);
}
