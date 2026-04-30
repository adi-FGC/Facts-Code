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
  deriveLicenseRisks,
  detectLanguage,
  mergeFrameworks,
  scanFileLicense,
  scanFrameworksFromPackageJson,
  scanFrameworksFromRequirements,
  scanManifestLicense,
  scanSecrets,
  scanTodos,
  type TodoEntry,
} from '@factstack/scanners';
import {
  detectFileBasedRoutes,
  detectSourceRoutes,
  extractImports,
  extractPythonImports,
  extractSymbols,
  isParseable,
  isPython,
  parseJS,
  type DetectedRoute,
  type ExtractedSymbol,
  type RawImport,
} from '@factstack/extractors';
import {
  buildCallerIndex,
  buildDependencyGraph,
  buildWorkspaceIndex,
  resolveSpecifier,
  type ResolverContext,
} from '@factstack/graph';

export { diffArtifacts } from './diff.js';
export type { Endpoint as DiffEndpoint, DiffEndpointOverrides } from './diff.js';
export { executeQuery, type QueryOptions, type QueryResult } from './query.js';
import type { ProjectMeta } from '@factstack/spec';

export interface AnalyzeOptions {
  /** Project root path (FactsFS-relative). */
  root?: string;
  /** Override the project name (default: last path segment of root). */
  projectName?: string;
  /** Compute gzip bundle size per file. Callback is injected so this package
   *  stays isomorphic; the CLI passes a node:zlib-based impl. */
  gzip?: (text: string) => number;
  /** Pre-mined git stats keyed by project-relative path. Isomorphic core
   *  never shells out to git; the CLI injects this map via @factstack/fs-node's
   *  mineGitStats() helper. */
  gitStats?: Map<string, { lastModifiedMs: number; churnScore: number; authorCount: number }> | undefined;
  /** Called with percent-complete (0–1) and the file being processed. */
  onProgress?: ((pct: number, file: string) => void) | undefined;
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
  const packageJsons: Array<{ path: string; text: string }> = [];
  const importsByFile = new Map<string, RawImport[]>();
  const detectedRoutes: DetectedRoute[] = [];
  const fileLicenses = new Map<string, string>();
  let projectLicense: string | null = null;
  let filesScanned = 0;
  let filesSkipped = 0;
  // Sources for the human-friendly one-liner, in priority order:
  //   1. root README first prose sentence
  //   2. root package.json `description`
  //   3. mechanical "A X + Y + Z project" fallback
  // `null` means we never saw the source. The first non-null wins
  // when oneLiner() runs.
  let readmeOneLiner: string | null = null;
  let pkgDescription: string | null = null;

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

    // Manifest scans (frameworks, scripts, license, description)
    if (f.name === 'package.json') {
      packageJsons.push({ path: f.path, text });
      const d = scanFrameworksFromPackageJson(text);
      frameworksFromManifests.push(d.frameworks);
      for (const [k, v] of Object.entries(d.scripts)) {
        // Only pick up root-level scripts. Workspace packages' scripts would
        // be noise in the project summary.
        if (f.dir === '') scriptsFromPkgJson[k] = v;
      }
      const lic = scanManifestLicense(text, 'package.json');
      if (lic && f.dir === '') projectLicense = lic;
      // Project description from the root package.json — used as a
      // one-liner source before the mechanical "A X + Y + Z project"
      // fallback. Only the root manifest counts; nested workspace
      // descriptions describe individual packages, not the project.
      if (f.dir === '' && pkgDescription == null) {
        try {
          const j = JSON.parse(text) as { description?: unknown };
          if (typeof j.description === 'string' && j.description.trim()) {
            pkgDescription = j.description.trim();
          }
        } catch { /* malformed package.json — silent */ }
      }
    } else if (f.name === 'requirements.txt') {
      frameworksFromManifests.push(scanFrameworksFromRequirements(text));
    } else if ((f.name === 'pyproject.toml' || f.name === 'Cargo.toml') && f.dir === '') {
      const lic = scanManifestLicense(text, f.name);
      if (lic && !projectLicense) projectLicense = lic;
    } else if (f.dir === '' && readmeOneLiner == null && /^README(\.md|\.markdown|\.txt)?$/i.test(f.name)) {
      // Root-level README first prose sentence. Extract the first non-empty
      // paragraph that isn't a heading, badge line, or HTML — usually the
      // project's tagline. Capped to 240 chars to avoid pulling in giant
      // intro sections.
      readmeOneLiner = extractReadmeFirstSentence(text);
    }

    // File-header SPDX detection — cheap, per source file.
    if (lang && lang.id !== 'json' && lang.id !== 'yaml' && lang.id !== 'toml') {
      const fileLic = scanFileLicense(text);
      if (fileLic) fileLicenses.set(f.path, fileLic);
    }

    // AST-based extraction — parse each JS/TS file ONCE, then pass the
    // shared AST to every consumer (imports, symbols, future call graph).
    // Python still uses the regex extractor (tree-sitter is v0.3 scope).
    let symbols: ExtractedSymbol[] = [];
    if (lang && isParseable(f.ext)) {
      const parsed = parseJS(text, f.ext);
      if (parsed) {
        const raws = extractImports(text, f.ext, parsed);
        if (raws.length) importsByFile.set(f.path, raws);
        symbols = extractSymbols(text, f.ext, parsed);
      }
    } else if (isPython(f.ext)) {
      const raws = extractPythonImports(text);
      if (raws.length) importsByFile.set(f.path, raws);
    }

    // Routes — file-path-based (Next/Remix/pages) + source-based
    // (Express-style, FastAPI, Flask, Django). Both passes contribute.
    detectedRoutes.push(...detectFileBasedRoutes(f.path));
    if (lang && (isParseable(f.ext) || isPython(f.ext))) {
      detectedRoutes.push(...detectSourceRoutes(f.path, text));
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
      imports: (importsByFile.get(f.path) ?? []).map((r) => ({
        source: r.specifier,
        resolved: null,          // backfilled after the resolver runs
        specifiers: [],
        isTypeOnly: r.kind === 'type-import',
      })),
      exports: [],
      declarations: symbols.map((s) => ({
        name: s.name,
        kind: s.kind,
        startLine: s.startLine,
        endLine: s.endLine,
        exported: s.exported,
        ...(s.docstring ? { docstring: s.docstring } : {}),
        ...(s.children ? { children: s.children.map((c) => ({
          name: c.name, kind: c.kind, startLine: c.startLine,
          endLine: c.endLine, exported: c.exported,
          ...(c.docstring ? { docstring: c.docstring } : {}),
        })) } : {}),
      })),
      // TodoSchema requires authoredAt (nullable). v0.2's git miner
      // populates per-FILE churn + mtime, but not per-TODO blame (which
      // needs `git blame -L` per line). v0.3 adds the blame pass; for
      // now emit explicit null so Zod validates.
      todos: todoEntries.map((t) => ({ ...t, authoredAt: null })),
      complexity: { cyclomatic: 0, cognitive: 0 },
      status: 'ok',
      // Prefer git-mined timestamps over fs.stat when available — the
      // latter is clone-time, not authoring-time.
      lastModifiedMs: opts.gitStats?.get(f.path)?.lastModifiedMs ?? f.mtimeMs ?? null,
      churnScore: opts.gitStats?.get(f.path)?.churnScore ?? null,
    });
    filesScanned++;
  }
  opts.onProgress?.(1, '');

  // Phase 2 — dependency graph. Workspace index first so relative imports
  // AND @scope/package imports both resolve. Resolver emits null for
  // external/unresolved specifiers — we keep those as risks/broken-imports.
  const resolverCtx: ResolverContext = {
    files: new Set(outlines.map((o) => o.path)),
    workspaces: buildWorkspaceIndex(packageJsons),
  };
  const depGraph = buildDependencyGraph(outlines, importsByFile, resolverCtx);
  // Backfill the `callers` field on every graph node so consumers can
  // answer "who imports X?" without walking the edge list themselves.
  const callerIndex = buildCallerIndex(depGraph);
  for (const node of depGraph.nodes) {
    const callers = callerIndex.get(node.path);
    if (callers && callers.length) node.callers = callers;
  }

  // Backfill `resolved` on each outline's imports + surface broken imports.
  for (const outline of outlines) {
    if (!outline.imports.length) continue;
    for (const imp of outline.imports) {
      const resolved = resolveIfLocal(imp.source, outline.path, resolverCtx);
      imp.resolved = resolved;
    }
  }
  for (const outline of outlines) {
    for (const imp of outline.imports) {
      if (imp.resolved == null && isProjectLocalSpecifier(imp.source, resolverCtx)) {
        secrets.push({
          severity: 'medium',
          category: 'broken-import',
          rule: 'unresolved-import',
          file: outline.path,
          message: `Unresolved import: "${imp.source}"`,
        });
      }
    }
  }
  for (const scc of depGraph.cycles) {
    secrets.push({
      severity: 'low',
      category: 'cycle',
      rule: 'import-cycle',
      message: `Import cycle across ${scc.length} file${scc.length === 1 ? '' : 's'}: ${scc.slice(0, 3).join(' → ')}${scc.length > 3 ? ' → …' : ''}.`,
    });
  }

  // License risks — GPL-in-permissive, missing declaration, etc.
  for (const lr of deriveLicenseRisks(projectLicense, fileLicenses)) {
    secrets.push({
      severity: lr.severity === 'info' ? 'info' : lr.severity,
      category: 'license',
      rule: lr.license ? 'copyleft-detected' : 'missing-license',
      ...(lr.file ? { file: lr.file } : {}),
      message: lr.message,
    });
  }

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
    entryPoints: synthesizeEntryPoints(frameworks, scriptsFromPkgJson, dedupeRoutes(detectedRoutes)),
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
    graph: depGraph,
    routes: reclassifyRoutes(dedupeRoutes(detectedRoutes), frameworks).map((r) => ({
      framework: r.framework,
      method: r.method,
      path: r.path,
      handlerFile: r.handlerFile,
      handlerSymbol: r.handlerSymbol,
    })),
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

  // Build human artifact (dashboard).
  // `broken` = number of distinct files that contributed at least one
  // broken-import or parse-error risk. Aggregating by file avoids
  // double-counting when one file has multiple unresolved imports.
  const brokenFiles = new Set<string>();
  for (const r of secrets) {
    if ((r.category === 'broken-import' || r.category === 'parse-error') && r.file) {
      brokenFiles.add(r.file);
    }
  }
  const broken = brokenFiles.size;
  const staleThreshold = 180 * 24 * 60 * 60 * 1000;
  const now_ms = Date.now();
  // "stale" is unchanged-in-over-6-months AND still has a TODO — signals
  // rot rather than plain age. Files with no TODO are assumed intentional.
  const stale = outlines.filter(
    (o) => o.todos.length > 0 && o.lastModifiedMs && now_ms - o.lastModifiedMs > staleThreshold,
  ).length;
  const todoCount = allTodos.reduce((s, x) => s + x.entries.length, 0);

  const human: HumanArtifact = {
    $schema: 'https://factstack.dev/schema/human.v1.json',
    factsVersion: FACTS_SCHEMA_VERSION,
    generatedAt: agent.generatedAt,
    summary: {
      oneLiner: oneLiner(frameworks, rootName, readmeOneLiner, pkgDescription),
      intent: '',
      capabilities: agent.capabilities,
      entryPoints: projectMeta.entryPoints.map((p: string) => ({
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
    graph: depGraph,
    // Activity feed surfaces files a CXO would actually want to see —
    // skip lockfiles + tsbuildinfo + non-source artifacts so the panel
    // doesn't get hijacked by build cache mtime churn.
    activity: outlines
      .filter((o) => o.lastModifiedMs != null && !isActivityNoise(o.path))
      .sort((a, b) => (b.lastModifiedMs ?? 0) - (a.lastModifiedMs ?? 0))
      .slice(0, 25)
      .map((o) => ({
        file: o.path,
        lastModifiedMs: o.lastModifiedMs ?? 0,
        churnScore: o.churnScore ?? 0,
        authorCount: opts.gitStats?.get(o.path)?.authorCount ?? 0,
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

// (isParseableForImports lives in @factstack/extractors now as `isParseable`.)

/** True if a path is a build artifact / cache / lockfile that should
 *  never appear in the user-facing activity stream. The walker drops
 *  some of these (`*.tsbuildinfo`); this catches the rest by basename. */
function isActivityNoise(p: string): boolean {
  const last = p.toLowerCase().split('/').pop() || '';
  if (last === 'pnpm-lock.yaml' || last === 'package-lock.json' || last === 'yarn.lock') return true;
  if (last === '.gitignore' || last === '.gitattributes' || last === '.editorconfig') return true;
  return false;
}

/** Dedupe + prefer source-refined entries over file-path stubs. */
function dedupeRoutes(routes: DetectedRoute[]): DetectedRoute[] {
  const byKey = new Map<string, DetectedRoute>();
  for (const r of routes) {
    const key = r.framework + '|' + (r.method ?? 'ANY') + '|' + r.path;
    const existing = byKey.get(key);
    if (!existing || (existing.handlerSymbol == null && r.handlerSymbol != null)) {
      byKey.set(key, r);
    }
  }
  return [...byKey.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Re-classify routes whose framework was inferred from a file convention
 * that doesn't actually match the project's manifest. The most common
 * misclassification is a Vite SPA with a `src/pages/` or `pages/` folder
 * — `detectFileBasedRoutes` emits `framework: 'nextjs'` because the
 * file shape matches Next.js Pages Router, but Next.js itself isn't
 * installed. The Routes tab then shows confusing "Next.js" badges on
 * a non-Next project.
 *
 * Strategy: if a route is labeled `nextjs` but the project's detected
 * frameworks don't include "Next.js", relabel it as `react-router`
 * (when React Router is detected) or `spa-page` (generic Vite/SPA).
 * Same rule for `remix` without Remix in frameworks. Source-based
 * detections (`express`, `fastapi`, etc.) are trusted as-is — they
 * required an explicit import gate to fire.
 */
function reclassifyRoutes(routes: DetectedRoute[], frameworks: string[]): DetectedRoute[] {
  const fwSet = new Set(frameworks);
  const hasNext = fwSet.has('Next.js');
  const hasRemix = fwSet.has('Remix');
  const hasReactRouter = fwSet.has('React Router');
  // If a route says nextjs/remix but the manifest doesn't agree, re-label
  // to the most accurate alternative we have evidence for.
  return routes.map((r) => {
    if (r.framework === 'nextjs' && !hasNext) {
      return { ...r, framework: hasReactRouter ? 'react-router' : 'spa-page' };
    }
    if (r.framework === 'remix' && !hasRemix) {
      return { ...r, framework: hasReactRouter ? 'react-router' : 'spa-page' };
    }
    return r;
  });
}

/** Re-resolve a specifier for an outline's imports[] backfill. */
function resolveIfLocal(source: string, importerPath: string, ctx: ResolverContext): string | null {
  return resolveSpecifier(source, importerPath, ctx);
}

/** True iff a specifier looks like something that SHOULD resolve to a project
 *  file — either relative, or a known workspace name. External packages are
 *  allowed to "resolve to null" without becoming a risk. */
function isProjectLocalSpecifier(source: string, ctx: ResolverContext): boolean {
  if (source.startsWith('./') || source.startsWith('../')) return true;
  for (const ws of ctx.workspaces.values()) {
    if (source === ws.name || source.startsWith(ws.name + '/')) return true;
  }
  return false;
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

/**
 * One-liner generation. Three sources, evaluated in priority order:
 *
 *   1. README first prose sentence — what the project's authors said it is.
 *      Most likely to be useful for a CXO who wants a real description, not
 *      a framework list.
 *   2. package.json `description` — a one-line tagline that npm publishers
 *      curate. Often less crisp than README but still better than mechanical.
 *   3. Mechanical "A X + Y + Z project" — the v0.1 fallback. Stable and
 *      predictable but uninformative ("A ESLint + Framer Motion + React
 *      project" is a fingerprint, not a description).
 *
 * Each source is sanitized: stripped of newlines, length-capped, trailing
 * period normalized. We never fabricate sentence structure — just clean up
 * what's already there.
 */
function oneLiner(
  frameworks: string[],
  name: string,
  readmeFirstSentence: string | null,
  pkgDescription: string | null,
): string {
  const sanitize = (s: string) => {
    const trimmed = s.replace(/\s+/g, ' ').trim();
    if (!trimmed) return '';
    const capped = trimmed.length > 240 ? trimmed.slice(0, 237) + '…' : trimmed;
    // Ensure it ends with terminal punctuation so it reads as a sentence
    // alongside the mechanical fallback ("A React project.").
    return /[.!?…]$/.test(capped) ? capped : capped + '.';
  };
  if (readmeFirstSentence) {
    const cleaned = sanitize(readmeFirstSentence);
    if (cleaned) return cleaned;
  }
  if (pkgDescription) {
    const cleaned = sanitize(pkgDescription);
    if (cleaned) return cleaned;
  }
  // Mechanical fallback — same shape as v0.1.
  const top = frameworks.slice(0, 3);
  if (top.length === 0) return `The ${name} project.`;
  return `A ${top.join(' + ')} project.`;
}

/**
 * Extract the first prose sentence from a README. Rules:
 *  - Skip blank lines, ATX/Setext headings, HTML tags, badge images, code
 *    fences, blockquotes, and list bullets.
 *  - Take the first surviving line (or two if the first is short and joins
 *    naturally with the next).
 *  - Cap at 240 chars; let the caller normalize punctuation.
 *
 * Returns `null` when nothing survives the filter (a README with only
 * badges, for example).
 */
function extractReadmeFirstSentence(md: string): string | null {
  const lines = md.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] ?? '';
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Code fences open/close — skip everything inside.
    if (/^```/.test(trimmed)) { inFence = !inFence; continue; }
    if (inFence) continue;
    // ATX heading (# ...), HR rules, blockquotes, list items, badges,
    // raw HTML, or setext underline lines.
    if (/^#{1,6}\s/.test(trimmed)) continue;
    if (/^[-=]{3,}\s*$/.test(trimmed)) continue;
    if (/^>\s/.test(trimmed)) continue;
    if (/^[-*+]\s/.test(trimmed)) continue;
    if (/^\d+\.\s/.test(trimmed)) continue;
    if (/^!\[/.test(trimmed)) continue;            // image-only line (badges)
    if (/^<[a-zA-Z!]/.test(trimmed)) continue;     // raw HTML
    if (/^\[!\[/.test(trimmed)) continue;          // linked badges [![...]
    // Drop trailing inline links/badges from prose lines.
    line = trimmed.replace(/\s*\[!\[.*$/, '').trim();
    if (!line) continue;
    // Take just the first sentence (up to first `.`/`!`/`?` followed by
    // whitespace or end-of-line). Avoids dragging in multi-paragraph intros.
    const sentenceMatch = /^(.+?[.!?])(?:\s|$)/.exec(line);
    return (sentenceMatch && sentenceMatch[1] ? sentenceMatch[1] : line).trim();
  }
  return null;
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

function synthesizeEntryPoints(
  frameworks: string[],
  scripts: Record<string, string>,
  // `routes` is unused here intentionally — see comment below. Kept in
  // the signature to preserve call-site stability if a future iteration
  // wants to use route count as a heuristic.
  _routes: DetectedRoute[],
): string[] {
  // CLI commands + dev URL only. Routes used to be appended here too,
  // but the v0.2 UI's Routes tab now renders Pages + API + Commands as
  // three distinct sections (sourced from `agent.routes` directly), so
  // including routes in `entryPoints` doubled them up — same path
  // appeared in "Pages" AND "Commands". Keeping entryPoints scoped to
  // shell invocations + the conventional dev URL keeps the two artifact
  // fields cleanly orthogonal: routes = code-detected URLs, entryPoints
  // = how-do-I-launch-this commands.
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
