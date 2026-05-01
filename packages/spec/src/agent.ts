/**
 * agent.json — AI-agent-optimized codebase artifact.
 *
 * Path-addressable, dense, versioned. Designed for LLM consumption via
 * tool calls keyed by stable file paths. Streamable companion:
 * agent.jsonl (one FileOutline per line).
 */

import { z } from 'zod';

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

export const StatusSchema = z.enum(['ok', 'broken', 'stale', 'parse_error']);

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
});

export const GraphEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.enum(['import', 'dynamic-import', 'type-import']),
});

export const GraphSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  cycles: z.array(z.array(z.string())),
});

export const RiskSchema = z.object({
  severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
  category: z.enum([
    'secret',
    'license',
    'supply-chain',
    'parse-error',
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
});
export type AgentArtifact = z.infer<typeof AgentArtifactSchema>;
