/**
 * @factstack/core — analysis pipeline.
 *
 * Isomorphic: imports only from @factstack/spec, walker, scanners, graph,
 * extractors, parsers. Never touches node:fs or zlib directly; all I/O
 * flows through the FactsFS interface injected by the caller.
 *
 * v0.1 scope: this file composes walker → scanners → artifact builders.
 * Tree-sitter parsers + AST extractors + a real dependency graph are
 * stubbed; hooks below call into empty stubs today and are wired up in
 * v0.2 without touching this orchestrator.
 */

import type {
  AgentArtifact,
  FactsFS,
  FileOutline,
  HumanArtifact,
  ProjectMetaSchema,
} from '@factstack/spec';
import { FACTS_SCHEMA_VERSION } from '@factstack/spec';
import { walk, type WalkedFile } from '@factstack/walker';
import {
  approximateTokens,
  detectLanguage,
  mergeFrameworks,
  scanFrameworksFromPackageJson,
  scanFrameworksFromRequirements,
  scanSecrets,
  scanTodos,
  type TodoEntry,
} from '@factstack/scanners';
import type { z } from 'zod';

type ProjectMeta = z.infer<typeof ProjectMetaSchema>;

export interface AnalyzeOptions {
  /** Project root path (FactsFS-relative). */
  root?: string;
  /** Override the project name (default: last path segment of root). */
  projectName?: string;
  /** Compute gzip bundle size per file. Callback is injected so this package
   *  stays isomorphic; the CLI passes a node:zlib-based impl. */
  gzip?: (text: string) => number;
  /** Called with percent-complete (0–1) and the file being processed. */
  onProgress?: (pct: number, file: string) => void;
}

export interface AnalysisResult {
  agent: AgentArtifact;
  human: HumanArtifact;
  /** Diagnostics: files skipped, elapsed ms, etc. */
  meta: {
    filesScanned: number;
    filesSkipped: number;
    elapsedMs: number;
  };
}

export async function analyze(fs: FactsFS, opts: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const t0 = now();
  const rootPath = opts.root ?? '.';
  const rootName = opts.projectName ?? lastSegment(rootPath) ?? 'project';

  // Phase 1 — walk + per-file scanning
  const outlines: FileOutline[] = [];
  const allTodos: Array<{ file: string; entries: TodoEntry[] }> = [];
  const secrets: AgentArtifact['risks'] = [];
  const frameworksFromManifests: string[][] = [];
  const scriptsFromPkgJson: Record<string, string> = {};
  let filesScanned = 0;
  let filesSkipped = 0;

  // We don't know the total ahead of time, so progress is unknown-duration.
  const files: WalkedFile[] = [];
  for await (const f of walk(fs, rootPath)) files.push(f);

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!f) continue;
    opts.onProgress?.(i / files.length, f.path);

    if (f.skippedReason) {
      filesSkipped++;
      if (f.skippedReason === 'too_large') {
        secrets.push({
          severity: 'low',
          category: 'large-file',
          rule: 'file-size-cap',
          file: f.path,
          message: `File exceeds size cap (${f.size} bytes) — skipped.`,
        });
      }
      // Still record the file so the tree contains it.
      outlines.push(minimalOutline(f, 'ok'));
      continue;
    }

    const lang = detectLanguage(f.ext);
    const text = f.text ?? '';
    const tokens = approximateTokens(text);
    const gzip = opts.gzip && isCompressibleExt(f.ext) ? opts.gzip(text) : null;

    // Scanners
    const todoEntries = scanTodos(text);
    if (todoEntries.length) allTodos.push({ file: f.path, entries: todoEntries });

    if (lang) {
      for (const s of scanSecrets(f.path, text)) {
        secrets.push({
          severity: 'high',
          category: 'secret',
          rule: s.ruleId,
          file: s.file,
          line: s.line,
          message: `${s.ruleLabel} detected (entropy ${s.entropy}). Rotate and remove from source.`,
          preview: s.preview,
        });
      }
    }

    // Manifest scans (frameworks, scripts)
    if (f.name === 'package.json') {
      const d = scanFrameworksFromPackageJson(text);
      frameworksFromManifests.push(d.frameworks);
      for (const [k, v] of Object.entries(d.scripts)) {
        // Only pick up root-level scripts. Workspace packages' scripts would
        // be noise in the project summary.
        if (f.dir === '') scriptsFromPkgJson[k] = v;
      }
    } else if (f.name === 'requirements.txt') {
      frameworksFromManifests.push(scanFrameworksFromRequirements(text));
    }

    outlines.push({
      path: f.path,
      language: lang?.id ?? 'other',
      loc: f.loc,
      bytes: f.size,
      bundleSize: gzip != null
        ? { raw: f.size, minified: text.length, gzipped: gzip }
        : null,
      tokenCost: tokens,
      imports: [],
      exports: [],
      declarations: [],
      // TodoSchema requires authoredAt (nullable). v0.2 adds git-blame to
      // populate this; for now emit explicit null so Zod validates.
      todos: todoEntries.map((t) => ({ ...t, authoredAt: null })),
      complexity: { cyclomatic: 0, cognitive: 0 },
      status: 'ok',
      lastModifiedMs: f.mtimeMs || null,
      churnScore: null,
    });
    filesScanned++;
  }
  opts.onProgress?.(1, '');

  // Project meta
  const languageTally = new Map<string, { id: string; label: string; loc: number; tokens: number; files: number; iconColor: string }>();
  for (const o of outlines) {
    const lang = detectLanguage(extOf(o.path));
    if (!lang) continue;
    const cur = languageTally.get(lang.id) ?? {
      id: lang.id, label: lang.label, loc: 0, tokens: 0, files: 0, iconColor: '',
    };
    cur.loc += o.loc;
    cur.tokens += o.tokenCost;
    cur.files += 1;
    languageTally.set(lang.id, cur);
  }
  const languages = [...languageTally.values()].sort((a, b) => b.tokens - a.tokens);

  const frameworks = mergeFrameworks(frameworksFromManifests);
  const projectMeta: ProjectMeta = {
    name: rootName,
    root: rootPath,
    languages: languages.map((l) => l.label),
    frameworks,
    entryPoints: synthesizeEntryPoints(frameworks, scriptsFromPkgJson),
    monorepo: detectMonorepo(outlines),
  };

  // Tokens total
  const totalTokens = outlines.reduce((s, o) => s + o.tokenCost, 0);
  const totalLOC = outlines.reduce((s, o) => s + o.loc, 0);
  const totalGzip = outlines.reduce((s, o) => s + (o.bundleSize?.gzipped ?? 0), 0);

  // Build agent artifact
  const agent: AgentArtifact = {
    $schema: 'https://factstack.dev/schema/agent.v1.json',
    factsVersion: FACTS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    project: projectMeta,
    files: outlines,
    graph: { nodes: [], edges: [], cycles: [] },
    routes: [],
    scripts: scriptsFromPkgJson,
    capabilities: inferCapabilities(frameworks, outlines),
    risks: secrets,
    stats: {
      loc: totalLOC,
      fileCount: filesScanned,
      packageCount: countPackages(outlines),
      totalTokenCost: totalTokens,
    },
  };

  // Build human artifact (dashboard)
  const broken = 0;
  const staleThreshold = 180 * 24 * 60 * 60 * 1000;
  const now_ms = Date.now();
  const stale = outlines.filter(
    (o) => o.todos.length > 0 && o.lastModifiedMs && now_ms - o.lastModifiedMs > staleThreshold,
  ).length;
  const todoCount = allTodos.reduce((s, x) => s + x.entries.length, 0);

  const human: HumanArtifact = {
    $schema: 'https://factstack.dev/schema/human.v1.json',
    factsVersion: FACTS_SCHEMA_VERSION,
    generatedAt: agent.generatedAt,
    summary: {
      oneLiner: oneLiner(frameworks, rootName),
      intent: '',
      capabilities: agent.capabilities,
      entryPoints: projectMeta.entryPoints.map((p) => ({
        label: p,
        kind: classifyEntryPoint(p),
        path: p,
        handlerFile: '',
        description: null,
      })),
      health: {
        broken,
        stale,
        todos: todoCount,
        secrets: secrets.filter((r) => r.category === 'secret').length,
        headline: buildHealthHeadline(broken, stale, todoCount, secrets.length),
      },
    },
    stack: languages.map((l) => ({
      name: l.label,
      kind: 'language',
      loc: l.loc,
      tokenCost: l.tokens,
      iconId: l.id,
    })),
    tree: buildHumanTree(outlines, rootName),
    graph: { nodes: [], edges: [], cycles: [] },
    activity: outlines
      .filter((o) => o.lastModifiedMs != null)
      .sort((a, b) => (b.lastModifiedMs ?? 0) - (a.lastModifiedMs ?? 0))
      .slice(0, 25)
      .map((o) => ({
        file: o.path,
        lastModifiedMs: o.lastModifiedMs ?? 0,
        churnScore: o.churnScore ?? 0,
        authorCount: 0,
      })),
    risks: secrets,
    glossary: [],
  };

  return {
    agent,
    human,
    meta: { filesScanned, filesSkipped, elapsedMs: now() - t0 },
  };
}

/* ------------------------------ helpers -------------------------------- */

function now(): number {
  // Avoid node:perf_hooks (isomorphic).
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

function lastSegment(p: string): string | null {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

function extOf(p: string): string {
  const dot = p.lastIndexOf('.');
  const slash = p.lastIndexOf('/');
  return dot > slash ? p.slice(dot).toLowerCase() : '';
}

function isCompressibleExt(ext: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|html|css|scss|json)$/i.test(ext);
}

function minimalOutline(f: WalkedFile, status: FileOutline['status']): FileOutline {
  return {
    path: f.path,
    language: 'other',
    loc: f.loc,
    bytes: f.size,
    bundleSize: null,
    tokenCost: 0,
    imports: [],
    exports: [],
    declarations: [],
    todos: [],
    complexity: { cyclomatic: 0, cognitive: 0 },
    status,
    lastModifiedMs: f.mtimeMs || null,
    churnScore: null,
  };
}

function inferCapabilities(frameworks: string[], files: FileOutline[]): string[] {
  const caps: string[] = [];
  if (frameworks.includes('React')) caps.push('Renders a React web UI');
  if (frameworks.includes('Next.js')) caps.push('Serves Next.js routes');
  if (frameworks.includes('Express') || frameworks.includes('Hono') || frameworks.includes('Koa')) caps.push('Serves an HTTP API');
  if (frameworks.includes('FastAPI') || frameworks.includes('Django') || frameworks.includes('Flask')) caps.push('Serves a Python web API');
  if (frameworks.includes('Turborepo')) caps.push('Organised as a Turborepo monorepo');
  if (frameworks.includes('Vite')) caps.push('Built with Vite');
  if (frameworks.includes('Tailwind CSS')) caps.push('Styled with Tailwind CSS');
  if (frameworks.includes('Zod')) caps.push('Validates data with Zod schemas');
  if (frameworks.includes('Stripe')) caps.push('Integrates Stripe');
  if (files.some((f) => f.path.includes('eslint.config'))) caps.push('Lints with a modern ESLint flat config');
  return caps;
}

function oneLiner(frameworks: string[], name: string): string {
  const top = frameworks.slice(0, 3);
  if (top.length === 0) return `The ${name} project.`;
  return `A ${top.join(' + ')} project.`;
}

function buildHealthHeadline(broken: number, stale: number, todos: number, secrets: number): string {
  const parts: string[] = [];
  if (broken) parts.push(`${broken} broken file${broken === 1 ? '' : 's'}`);
  if (stale) parts.push(`${stale} stale file${stale === 1 ? '' : 's'}`);
  if (secrets) parts.push(`${secrets} secret${secrets === 1 ? '' : 's'} exposed`);
  if (todos) parts.push(`${todos} TODO${todos === 1 ? '' : 's'}`);
  if (parts.length === 0) return 'Clean — no blockers detected.';
  return parts.join(', ') + '.';
}

function countPackages(outlines: FileOutline[]): number {
  // Every package.json beyond root denotes a workspace package.
  return outlines.filter((o) => o.path.endsWith('package.json') && o.path !== 'package.json').length;
}

function detectMonorepo(outlines: FileOutline[]): ProjectMeta['monorepo'] {
  if (outlines.some((o) => o.path === 'pnpm-workspace.yaml')) return { manager: 'pnpm', workspaces: [] };
  if (outlines.some((o) => o.path === 'turbo.json')) return { manager: 'turbo', workspaces: [] };
  if (outlines.some((o) => o.path === 'nx.json')) return { manager: 'nx', workspaces: [] };
  if (outlines.some((o) => o.path === 'lerna.json')) return { manager: 'lerna', workspaces: [] };
  return null;
}

function synthesizeEntryPoints(frameworks: string[], scripts: Record<string, string>): string[] {
  const out: string[] = [];
  if (scripts['dev']) out.push('npm run dev');
  if (scripts['start']) out.push('npm run start');
  if (scripts['build']) out.push('npm run build');
  if (scripts['test']) out.push('npm run test');
  if (frameworks.includes('Vite') || frameworks.includes('Next.js') || frameworks.includes('Remix')) {
    out.push('http://localhost:3000');
  }
  return out;
}

function classifyEntryPoint(p: string): 'http-route' | 'page' | 'screen' | 'cli-command' | 'event-handler' {
  if (p.startsWith('http')) return 'page';
  if (p.startsWith('/')) return 'http-route';
  return 'cli-command';
}

function buildHumanTree(outlines: FileOutline[], rootName: string): HumanArtifact['tree'] {
  // Build a tree from flat file paths.
  interface MutableNode {
    id: string;
    name: string;
    path: string;
    kind: 'directory' | 'file';
    language: string | null;
    loc: number;
    tokenCost: number;
    bundleSizeGzip: number | null;
    status: FileOutline['status'];
    children: MutableNode[] | null;
  }
  const root: MutableNode = {
    id: '.',
    name: rootName,
    path: '.',
    kind: 'directory',
    language: null,
    loc: 0,
    tokenCost: 0,
    bundleSizeGzip: 0,
    status: 'ok',
    children: [],
  };
  const byPath = new Map<string, MutableNode>([['.', root]]);

  for (const f of outlines) {
    const parts = f.path.split('/');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const dirPath = parts.slice(0, i + 1).join('/');
      let child = byPath.get(dirPath);
      if (!child) {
        child = {
          id: dirPath,
          name: parts[i]!,
          path: dirPath,
          kind: 'directory',
          language: null,
          loc: 0,
          tokenCost: 0,
          bundleSizeGzip: 0,
          status: 'ok',
          children: [],
        };
        byPath.set(dirPath, child);
        cur.children!.push(child);
      }
      cur = child;
    }
    const fileNode: MutableNode = {
      id: f.path,
      name: parts[parts.length - 1]!,
      path: f.path,
      kind: 'file',
      language: f.language,
      loc: f.loc,
      tokenCost: f.tokenCost,
      bundleSizeGzip: f.bundleSize?.gzipped ?? null,
      status: f.status,
      children: null,
    };
    cur.children!.push(fileNode);
  }

  // Rollup stats up the tree so folders carry the sum of their descendants.
  (function roll(n: MutableNode): { loc: number; tok: number; gzip: number } {
    if (n.kind === 'file') {
      return { loc: n.loc, tok: n.tokenCost, gzip: n.bundleSizeGzip ?? 0 };
    }
    let loc = 0, tok = 0, gzip = 0;
    for (const c of n.children ?? []) {
      const r = roll(c);
      loc += r.loc; tok += r.tok; gzip += r.gzip;
    }
    n.loc = loc;
    n.tokenCost = tok;
    n.bundleSizeGzip = gzip;
    return { loc, tok, gzip };
  })(root);

  return root as unknown as HumanArtifact['tree'];
}
