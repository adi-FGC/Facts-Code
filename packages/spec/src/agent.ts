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
});
export type FileOutline = z.infer<typeof FileOutlineSchema>;

export const GraphNodeSchema = z.object({
  id: z.string(),
  path: z.string(),
  language: z.string(),
  loc: z.number().int().nonnegative(),
  tokenCost: z.number().int().nonnegative(),
  status: StatusSchema,
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
});

export const StatsSchema = z.object({
  loc: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  packageCount: z.number().int().nonnegative(),
  totalTokenCost: z.number().int().nonnegative(),
});

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
});
export type AgentArtifact = z.infer<typeof AgentArtifactSchema>;
