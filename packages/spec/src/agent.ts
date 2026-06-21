/**
 * agent.json — AI-agent-optimized codebase artifact.
 *
 * Path-addressable, dense, versioned. Designed for LLM consumption via
 * tool calls keyed by stable file paths. Streamable companion:
 * agent.jsonl (one FileOutline per line).
 */

import { z } from 'zod';
import { DocFileSchema } from './docs.js';
import { StyleAuditSchema } from './styles.js';

export const FACTS_SCHEMA_VERSION = '0.1.0' as const;

export const SymbolKindSchema = z.enum([
  'function',
  'method',
  'class',
  'interface',
  'type',
  'enum',
  'constant',
  'variable',
  'component',
  'hook',
  'region',
  'route',
]);

/** `read_error` — the walker could not read the file (transient lock, race,
 *  permissions). Metrics on such rows (loc/tok 0) are placeholders, NOT
 *  measurements: a real-world eval saw an agent conclude a 338-line file was
 *  empty because a misread row said `ok`. Producers must never emit `ok` for
 *  a file whose content was never read. */
export const StatusSchema = z.enum(['ok', 'broken', 'stale', 'parse_error', 'read_error']);

export const SymbolSchema = z.object({
  name: z.string(),
  kind: SymbolKindSchema,
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  exported: z.boolean(),
  docstring: z.string().optional(),
  children: z.array(z.lazy((): z.ZodTypeAny => SymbolSchema)).optional(),
});
export type Symbol = z.infer<typeof SymbolSchema>;

export const ImportSchema = z.object({
  source: z.string(),
  resolved: z.string().nullable(),
  specifiers: z.array(z.string()),
  isTypeOnly: z.boolean().default(false),
});

export const ExportSchema = z.object({
  name: z.string(),
  kind: SymbolKindSchema,
  isDefault: z.boolean().default(false),
});

export const RouteDeclSchema = z.object({
  framework: z.string(),
  method: z.string().nullable(),
  path: z.string(),
  handlerFile: z.string(),
  handlerSymbol: z.string().nullable(),
});
export type RouteDecl = z.infer<typeof RouteDeclSchema>;

export const ComponentSchema = z.object({
  name: z.string(),
  file: z.string(),
  framework: z.enum(['react', 'vue', 'svelte', 'solid']),
  isDefaultExport: z.boolean().default(false),
});

export const TestDeclSchema = z.object({
  framework: z.string(),
  file: z.string(),
  describesFile: z.string().nullable(),
  testCount: z.number().int().nonnegative(),
});

export const TodoSchema = z.object({
  kind: z.enum(['TODO', 'FIXME', 'HACK', 'XXX', 'NOTE']),
  text: z.string(),
  line: z.number().int().positive(),
  authoredAt: z.string().nullable(),
});

export const ComplexitySchema = z.object({
  cyclomatic: z.number().int().nonnegative(),
  cognitive: z.number().int().nonnegative(),
});

export const FileOutlineSchema = z.object({
  path: z.string(),
  language: z.string(),
  loc: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  bundleSize: z
    .object({
      raw: z.number().int().nonnegative(),
      minified: z.number().int().nonnegative(),
      gzipped: z.number().int().nonnegative(),
    })
    .nullable(),
  tokenCost: z.number().int().nonnegative(),
  imports: z.array(ImportSchema),
  exports: z.array(ExportSchema),
  declarations: z.array(SymbolSchema),
  routes: z.array(RouteDeclSchema).optional(),
  components: z.array(ComponentSchema).optional(),
  tests: z.array(TestDeclSchema).optional(),
  todos: z.array(TodoSchema),
  complexity: ComplexitySchema,
  status: StatusSchema,
  lastModifiedMs: z.number().nonnegative().nullable(),
  churnScore: z.number().nonnegative().nullable(),
  /** v0.3.8 — estimated read-through time in minutes. Floored at 1
   *  for non-empty files; folders and skipped files emit 0. Optional
   *  for backward-compat with pre-v0.3.8 artifacts. */
  readingMinutes: z.number().nonnegative().optional(),
  /** v0.3.8 — top-3 git contributors by commit count, with last-touched
   *  timestamps. Empty / absent when no git history is available
   *  (zip-only, fresh clone, etc). */
  topContributors: z.array(
    z.object({
      email: z.string(),
      name: z.string(),
      commits: z.number().int().nonnegative(),
      lastTouchedMs: z.number().nonnegative(),
    }),
  ).optional(),
});
export const ContributorSchema = z.object({
  email: z.string(),
  name: z.string(),
  commits: z.number().int().nonnegative(),
  lastTouchedMs: z.number().nonnegative(),
});
export type Contributor = z.infer<typeof ContributorSchema>;
export type FileOutline = z.infer<typeof FileOutlineSchema>;

export const GraphNodeSchema = z.object({
  id: z.string(),
  path: z.string(),
  language: z.string(),
  loc: z.number().int().nonnegative(),
  tokenCost: z.number().int().nonnegative(),
  status: StatusSchema,
  /** File paths that import this node. Optional for backward compat;
   *  populated by buildCallerIndex in @factstack/graph. */
  callers: z.array(z.string()).optional(),
  /** F5 — graph importance (normalized PageRank over the import graph, top
   *  node = 1.0). Optional + absent on pre-F5 artifacts (INV4), so
   *  FACTS_SCHEMA_VERSION stays 0.1.0. Deterministic: fixed-iteration power
   *  method, path-sorted, rounded. */
  importance: z.number().min(0).max(1).optional(),
  /** F5 — community id from deterministic label propagation. Communities are
   *  renumbered by smallest-member path so the id of an existing cluster is
   *  stable as the graph grows. Optional/absent pre-F5 (INV4). */
  community: z.number().int().nonnegative().optional(),
});

/**
 * F1 — how a graph edge was established. `extracted` = read directly from
 * source (every import edge today); `inferred` = resolved/deduced (F2 symbol
 * resolution); `ambiguous` = name-match only, flagged for review. Listed
 * most→least certain so the enum order is meaningful.
 */
export const ConfidenceSchema = z.enum(['extracted', 'inferred', 'ambiguous']);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const GraphEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.enum(['import', 'dynamic-import', 'type-import']),
  /** F1 — provenance of this edge. Import edges are always `extracted`. The
   *  `.default` keeps artifacts written before F1 valid on read (INV4), so
   *  FACTS_SCHEMA_VERSION stays put. */
  confidence: ConfidenceSchema.default('extracted'),
  /** F1 — optional 0..1 certainty, set for `inferred`/`ambiguous` edges (F2). */
  confidenceScore: z.number().min(0).max(1).optional(),
});

/**
 * F2 — a declaration as a graph-addressable node. The id is the stable scheme
 * `path#name@startLine` (path + name + line disambiguates overloads and
 * same-named decls), built via `symbolId()` — the single source of truth.
 */
export const SymbolNodeSchema = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  kind: SymbolKindSchema,
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  exported: z.boolean(),
});
export type SymbolNode = z.infer<typeof SymbolNodeSchema>;

/**
 * F2 — an edge in the symbol graph: a reference from one declaration to
 * another. `kind` is how it appears in source (call/read/jsx/type-ref) plus
 * the class relationships (implements/extends). Carries the F1 `confidence`:
 * `extracted` (same-file), `inferred` (import- or single-match-resolved),
 * `ambiguous` (name collides across files).
 */
export const SymbolEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.enum(['call', 'read', 'jsx', 'type-ref', 'implements', 'extends']),
  confidence: ConfidenceSchema.default('extracted'),
  confidenceScore: z.number().min(0).max(1).optional(),
});
export type SymbolEdge = z.infer<typeof SymbolEdgeSchema>;

/** F2 — the canonical symbol id: `path#name@startLine`. Single source of truth
 *  for the format; the resolver, pack encoder, and every consumer that builds
 *  an id must call this so ids match across the artifact. */
export function symbolId(path: string, name: string, startLine: number): string {
  return `${path}#${name}@${startLine}`;
}

/**
 * F10 — a unit of design rationale ("the why") linked to the code it explains.
 * `symbol` is the enclosing F2 symbol id, or null when the item sits at module
 * level (file-only). `kind` lowercases the TODO-family kinds plus `docstring`.
 */
export const RationaleKindSchema = z.enum(['todo', 'fixme', 'hack', 'xxx', 'note', 'docstring']);
export type RationaleKind = z.infer<typeof RationaleKindSchema>;

export const RationaleSchema = z.object({
  /** Stable id: `${file}@${line}#${kind}`. */
  id: z.string(),
  /** Enclosing symbol id (F2), or null for a file-level item. */
  symbol: z.string().nullable(),
  file: z.string(),
  line: z.number().int().nonnegative(),
  kind: RationaleKindSchema,
  text: z.string(),
});
export type Rationale = z.infer<typeof RationaleSchema>;

/**
 * F11 — whole-stack modalities. An *entity* is a non-code graph node: a SQL
 * table/view, an infrastructure resource (Terraform/HCL), or a documentation
 * artifact. Entities live alongside file + symbol nodes so one graph spans app
 * code + data layer + infra. `modality` is derivable from `kind` but kept
 * explicit for cheap filtering by consumers.
 */
export const EntityKindSchema = z.enum(['table', 'view', 'resource', 'doc']);
export type EntityKind = z.infer<typeof EntityKindSchema>;

export const EntityModalitySchema = z.enum(['sql', 'iac', 'doc']);
export type EntityModality = z.infer<typeof EntityModalitySchema>;

export const EntityNodeSchema = z.object({
  /** Deterministic id (see `entityId`): `db:schema.table`, `tf:type.name`,
   *  or `doc:path`. */
  id: z.string(),
  kind: EntityKindSchema,
  name: z.string(),
  modality: EntityModalitySchema,
  /** Defining file (project-relative). */
  file: z.string(),
  /** 1-indexed line of the declaration; 0 when not line-addressable. */
  line: z.number().int().nonnegative().default(0),
  /** Kind-specific summary: column list (table), resource type (iac), or
   *  title (doc). Null when absent. */
  detail: z.string().nullable().default(null),
});
export type EntityNode = z.infer<typeof EntityNodeSchema>;

/**
 * F11 — an edge in the entity graph. `fk` (SQL foreign key, table→table),
 * `depends-on` (IaC resource→resource), `documents` (doc→file/symbol/entity),
 * `references` (generic soft reference, e.g. a view→table). Carries the F1
 * `confidence` so doc/name-inferred links are flagged for review.
 */
export const EntityEdgeKindSchema = z.enum(['fk', 'depends-on', 'documents', 'references']);
export type EntityEdgeKind = z.infer<typeof EntityEdgeKindSchema>;

export const EntityEdgeSchema = z.object({
  /** Source id: an entity id, or a file path / symbol id (for `documents`). */
  from: z.string(),
  to: z.string(),
  kind: EntityEdgeKindSchema,
  confidence: ConfidenceSchema.default('extracted'),
  /** 1-indexed line where the relationship is declared, or null. */
  line: z.number().int().nonnegative().nullable().default(null),
});
export type EntityEdge = z.infer<typeof EntityEdgeSchema>;

/** F11 — the canonical entity id. Single source of truth (mirrors `symbolId`):
 *  `sql` → `db:${parts.join('.')}`, `iac` → `tf:${parts.join('.')}`,
 *  `doc` → `doc:${path}`. Every producer must call this so ids match. */
export function entityId(modality: EntityModality, ...parts: string[]): string {
  const prefix = modality === 'sql' ? 'db' : modality === 'iac' ? 'tf' : 'doc';
  const sep = modality === 'doc' ? '/' : '.';
  return `${prefix}:${parts.join(sep)}`;
}

export const GraphSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  cycles: z.array(z.array(z.string())),
  /** F2 — symbol-level graph: declarations as nodes, references as edges.
   *  Additive defaults so pre-F2 artifacts validate unchanged (INV4); empty
   *  unless analysis ran with symbol resolution enabled (`--symbols`). */
  symbolNodes: z.array(SymbolNodeSchema).default([]),
  symbolEdges: z.array(SymbolEdgeSchema).default([]),
  /** F11 — whole-stack entity graph: SQL tables/views, IaC resources, doc
   *  nodes, plus cross-modality edges (fk / depends-on / documents). Additive
   *  defaults keep pre-F11 artifacts valid (INV4); FACTS_SCHEMA_VERSION stays. */
  entities: z.array(EntityNodeSchema).default([]),
  entityEdges: z.array(EntityEdgeSchema).default([]),
});

export const RiskSchema = z.object({
  severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
  category: z.enum([
    'secret',
    'license',
    'supply-chain',
    'parse-error',
    'read-error',
    'broken-import',
    'stale',
    'large-file',
    'cycle',
  ]),
  rule: z.string(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  message: z.string(),
  /** v0.3.8 — when set, the original technical message that the CXO
   *  rewrite replaced. Agents read both; UI hides this behind a
   *  `<details>` disclosure. Absent when the rule had no rewrite. */
  messageTechnical: z.string().optional(),
  /** Redacted preview — raw secret values MUST NOT appear here. */
  preview: z.string().optional(),
});
export type Risk = z.infer<typeof RiskSchema>;

export const ProjectMetaSchema = z.object({
  name: z.string(),
  root: z.string(),
  languages: z.array(z.string()),
  frameworks: z.array(z.string()),
  entryPoints: z.array(z.string()),
  monorepo: z
    .object({
      manager: z.enum(['pnpm', 'npm', 'yarn', 'turbo', 'nx', 'lerna', 'cargo', 'go']),
      workspaces: z.array(z.string()),
    })
    .nullable(),
  /**
   * v0.3.9 — true when `git` was available and the analyzer mined
   * history; false when the project is a zip-clone or fresh init.
   *
   * IMPORTANT for agents: `FileOutline.churnScore` and the `topContributors`
   * arrays will be **null/missing** (NOT silently zero) when this flag is
   * false. Read this before drawing conclusions about "stable" files.
   */
  gitAvailable: z.boolean().optional(),
});
export type ProjectMeta = z.infer<typeof ProjectMetaSchema>;

export const StatsSchema = z.object({
  loc: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  packageCount: z.number().int().nonnegative(),
  totalTokenCost: z.number().int().nonnegative(),
});

/* v0.3.6 — env-var + config-schema surface.
 *
 * `EnvVarReadSchema` is one read site. `EnvVarSchema` aggregates all
 * reads of the same NAME (a single var read in 12 places becomes one
 * EnvVar with 12 read sites + the union of distinct defaults seen).
 * Backward-compat: agents that pre-date v0.3.6 simply lack `config`. */
export const EnvVarAccessSchema = z.enum([
  'process.env',
  'import.meta.env',
  'os.getenv',
  'os.environ',
  'destructure',
  'unknown',
]);

export const EnvVarReadSchema = z.object({
  file: z.string(),
  line: z.number().int().nonnegative(),
  access: EnvVarAccessSchema,
  defaultValue: z.string().nullable(),
});

export const EnvVarSchema = z.object({
  name: z.string(),
  reads: z.array(EnvVarReadSchema),
  /** Distinct defaults seen across read sites (deduped). */
  defaults: z.array(z.string()),
  /** Best-guess access pattern when one dominates; null if mixed. */
  primaryAccess: EnvVarAccessSchema.nullable(),
});
export type EnvVar = z.infer<typeof EnvVarSchema>;
export type EnvVarRead = z.infer<typeof EnvVarReadSchema>;

export const ConfigSchema = z.object({
  envVars: z.array(EnvVarSchema),
  /** Reserved for v0.3.6.1: extracted Zod / Pydantic config shapes. */
  schemas: z.array(z.unknown()).default([]),
});
export type Config = z.infer<typeof ConfigSchema>;

/* ─────────── Security tier (v0.6 / 2026-05-27) ───────────
 *
 * Two additive surfaces — both default to [] so pre-v0.6 artifacts
 * validate unchanged and the schema version stays at 0.1.0:
 *
 *   - dependencyManifests[] — every detected manifest file
 *     (package.json, pyproject.toml, Cargo.toml, go.mod, pom.xml,
 *     Gemfile) parsed into a uniform dep-list shape. Produced by
 *     @factstack/scanners' scanDependencyManifest during analyze.
 *     Always populated (empty when no manifests detected).
 *
 *   - vulnerabilities[] — CVE findings cross-referenced against
 *     OSV.dev. NOT populated by analyze (no network in core); the
 *     opt-in `factstack scan-vulns` CLI subcommand fetches and
 *     persists them. Defaults to [].
 *
 * Why two separate fields instead of nesting vulns under manifests:
 *   - Flat queries are simpler ("show all critical CVEs across the
 *     whole monorepo" vs "iterate manifests, then iterate deps").
 *   - The MCP server's list_vulnerabilities tool returns a flat list
 *     regardless of manifest origin — matches the SQL-ish shape AI
 *     agents expect from a "findings" surface.
 *   - Manifest provenance is preserved via the per-finding
 *     `manifestPath` field. No information lost.
 */

export const ManifestEcosystemSchema = z.enum([
  'npm',
  'pypi',
  'cargo',
  'go',
  'maven',
  'rubygems',
  'unknown',
]);
export type ManifestEcosystem = z.infer<typeof ManifestEcosystemSchema>;

export const DependencyManifestSchema = z.object({
  /** Path relative to project root. e.g. "package.json", "apps/cli/package.json". */
  path: z.string(),
  ecosystem: ManifestEcosystemSchema,
  /** Declared package name. Null for root workspaces / private apps
   *  that omit `name`, and for ecosystems that don't require it. */
  name: z.string().nullable(),
  /** Declared package version. Null when not declared (root workspaces,
   *  applications). The OSV query uses each dep's version, NOT this. */
  version: z.string().nullable(),
  /** Runtime dependencies. Map from package name to declared version
   *  spec ("^4.17.21", "~1.0.0", "1.2.3", "workspace:*"). The OSV
   *  client normalizes these to concrete versions before querying. */
  dependencies: z.record(z.string(), z.string()).default({}),
  /** Dev-only dependencies. Kept separate so consumers can choose
   *  whether to scan them — most CI gates include them since they
   *  ship in tarballs and run during build. */
  devDependencies: z.record(z.string(), z.string()).default({}),
});
export type DependencyManifest = z.infer<typeof DependencyManifestSchema>;

export const VulnerabilitySeveritySchema = z.enum([
  'critical',
  'high',
  'medium',
  'low',
  'unknown',
]);
export type VulnerabilitySeverity = z.infer<typeof VulnerabilitySeveritySchema>;

export const VulnerabilitySchema = z.object({
  /** OSV / CVE / GHSA identifier ("CVE-2024-1234", "GHSA-abcd-1234-..."). */
  id: z.string(),
  /** One-line summary from the advisory. Optional — some advisories
   *  carry only details, no summary. */
  summary: z.string().optional(),
  severity: VulnerabilitySeveritySchema,
  ecosystem: ManifestEcosystemSchema,
  /** Affected package name ("lodash", "django"). */
  package: z.string(),
  /** Version installed in the project that triggered this finding. */
  installedVersion: z.string(),
  /** First version that fixes the vulnerability; null when unpatched
   *  or when the OSV record doesn't carry a `fixed` event. */
  fixedVersion: z.string().nullable(),
  /** Best-effort URL to the advisory (GHSA page, vendor advisory,
   *  fallback to osv.dev/vulnerability/{id}). SEC-1: must be an http(s) URL —
   *  rejects a poisoned `javascript:`/`data:` advisory URL at the artifact
   *  boundary (the producer already filters, this is the schema backstop). '' is
   *  tolerated so a legacy artifact with a blank URL still loads. */
  advisoryUrl: z.string().refine((s) => s === '' || /^https?:\/\//i.test(s), {
    message: 'advisoryUrl must be an http(s) URL',
  }),
  /** UNIX ms timestamp when scan-vulns last queried for this finding.
   *  The UI uses this to decide whether to re-query live or trust the
   *  artifact's snapshot. */
  lastChecked: z.number().int().positive(),
  /** Path of the manifest where the dep was declared. Lets the UI
   *  group findings by manifest in monorepos. */
  manifestPath: z.string(),
});
export type Vulnerability = z.infer<typeof VulnerabilitySchema>;

/**
 * v0.11 — metadata for the last completed vulnerability scan. This is what
 * makes the vulnerability list UPDATABLE instead of write-once:
 *
 *   - An EMPTY `vulnerabilities` array is ambiguous on its own ("scanned and
 *     clean" vs "never scanned" vs "wiped by re-analyze"). `scannedAt` here
 *     disambiguates: present + empty list = verified clean at that time.
 *   - `scannedAt` is the staleness anchor — new CVEs are published daily, so
 *     every reader (CLI summary, MCP list_vulnerabilities, dashboard) compares
 *     it against "now" and tells the user/agent when to refresh.
 *   - Carried FORWARD by the CLI/MCP across re-analyzes (analyze itself never
 *     touches the network — INV6), so a scan survives artifact regeneration.
 */
export const VulnerabilityScanSchema = z.object({
  /** ISO 8601 timestamp of the last completed scan. */
  scannedAt: z.string(),
  /** Advisory source queried. */
  source: z.literal('osv.dev').default('osv.dev'),
  /** Distinct (ecosystem, name, version) packages queried. */
  packagesQueried: z.number().int().nonnegative(),
  /** Non-registry deps (workspace:/file:/git:) that could not be queried. */
  packagesSkipped: z.number().int().nonnegative(),
  /** Findings count at scan time — with an empty list this is the explicit
   *  "scanned and clean" marker. */
  findings: z.number().int().nonnegative(),
  /** EH-3: how many advisories degraded to id-only because their OSV detail
   *  fetch failed during this scan. Absent/0 = a fully-hydrated scan; > 0 means
   *  some severities may read 'unknown' purely from fetch failure, not truth.
   *  Optional + additive (INV4): older artifacts simply omit it. */
  detailsFailed: z.number().int().nonnegative().optional(),
});
export type VulnerabilityScan = z.infer<typeof VulnerabilityScanSchema>;

export const AgentArtifactSchema = z.object({
  $schema: z.literal('https://factstack.dev/schema/agent.v1.json').default(
    'https://factstack.dev/schema/agent.v1.json',
  ),
  factsVersion: z.literal(FACTS_SCHEMA_VERSION).default(FACTS_SCHEMA_VERSION),
  generatedAt: z.string(),
  project: ProjectMetaSchema,
  files: z.array(FileOutlineSchema),
  graph: GraphSchema,
  routes: z.array(RouteDeclSchema),
  scripts: z.record(z.string(), z.string()),
  capabilities: z.array(z.string()),
  risks: z.array(RiskSchema),
  stats: StatsSchema,
  /** v0.3.6 — env-var inventory. Optional for backward-compat with
   *  pre-v0.3.6 artifacts; renderers fall back to "no config data" when
   *  absent. */
  config: ConfigSchema.optional(),
  /** v0.6 — every detected dep manifest with its dep map. Always
   *  populated (empty when no manifests found). Default keeps
   *  pre-v0.6 artifacts validating unchanged. */
  dependencyManifests: z.array(DependencyManifestSchema).default([]),
  /** v0.6 — CVE findings from the last `factstack scan-vulns` run.
   *  Empty by default (analyze doesn't make network calls). The UI's
   *  Vulnerabilities page reads from here first, falls back to live
   *  OSV query when empty or stale. */
  vulnerabilities: z.array(VulnerabilitySchema).default([]),
  /** v0.11 — metadata for the last completed vulnerability scan: the
   *  staleness anchor + the explicit "scanned and clean" marker. Absent
   *  until the first scan (and on pre-v0.11 artifacts — INV4). The CLI/MCP
   *  carry it forward across re-analyzes so scans survive regeneration;
   *  refresh via `factstack scan-vulns` or the MCP list_vulnerabilities
   *  tool's `refresh: true`. */
  vulnerabilityScan: VulnerabilityScanSchema.optional(),
  /** v0.8 — documentation intelligence. Every flagged doc/spec file with
   *  parsed structure (headings, todos, diagrams) + capped raw content.
   *  Powers the dashboard's Docs tab + agent doc-discovery. Default keeps
   *  pre-v0.8 artifacts validating unchanged. */
  docs: z.array(DocFileSchema).default([]),
  /** F10 — design rationale (NOTE/HACK/FIXME/TODO/XXX comments + docstrings)
   *  linked to the symbol they explain. Additive default keeps pre-F10
   *  artifacts valid (INV4). Populated by buildRationale in @factstack/core. */
  rationale: z.array(RationaleSchema).default([]),
  /** v0.8 — CSS / styling audit of the scanned project (class map, selector
   *  specificity, conflicts, responsive breakpoint coverage, paradigms,
   *  lightningcss/tooling check). Optional for backward-compat; absent when
   *  the project has no CSS sources. */
  styles: StyleAuditSchema.optional(),
});
export type AgentArtifact = z.infer<typeof AgentArtifactSchema>;
