/**
 * human.json — CXO-readable dashboard artifact.
 *
 * Same analysis as agent.json, reshaped for narrative consumption.
 * Every field maps to a UI block. No field without a screen.
 */

import { z } from 'zod';
import { FACTS_SCHEMA_VERSION, GraphSchema, RiskSchema, StatusSchema } from './agent.js';

export const StackEntrySchema = z.object({
  name: z.string(),
  kind: z.enum(['language', 'framework', 'runtime', 'tool']),
  loc: z.number().int().nonnegative(),
  tokenCost: z.number().int().nonnegative(),
  iconId: z.string(),
});

export const TreeNodeSchema: z.ZodType<{
  id: string;
  name: string;
  path: string;
  kind: 'directory' | 'file';
  language: string | null;
  loc: number;
  tokenCost: number;
  bundleSizeGzip: number | null;
  status: z.infer<typeof StatusSchema>;
  children: z.infer<typeof TreeNodeSchema>[] | null;
}> = z.lazy(() =>
  z.object({
    id: z.string(),
    name: z.string(),
    path: z.string(),
    kind: z.enum(['directory', 'file']),
    language: z.string().nullable(),
    loc: z.number().int().nonnegative(),
    tokenCost: z.number().int().nonnegative(),
    bundleSizeGzip: z.number().int().nonnegative().nullable(),
    status: StatusSchema,
    children: z.array(TreeNodeSchema).nullable(),
  }),
);

export const EntryPointSchema = z.object({
  label: z.string(),
  kind: z.enum(['http-route', 'page', 'screen', 'cli-command', 'event-handler']),
  path: z.string(),
  handlerFile: z.string(),
  description: z.string().nullable(),
});

export const ActivityEntrySchema = z.object({
  file: z.string(),
  lastModifiedMs: z.number().nonnegative(),
  churnScore: z.number().nonnegative(),
  authorCount: z.number().int().nonnegative(),
});

export const HealthHeadlineSchema = z.object({
  broken: z.number().int().nonnegative(),
  todos: z.number().int().nonnegative(),
  secrets: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
  headline: z.string(),
});

export const SummarySchema = z.object({
  oneLiner: z.string(),
  /**
   * Inferred intent from README + manifests + route semantics.
   * Deterministic in v0.1 (no LLM). Flagged in UI if AI-polished later.
   */
  intent: z.string(),
  capabilities: z.array(z.string()),
  entryPoints: z.array(EntryPointSchema),
  health: HealthHeadlineSchema,
});

export const GlossaryEntrySchema = z.object({
  term: z.string(),
  plainEnglish: z.string(),
});

export const HumanArtifactSchema = z.object({
  $schema: z
    .literal('https://factstack.dev/schema/human.v1.json')
    .default('https://factstack.dev/schema/human.v1.json'),
  factsVersion: z.literal(FACTS_SCHEMA_VERSION).default(FACTS_SCHEMA_VERSION),
  generatedAt: z.string(),
  summary: SummarySchema,
  stack: z.array(StackEntrySchema),
  tree: TreeNodeSchema,
  graph: GraphSchema,
  activity: z.array(ActivityEntrySchema),
  risks: z.array(RiskSchema),
  glossary: z.array(GlossaryEntrySchema),
});
export type HumanArtifact = z.infer<typeof HumanArtifactSchema>;
