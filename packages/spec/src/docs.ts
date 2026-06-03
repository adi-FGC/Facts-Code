/**
 * docs — the documentation-intelligence slice of the agent artifact.
 *
 * `analyze()` flags every documentation / spec file in a project and
 * parses its structure ONCE (headings, checkbox/TODO items, fenced
 * diagrams, tables, links) so both an AI agent and the dashboard's
 * "Docs" tab can reason over the project's prose without re-reading it.
 *
 * Raw content is carried (capped) so the dashboard can render a real
 * preview even in static-export mode where the filesystem is gone.
 *
 * Additive-only within a major version, same contract as agent/human.
 */

import { z } from 'zod';

/** How the doc is written — drives which renderer the UI reaches for. */
export const DocFormatSchema = z.enum([
  'markdown',
  'html',
  'text',
  'rst',
  'asciidoc',
  'openapi',
  'json-schema',
  'notebook',
  'other',
]);
export type DocFormat = z.infer<typeof DocFormatSchema>;

/** What ROLE the doc plays — drives grouping + the "kind" badge. */
export const DocKindSchema = z.enum([
  'readme',
  'changelog',
  'contributing',
  'license',
  'adr', // architecture decision record
  'roadmap',
  'spec',
  'api',
  'guide',
  'config-doc',
  'agent-doc', // CLAUDE.md / CONTEXT.md / AGENTS.md — instructions for AI tools
  'doc',
]);
export type DocKind = z.infer<typeof DocKindSchema>;

/** One heading, with depth + a url-safe slug for anchor linking. */
export const DocHeadingSchema = z.object({
  depth: z.number().int().min(1).max(6),
  text: z.string(),
  slug: z.string(),
  line: z.number().int().nonnegative(),
});
export type DocHeading = z.infer<typeof DocHeadingSchema>;

/**
 * One actionable item parsed from prose.
 *   - `done: true`  — a checked checkbox `- [x]`
 *   - `done: false` — an unchecked checkbox `- [ ]`
 *   - `done: null`  — a bare TODO/FIXME/HACK marker (no completion state)
 * This is what powers the Todos view + the verifiable Roadmap progress.
 */
export const DocTodoSchema = z.object({
  done: z.boolean().nullable(),
  text: z.string(),
  line: z.number().int().nonnegative(),
  /** Marker tag (TODO/FIXME/…) when `done` is null; absent for checkboxes. */
  tag: z.string().optional(),
  /** The nearest heading above this item — lets the UI group todos by section. */
  section: z.string().optional(),
});
export type DocTodo = z.infer<typeof DocTodoSchema>;

/** A fenced diagram (mermaid / plantuml / dot) lifted from a doc. */
export const DocDiagramSchema = z.object({
  kind: z.enum(['mermaid', 'plantuml', 'dot', 'code']),
  /** mermaid graph subtype when detectable: flowchart / sequenceDiagram /
   *  erDiagram / classDiagram / gantt / stateDiagram / etc. Null otherwise. */
  type: z.string().nullable(),
  /** The fence language token (e.g. "mermaid"). */
  lang: z.string().nullable(),
  code: z.string(),
  line: z.number().int().nonnegative(),
});
export type DocDiagram = z.infer<typeof DocDiagramSchema>;

/** An outbound link found in the doc. */
export const DocLinkSchema = z.object({
  text: z.string(),
  href: z.string(),
  line: z.number().int().nonnegative(),
  /** True when the href looks external (http/https/mailto). */
  external: z.boolean().default(false),
});
export type DocLink = z.infer<typeof DocLinkSchema>;

export const DocFileSchema = z.object({
  path: z.string(),
  name: z.string(),
  ext: z.string(),
  format: DocFormatSchema,
  kind: DocKindSchema,
  bytes: z.number().int().nonnegative(),
  loc: z.number().int().nonnegative(),
  /** First H1 (or first heading, or the filename) — the display title. */
  title: z.string(),
  wordCount: z.number().int().nonnegative().default(0),
  readingMinutes: z.number().nonnegative().default(0),
  headings: z.array(DocHeadingSchema).default([]),
  todos: z.array(DocTodoSchema).default([]),
  diagrams: z.array(DocDiagramSchema).default([]),
  links: z.array(DocLinkSchema).default([]),
  tableCount: z.number().int().nonnegative().default(0),
  /** Raw source, capped (see DOC_CONTENT_CAP). `null` when omitted because
   *  the doc exceeded the per-artifact content budget. */
  content: z.string().nullable().default(null),
  /** True when `content` was cut to the cap (UI shows a "truncated" note). */
  truncated: z.boolean().default(false),
  lastModifiedMs: z.number().nonnegative().nullable().default(null),
});
export type DocFile = z.infer<typeof DocFileSchema>;
