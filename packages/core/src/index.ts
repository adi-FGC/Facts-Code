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
  DependencyManifest,
  FactsFS,
  FileOutline,
  HumanArtifact,
  ProjectMetaSchema,
} from '@factstack/spec';
import { FACTS_SCHEMA_VERSION } from '@factstack/spec';
import { computeHealth } from './health.js';
export { computeHealth } from './health.js';
import { walk, type WalkedFile } from '@factstack/walker';
import {
  applyRewrite,
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
  scanDependencyManifest,
  analyzeCss,
  cssOrigin,
  extractStyleBlocks,
  type CssSource,
  type TodoEntry,
} from '@factstack/scanners';
import {
  detectFileBasedRoutes,
  detectSourceRoutes,
  isAstro,
  isParseable,
  isPython,
  type DetectedRoute,
  type EnvVarRead,
  type ExtractedSymbol,
  type RawImport,
  type RawRef,
} from '@factstack/extractors';
import {
  buildCallerIndex,
  buildSymbolGraph,
  buildDependencyGraph,
  buildWorkspaceIndex,
  buildAliasIndex,
  computeMetrics,
  resolveSpecifier,
  type ResolverContext,
} from '@factstack/graph';
import { buildDocFile, isDocFile } from './docs.js';
import { buildRationale } from './rationale.js';
import { buildEntities, type EntitySource } from './entities.js';
import { extractFileCached, type ExtractionCache } from './extraction-cache.js';

export { diffArtifacts } from './diff.js';
export {
  extractFile,
  extractFileCached,
  extractionCacheKey,
  EXTRACTION_CACHE_VERSION,
  type ExtractionCache,
  type FileExtraction,
} from './extraction-cache.js';
export type { Endpoint as DiffEndpoint, DiffEndpointOverrides } from './diff.js';
export { buildChangeVerdict, renderVerdictMarkdown } from './review.js';
export { buildDocFile, isDocFile, parseMarkdownStructure, DOC_CONTENT_CAP } from './docs.js';
export {
  executeQuery,
  runGraphQuery,
  findEntities,
  suggestEntities,
  expandWithHops,
  type QueryOptions,
  type QueryResult,
  type SubgraphResult,
  type HopExpansion,
} from './query.js';
export { planFromQuestion, type NlPlan, type NlResult } from './query-nl.js';
export {
  assembleContext,
  type ContextRequest,
  type ContextItem,
  type ContextResult,
} from './context.js';
export {
  runBench,
  runBenchTask,
  naiveReadSet,
  type BenchTask,
  type BenchTaskResult,
  type BenchReport,
} from './bench.js';
export { buildMemory, MEMORY_SCHEMA_VERSION } from './memory.js';
export {
  buildDiagram,
  buildPackageDiagram,
  buildHubDiagram,
  buildFocalDiagram,
  classifyPath,
  sanitizeId,
  shortPath,
  escapeMermaidLabel,
  type DiagramView,
  type DiagramOptions,
} from './diagram.js';
export { computeReadingTime, sumReadingMinutes, type ReadingTimeInput } from './reading-time.js';
import { computeReadingTime } from './reading-time.js';
export {
  formatLearningEvent,
  parseLearningsJsonl,
  queryLearnings,
  selfCalibrateEvent,
  proposalEvent,
  buildContextStore,
  recentSessionEntities,
  resolveCloseTarget,
  lastServedEntities,
  contextRecordEvent,
  sessionActionEvent,
  SESSION_ACTIONS,
  CONTEXT_KINDS,
  LearningEventSchema,
  LearningOutcomeSchema,
  LEARNINGS_SCHEMA_VERSION,
  type LearningEvent,
  type LearningOutcome,
  type LearningQuery,
  type ContextStore,
  type ContextRecord,
  type ContextKind,
  type SessionAction,
  type ContextRecordInput,
  type SessionActionInput,
} from './learnings.js';
export {
  since,
  sinceFromMtime,
  sinceFromBaseline,
  type SinceReport,
  type SinceFileSummary,
} from './since.js';
import { inferIntent } from '@factstack/intent';
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
   *  mineGitStats() helper. v0.3.8 added topContributors to the shape. */
  gitStats?: Map<string, {
    lastModifiedMs: number;
    churnScore: number;
    authorCount: number;
    topContributors?: Array<{ email: string; name: string; commits: number; lastTouchedMs: number }>;
  }> | undefined;
  /** Called with percent-complete (0–1) and the file being processed. */
  onProgress?: ((pct: number, file: string) => void) | undefined;
  /** F2 — build the symbol-level graph (call/reference edges). Off by default
   *  (the plan's `--symbols` rollout) so the per-file ref walk + resolver only
   *  run when asked; `agent.graph.symbolNodes/symbolEdges` stay [] otherwise. */
  symbols?: boolean | undefined;
  /** F8 — content-hash extraction cache. When provided, per-file AST work
   *  (parse + import/symbol/ref/env extraction) is served from the cache for
   *  files whose content hash is unchanged — touching one file re-parses ~that
   *  file. Keys carry the content hash, so output is IDENTICAL to an uncached
   *  run (INV2). Omit for the pre-F8 path; the browser build omits it (INV7).
   *  The Node CLI passes @factstack/emit's sqlite-backed store. */
  extractionCache?: ExtractionCache | undefined;
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
  /* v0.6 — accumulate every detected dep manifest. Populated in the
     main scan loop below; emitted on the artifact for the UI's
     Vulnerabilities page + the MCP server's list_vulnerabilities tool
     + the CLI's scan-vulns subcommand. */
  const dependencyManifests: DependencyManifest[] = [];
  /* v0.8 — flagged documentation files with parsed structure. A raw-content
     budget keeps the artifact JSON bounded when a repo has many large docs. */
  const docs: AgentArtifact['docs'] = [];
  let docContentChars = 0;
  const DOC_TOTAL_BUDGET = 2_500_000;
  /* v0.8 — CSS sources for the styling audit (.css/.scss/.less + <style>
     blocks from HTML/SFCs). Audited in one pass after the walk. */
  const cssSources: CssSource[] = [];
  /* F11 — whole-stack modalities. Collect SQL DDL + Terraform/HCL sources in
     the walk; converted to entity nodes/edges after Phase 2 (mirrors the
     deferred cssSources audit). */
  const sqlSources: EntitySource[] = [];
  const tfSources: EntitySource[] = [];
  /* F6 — Go modules declared by go.mod files; feeds the resolver so
     module-absolute Go imports become project-internal edges. */
  const goModules: Array<{ module: string; dir: string }> = [];
  const allTodos: Array<{ file: string; entries: TodoEntry[] }> = [];
  const secrets: AgentArtifact['risks'] = [];
  const frameworksFromManifests: string[][] = [];
  const scriptsFromPkgJson: Record<string, string> = {};
  const packageJsons: Array<{ path: string; text: string }> = [];
  const importsByFile = new Map<string, RawImport[]>();
  const detectedRoutes: DetectedRoute[] = [];
  const fileLicenses = new Map<string, string>();
  let projectLicense: string | null = null;
  /* v0.3.6 — env-var read sites collected per file, aggregated below
     into the top-level `config.envVars` table. */
  const envVarReadsByFile = new Map<string, EnvVarRead[]>();
  /* F2 — per-file identifier references (call/read/jsx/type-ref), captured
     only when opts.symbols is set; fed to buildSymbolGraph below. */
  const refsByFile = new Map<string, RawRef[]>();
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
      // A source-language extension that sniffed as binary (UTF-16 save,
      // corrupted encoding) is NOT a normal asset like a .png — its zeroed
      // metrics would read as "this file is empty". Same treatment as a
      // read failure: non-ok status + a risk row.
      const binarySource = f.skippedReason === 'binary' && detectLanguage(f.ext) != null;
      if (f.skippedReason === 'read_error' || binarySource) {
        secrets.push({
          severity: 'medium',
          category: 'read-error',
          rule: f.skippedReason === 'read_error' ? 'read-error' : 'binary-source',
          file: f.path,
          message: f.skippedReason === 'read_error'
            ? `File could not be read (${f.size} bytes on disk; failed after retry) — loc/tokens are unknown, not 0.`
            : `Source file sniffed as binary (frequent NUL bytes — unusual encoding such as UTF-16?) — loc/tokens are unknown, not 0.`,
        });
      }
      // Still record the file so the tree contains it. An unread file is
      // marked `read_error` — NEVER `ok` — because a non-empty file shown
      // as `ok` with loc 0 reads as "this file is empty" to consumers
      // (an agent concluded exactly that from a misread pack row).
      outlines.push(minimalOutline(f, f.skippedReason === 'read_error' || binarySource ? 'read_error' : 'ok'));
      continue;
    }

    const lang = detectLanguage(f.ext);
    const text = f.text ?? '';
    const tokens = approximateTokens(text);
    const gzip = opts.gzip && isCompressibleExt(f.ext) ? opts.gzip(text) : null;

    // v0.8 — flag documentation/spec files + parse their structure once.
    if (isDocFile(f.path, f.ext, f.name)) {
      const storeContent = docContentChars < DOC_TOTAL_BUDGET;
      const doc = buildDocFile({
        path: f.path,
        name: f.name,
        ext: f.ext,
        text,
        bytes: f.size,
        loc: f.loc,
        lastModifiedMs: opts.gitStats?.get(f.path)?.lastModifiedMs ?? f.mtimeMs ?? null,
        storeContent,
      });
      docs.push(doc);
      if (doc.content) docContentChars += doc.content.length;
    }

    // v0.8 — collect CSS sources for the styling audit.
    const cssOrig = cssOrigin(f.path, f.ext);
    if (cssOrig) {
      const cssText = cssOrig === 'html-style' || cssOrig === 'sfc-style'
        ? extractStyleBlocks(text)
        : text;
      if (cssText.trim()) cssSources.push({ path: f.path, css: cssText, origin: cssOrig });
    }

    // F11 — collect data-layer (.sql) + infra (.tf/.hcl) sources for the
    // whole-stack entity graph (parsed after the walk).
    if (f.ext === '.sql') sqlSources.push({ path: f.path, text });
    else if (f.ext === '.tf' || f.ext === '.hcl') tfSources.push({ path: f.path, text });

    // Scanners
    const todoEntries = scanTodos(text);
    if (todoEntries.length) allTodos.push({ file: f.path, entries: todoEntries });

    /* v0.6 — try to parse the file as a dependency manifest. Cheap:
       scanDependencyManifest returns null for non-manifest paths in O(1)
       (basename match). For matched manifests it produces a uniform
       record consumed by the Vulnerabilities page + scan-vulns CLI.
       Runs before scanSecrets so a malformed package.json doesn't
       prevent the secret scan; both are independent passes. */
    const manifest = scanDependencyManifest(f.path, text);
    if (manifest) dependencyManifests.push(manifest);

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

    // F6 — capture Go module names so module-absolute Go imports resolve to
    // project packages (the resolver's goModules context). Standalone check:
    // go.mod is not part of the package.json manifest chain below.
    if (f.name === 'go.mod') {
      const mod = text.match(/^module\s+(\S+)/m)?.[1];
      if (mod) goModules.push({ module: mod, dir: f.dir });
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

    /* AST-based extraction — lifted into extraction-cache.ts's pure
       extractFile() (one Babel parse shared by every consumer; Astro
       frontmatter sliced + line-shifted; Python/Go via regex extractors).
       F8: when opts.extractionCache is provided, the quad is served by
       content hash for unchanged files — touching one file re-parses ~that
       file. Keys include the hash + ext + refs-flag, so cached output is
       byte-identical to a fresh run (INV2). */
    const extracted = extractFileCached(text, f.ext, !!opts.symbols, opts.extractionCache);
    const symbols: ExtractedSymbol[] = extracted.symbols;
    if (extracted.imports.length) importsByFile.set(f.path, extracted.imports);
    if (opts.symbols && extracted.refs.length) refsByFile.set(f.path, extracted.refs);
    if (extracted.envReads.length) envVarReadsByFile.set(f.path, extracted.envReads);

    // Routes — file-path-based (Next/Remix/pages) + source-based
    // (Express-style, FastAPI, Flask, Django). Both passes contribute.
    // Source-based route detection also runs on Astro because some
    // patterns (like `export const prerender = false`) live in the
    // frontmatter and signal route behavior.
    detectedRoutes.push(...detectFileBasedRoutes(f.path));
    if (lang && (isParseable(f.ext) || isPython(f.ext) || isAstro(f.ext))) {
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
        specifiers: r.names,     // F2 — local binding names drive symbol-graph import resolution
        isTypeOnly: r.kind === 'type-import',
      })),
      /* v0.3.9 — derive exports from declarations.filter(s => s.exported).
         The symbol extractor already records the `exported` flag; pulling
         the export list out as a flat array gives agents an O(1) "what
         does this module surface?" question without rescanning the
         declarations array. `isDefault` is approximated: a symbol named
         literally `default` (default function/class export) is the
         common case; named-but-default exports lose the flag here and
         need declarations[] for full fidelity. Refining when v0.3.5
         symbol-refs lands. */
      exports: symbols
        .filter((s) => s.exported)
        .map((s) => ({
          name: s.name,
          kind: s.kind,
          isDefault: s.name === 'default',
        })),
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
      /* v0.3.8 — reading-time estimate. Cyclomatic is stubbed at 0
         today (the AST complexity pass lands in v0.4); the formula
         degrades to pure-LOC scaling, which is still useful. */
      readingMinutes: computeReadingTime({ loc: f.loc, cyclomatic: 0 }),
      /* v0.3.8 — top-3 contributors from git history. Pass through
         only when the CLI's git mine succeeded; absent in static
         deploys + non-git roots. */
      ...(opts.gitStats?.get(f.path)?.topContributors?.length
        ? { topContributors: opts.gitStats.get(f.path)!.topContributors }
        : {}),
    });
    filesScanned++;
  }
  opts.onProgress?.(1, '');

  // Phase 2 — dependency graph. Workspace index first so relative imports
  // AND @scope/package imports both resolve. Resolver emits null for
  // external/unresolved specifiers — we keep those as risks/broken-imports.
  // tsconfig/jsconfig `paths` aliases → let bare specifiers like `@lib/foo`
  // resolve to internal files. Without this, every aliased import is
  // mislabeled "external" and its dependency-graph edge silently vanishes.
  // We re-read the (few) config files here rather than thread them through
  // the per-file loop — cheap, and keeps the collection self-contained.
  const tsconfigTexts: Array<{ path: string; text: string }> = [];
  for (const f of files) {
    const base = f.path.slice(f.path.lastIndexOf('/') + 1);
    if ((base.startsWith('tsconfig.') || base.startsWith('jsconfig.')) && base.endsWith('.json')) {
      try {
        tsconfigTexts.push({ path: f.path, text: await fs.readText(f.path) });
      } catch {
        /* unreadable config — skip, don't fail the whole analysis */
      }
    }
  }

  const resolverCtx: ResolverContext = {
    files: new Set(outlines.map((o) => o.path)),
    workspaces: buildWorkspaceIndex(packageJsons),
    aliases: buildAliasIndex(tsconfigTexts),
    ...(goModules.length ? { goModules } : {}), // F6
  };
  const depGraph = buildDependencyGraph(outlines, importsByFile, resolverCtx);
  // Backfill the `callers` field on every graph node so consumers can
  // answer "who imports X?" without walking the edge list themselves.
  const callerIndex = buildCallerIndex(depGraph);
  for (const node of depGraph.nodes) {
    const callers = callerIndex.get(node.path);
    if (callers && callers.length) node.callers = callers;
  }

  // F5 — graph analytics: importance (PageRank) + community (label propagation).
  // Always-on for the file graph (cheap, deterministic); writes onto the shared
  // depGraph.nodes so BOTH the agent and human artifacts (which spread depGraph)
  // carry the metrics. Pure (INV1) + deterministic (INV2).
  const metrics = computeMetrics(depGraph);
  for (const node of depGraph.nodes) {
    const imp = metrics.importance.get(node.path);
    if (imp !== undefined) node.importance = imp;
    const com = metrics.community.get(node.path);
    if (com !== undefined) node.community = com;
  }

  // Backfill `resolved` on each outline's imports. This MUST run before
  // buildSymbolGraph below: the symbol resolver maps an imported binding to
  // its target file via `imp.resolved`, so leaving it null here would force
  // every cross-file ref down the lower-confidence global-name fallback
  // (the 0.9 "import-resolved" tier would never fire).
  for (const outline of outlines) {
    if (!outline.imports.length) continue;
    for (const imp of outline.imports) {
      const resolved = resolveIfLocal(imp.source, outline.path, resolverCtx);
      imp.resolved = resolved;
    }
  }

  // F2 — symbol-level graph (call/reference edges), gated behind opts.symbols
  // until stable (the plan's `--symbols` rollout). Empty otherwise → the
  // artifact's GraphSchema defaults ([]) apply, so existing consumers are
  // unaffected and pre-F2 artifacts still validate.
  const symbolGraph = opts.symbols
    ? buildSymbolGraph(outlines, refsByFile)
    : { symbolNodes: [], symbolEdges: [] };

  // F10 — link rationale (NOTE/HACK/FIXME/TODO/XXX comments + docstrings) to the
  // enclosing symbol (or file-level when no symbol graph). Pure; deterministic.
  const rationale = buildRationale(outlines, symbolGraph.symbolNodes);

  // F11 — whole-stack entity graph (SQL tables/views + IaC resources + doc
  // nodes, bridged by `documents` edges). Pure + deterministic; attached to
  // the graph below.
  const { entities: stackEntities, entityEdges: stackEntityEdges } = buildEntities({
    sqlSources,
    tfSources,
    docs,
    filePaths: outlines.map((o) => o.path),
  });

  // Surface broken imports (reads the now-backfilled `imp.resolved`).
  for (const outline of outlines) {
    for (const imp of outline.imports) {
      if (imp.resolved != null || !isProjectLocalSpecifier(imp.source, resolverCtx)) continue;
      // The walker excludes dist/build/etc., so an import into build output
      // is unresolvable HERE while perfectly valid after a build. Probe the
      // real filesystem before diagnosing: "dependency removed or path
      // stale" on an import that exists on disk is a wrong diagnosis
      // (flagged in the facts+ real-world eval).
      const diskPath = resolveRelativeSpecifier(outline.path, imp.source);
      if (diskPath && (await existsOutsideScan(fs, rootPath, diskPath))) {
        secrets.push({
          severity: 'low',
          category: 'broken-import',
          rule: 'unscanned-import',
          file: outline.path,
          message: `Import target exists on disk but outside the scanned set (build output or ignored directory): "${imp.source}"`,
        });
        continue;
      }
      secrets.push({
        severity: 'medium',
        category: 'broken-import',
        rule: 'unresolved-import',
        file: outline.path,
        message: `Unresolved import: "${imp.source}"`,
      });
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
  /* v0.3.9 — surface "did the analyzer mine git?" so agents reading
     churnScore/topContributors don't have to scan every file outline
     to figure out whether absent values are honest "no churn" or
     dishonest "we never had git." A non-empty gitStats map means we
     successfully ran git log and got at least one entry. */
  const gitAvailable = (opts.gitStats?.size ?? 0) > 0;
  const projectMeta: ProjectMeta = {
    name: rootName,
    root: rootPath,
    languages: languages.map((l) => l.label),
    frameworks,
    entryPoints: synthesizeEntryPoints(frameworks, scriptsFromPkgJson, dedupeRoutes(detectedRoutes)),
    monorepo: detectMonorepo(outlines),
    gitAvailable,
  };

  // Tokens total
  const totalTokens = outlines.reduce((s, o) => s + o.tokenCost, 0);
  const totalLOC = outlines.reduce((s, o) => s + o.loc, 0);
  const totalGzip = outlines.reduce((s, o) => s + (o.bundleSize?.gzipped ?? 0), 0);

  /* v0.3.6 — aggregate per-file env-var reads into a single name-keyed
     table. Each EnvVar entry holds every read site + the union of seen
     defaults + a "primary access pattern" when one dominates (≥75% of
     reads). Mixed access ⇒ primaryAccess = null so the UI can flag it. */
  const config = aggregateEnvVars(envVarReadsByFile);

  // v0.8 — CSS / styling audit over every collected stylesheet source.
  let styleAudit: AgentArtifact['styles'];
  if (cssSources.length > 0) {
    const cssDeps = new Set<string>();
    for (const dm of dependencyManifests) {
      for (const k of Object.keys(dm.dependencies)) cssDeps.add(k.toLowerCase());
      for (const k of Object.keys(dm.devDependencies)) cssDeps.add(k.toLowerCase());
    }
    styleAudit = analyzeCss(cssSources, { deps: cssDeps, frameworks });
  }

  // Build agent artifact
  const agent: AgentArtifact = {
    $schema: 'https://factstack.dev/schema/agent.v1.json',
    factsVersion: FACTS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    project: projectMeta,
    files: outlines,
    graph: {
      ...depGraph,
      symbolNodes: symbolGraph.symbolNodes,
      symbolEdges: symbolGraph.symbolEdges,
      // F11 — whole-stack entity graph: SQL tables/views, IaC resources, doc
      // nodes + cross-modality edges (fk / depends-on / documents).
      entities: stackEntities,
      entityEdges: stackEntityEdges,
    },
    routes: reclassifyRoutes(dedupeRoutes(detectedRoutes), frameworks).map((r) => ({
      framework: r.framework,
      method: r.method,
      path: r.path,
      handlerFile: r.handlerFile,
      handlerSymbol: r.handlerSymbol,
    })),
    scripts: scriptsFromPkgJson,
    capabilities: inferCapabilities(frameworks, outlines),
    /* v0.3.8 — funnel every risk through applyRewrite, which swaps
       in the CXO-readable variant where one exists and stashes the
       original technical text on `messageTechnical`. Rules without
       a rewrite pass through unchanged. */
    risks: secrets.map((r) => applyRewrite(r)),
    stats: {
      loc: totalLOC,
      fileCount: filesScanned,
      packageCount: countPackages(outlines),
      totalTokenCost: totalTokens,
    },
    config,
    /* v0.6 — security tier. dependencyManifests populated above in the
       main scan loop; vulnerabilities stays [] here because analyze
       MUST NOT make network calls (constraint C1). The opt-in
       `factstack scan-vulns` subcommand reads agent.json, queries OSV,
       and writes findings back. */
    dependencyManifests,
    vulnerabilities: [],
    docs,
    rationale,
    ...(styleAudit ? { styles: styleAudit } : {}),
  };

  // Build human artifact (dashboard).
  // Project-health grade (0–100 score + letter + top factors) is computed by
  // the pure computeHealth(agent) below — security/correctness-first, derived
  // entirely from the assembled artifact (no Date.now(); INV1/INV2).
  const human: HumanArtifact = {
    $schema: 'https://factstack.dev/schema/human.v1.json',
    factsVersion: FACTS_SCHEMA_VERSION,
    generatedAt: agent.generatedAt,
    summary: {
      oneLiner: oneLiner(frameworks, rootName, readmeOneLiner, pkgDescription),
      /* v0.3.9 — intent omitted when no real value exists. Pre-v0.3.9
         emitted empty string ''; readers couldn't tell "no intent
         detected" from "intent is empty". A real intent generator
         lives in v0.4. */
      capabilities: agent.capabilities,
      entryPoints: projectMeta.entryPoints.map((p: string) => ({
        label: p,
        kind: classifyEntryPoint(p),
        path: p,
        handlerFile: '',
        description: null,
      })),
      health: computeHealth(agent),
    },
    stack: languages.map((l) => ({
      name: l.label,
      kind: 'language',
      loc: l.loc,
      tokenCost: l.tokens,
      iconId: l.id,
    })),
    tree: buildHumanTree(outlines, rootName),
    // The human artifact isn't the symbol-graph carrier (that's the agent
    // artifact + the pack); keep its graph the file-level dependency view.
    graph: { ...depGraph, symbolNodes: [], symbolEdges: [], entities: [], entityEdges: [] },
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
    /* v0.3.9 — risks now go through applyRewrite at the agent level
       above; the human-artifact mirrors the same already-rewritten
       array so the dashboard doesn't show technical text the agent
       summary already softened. */
    risks: secrets.map((r) => applyRewrite(r)),
    /* v0.3.9 — glossary omitted when empty. The empty-array stub was
       lying about future capability. Populated when a real glossary
       generator ships (v0.5). */
  };

  /* v0.3.10 — deterministic intent generator. Composes signals from
     frameworks + monorepo shape + sub-apps under apps/ + routes into
     one CXO-readable sentence. Returns null when no signal is strong
     enough — caller (the dashboard) falls through to oneLiner. */
  const intent = inferIntent(agent, human);
  if (intent !== null) {
    human.summary.intent = intent;
  }

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
  const hasAstro = fwSet.has('Astro');
  const hasReactRouter = fwSet.has('React Router');
  // If a route extractor matched a file convention but the project's
  // manifest doesn't actually use that framework, re-label to the most
  // accurate alternative we have evidence for. Common case: a Vite SPA
  // with `src/pages/` triggers nextjs detection without Next.js being
  // installed; same shape for Astro projects without Astro.
  return routes.map((r) => {
    if (r.framework === 'nextjs' && !hasNext) {
      return { ...r, framework: hasReactRouter ? 'react-router' : 'spa-page' };
    }
    if (r.framework === 'remix' && !hasRemix) {
      return { ...r, framework: hasReactRouter ? 'react-router' : 'spa-page' };
    }
    if (r.framework === 'astro' && !hasAstro) {
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

/** Resolve a `./` / `../` import specifier against the importing file's
 *  directory into a root-relative POSIX path. Returns null for bare
 *  specifiers and for paths that escape the project root. */
function resolveRelativeSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
  const slash = fromFile.lastIndexOf('/');
  const stack = slash >= 0 ? fromFile.slice(0, slash).split('/') : [];
  for (const seg of spec.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (stack.length === 0) return null; // escapes the root — can't probe
      stack.pop();
    } else {
      stack.push(seg);
    }
  }
  return stack.length ? stack.join('/') : null;
}

/** Suffixes probed when checking whether an unresolved import exists on
 *  disk outside the walked set. The literal path first (covers explicit
 *  `./dist/x.js` imports); extensionless conventions after. Small on
 *  purpose — this runs only for already-unresolved project-local imports. */
const UNSCANNED_PROBE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'];

async function existsOutsideScan(fs: FactsFS, rootPath: string, relPath: string): Promise<boolean> {
  for (const suffix of UNSCANNED_PROBE_SUFFIXES) {
    try {
      const st = await fs.stat(fs.join(rootPath, relPath + suffix));
      if (st.isFile) return true;
    } catch {
      /* not there under this suffix — keep probing */
    }
  }
  return false;
}

function minimalOutline(f: WalkedFile, status: FileOutline['status']): FileOutline {
  return {
    path: f.path,
    // Language comes from the extension, which we know even when the
    // CONTENT was never read — an unreadable engine.ts is still
    // TypeScript. `other` only for genuinely unknown extensions.
    language: detectLanguage(f.ext)?.id ?? 'other',
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
    /* Skipped / minimal outlines emit 0 minutes (not the floored 1)
       so they don't inflate folder rollups — per the architect's risk
       note. The full path produces a real number through computeReadingTime. */
    readingMinutes: 0,
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
    if (/^[-*+]\s/.test(trimmed)) continue;
    if (/^\d+\.\s/.test(trimmed)) continue;
    if (/^!\[/.test(trimmed)) continue;            // image-only line (badges)
    if (/^<[a-zA-Z!]/.test(trimmed)) continue;     // raw HTML
    if (/^\[!\[/.test(trimmed)) continue;          // linked badges [![...]
    // Strip the leading `> ` of a blockquote — README authors often
    // put the project's tagline in a blockquote right under the title
    // (the GitHub convention). The content of that blockquote IS the
    // most useful one-liner, so we treat it as prose.
    line = trimmed.replace(/^>\s+/, '');
    // Drop trailing inline links/badges from prose lines.
    line = line.replace(/\s*\[!\[.*$/, '').trim();
    if (!line) continue;
    // Take just the first sentence — but skip terminators that are
    // actually abbreviations or version numbers. Naive `[.!?]` matching
    // truncates "E.g.", "i.e.", "v0.2", "Mr." etc. on the first dot.
    // Strategy: walk character-by-character looking for `[.!?]` followed
    // by whitespace AND preceded by something other than a 1-2 letter
    // word or digit. Falls through to the first 240 chars when no
    // robust terminator is found.
    return findFirstSentence(line);
  }
  return null;
}

/**
 * Sentence finder that tolerates common English abbreviations and
 * version numbers. Walks the string and looks for a terminator
 * (`. ? !`) immediately followed by whitespace/end-of-line, where
 * the preceding 1–2 chars don't look like an abbreviation.
 *
 * Examples:
 *   "E.g. an apple. The end."   → "E.g. an apple."  (skips "g.")
 *   "v0.2 ships today."          → "v0.2 ships today."  (skips "0.")
 *   "Mr. Smith arrived."         → "Mr. Smith arrived."  (skips "r.")
 *   "Hello world."               → "Hello world."
 */
function findFirstSentence(line: string): string {
  // Cap at 240 chars. Most README first paragraphs fit; anything
  // longer becomes a digest of an over-long sentence anyway.
  const cap = 240;
  if (line.length <= cap && !/[.!?]/.test(line)) return line.trim();
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '.' || ch === '!' || ch === '?') {
      const next = line[i + 1];
      const nextIsBoundary = next == null || /\s/.test(next);
      if (nextIsBoundary) {
        // Look back at the previous 2-3 chars. Single letter + dot
        // (`E.g.`, `i.e.`) or digit + dot (`v0.2`) is an abbreviation;
        // we keep going. Anything longer than 2 letters is probably
        // a real sentence end.
        const before = line.slice(Math.max(0, i - 4), i);
        const isAbbrev = /(?:^|[\s.])[A-Za-z]\.[A-Za-z]?$/.test(before)
          || /\d$/.test(before);
        if (!isAbbrev) {
          return line.slice(0, i + 1).trim();
        }
      }
    }
    i++;
  }
  // No terminator found — return the line capped.
  return line.length > cap ? line.slice(0, cap - 1) + '…' : line.trim();
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

/* v0.3.6 — aggregate per-file env-var read sites into the name-keyed
 * structure stored in `agent.config.envVars`. Each unique NAME becomes
 * one EnvVar with:
 *   - reads[]: every read site (file + line + access + default)
 *   - defaults[]: distinct defaults seen across read sites
 *   - primaryAccess: the dominant access pattern when ≥75% of reads
 *     share it; otherwise null (mixed). The UI uses this to flag
 *     "the same var is read via process.env in 3 places and
 *     import.meta.env in 1" as a smell.
 *
 * Sorted by read count desc — most-used vars surface first. */
function aggregateEnvVars(perFile: Map<string, EnvVarRead[]>): AgentArtifact['config'] {
  const byName = new Map<string, Array<EnvVarRead & { file: string }>>();
  for (const [file, reads] of perFile) {
    for (const r of reads) {
      const arr = byName.get(r.name) ?? [];
      arr.push({ ...r, file });
      byName.set(r.name, arr);
    }
  }

  const envVars: NonNullable<AgentArtifact['config']>['envVars'] = [];
  for (const [name, reads] of byName) {
    // Stable sort: file path then line.
    reads.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
    const defaults = Array.from(
      new Set(reads.map((r) => r.defaultValue).filter((v): v is string => typeof v === 'string')),
    );
    // Find the dominant access pattern.
    const accessTally = new Map<string, number>();
    for (const r of reads) accessTally.set(r.access, (accessTally.get(r.access) ?? 0) + 1);
    type PrimaryAccess = NonNullable<AgentArtifact['config']>['envVars'][number]['primaryAccess'];
    let primaryAccess: PrimaryAccess = null;
    let maxCount = 0;
    for (const [access, count] of accessTally) {
      if (count > maxCount) {
        maxCount = count;
        primaryAccess = access as PrimaryAccess;
      }
    }
    if (maxCount / reads.length < 0.75) primaryAccess = null;
    envVars.push({
      name,
      reads: reads.map((r) => ({ file: r.file, line: r.line, access: r.access, defaultValue: r.defaultValue })),
      defaults,
      primaryAccess,
    });
  }
  envVars.sort((a, b) => (b.reads.length - a.reads.length) || (a.name < b.name ? -1 : 1));
  return { envVars, schemas: [] };
}
