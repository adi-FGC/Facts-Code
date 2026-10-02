/**
 * JSON Schema export for the FACTS artifact schemas.
 *
 * Lets a connecting AI agent introspect `agent.json` / `human.json`
 * shapes via the MCP `facts://schema/{kind}` resource WITHOUT reading
 * a megabyte of example data. Critical because:
 *
 *   1. New agents on a fresh project don't know what fields exist.
 *   2. Tooling that wraps FACTS (lint, codegen, type-emit) needs a
 *      stable JSON Schema to consume.
 *   3. The schema-version contract (per spec §11) is enforceable on
 *      both sides only when the schema itself is discoverable.
 *
 * Converted with zod's own `z.toJSONSchema` (zod 4; the zod-to-json-schema
 * package only understands zod 3). The output keeps the shape this resource
 * has always served: JSON Schema draft-07 with the root under
 * `definitions.<Name>` and a top-level `$ref` to it — wide consumer support.
 * Recursive shapes (symbol children, tree nodes) are emitted as `$ref`s into
 * the same `definitions`.
 *
 * Pure / no Node imports — usable in any environment that already
 * has the spec package.
 */

import { z } from './zod.js';
import { AgentArtifactSchema } from './agent.js';
import { HumanArtifactSchema } from './human.js';

/** Draft-07 with the root named, as zod-to-json-schema's `name` option did. */
function namedDraft7(name: string, schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, {
    target: 'draft-7',
    // The accepted INPUT shape: every `.default()` field stays optional, so an
    // artifact written before an additive field still validates (INV4). The
    // producer writes the raw object, not the parsed one, so on-disk files do
    // not carry the defaults. Objects stay open, matching zod's strip-on-parse.
    io: 'input',
    // A type JSON Schema cannot express becomes `{}` rather than throwing
    // inside an MCP resource read.
    unrepresentable: 'any',
  }) as Record<string, unknown> & { definitions?: Record<string, unknown> };
  const { $schema, definitions, ...root } = out;
  return {
    $schema,
    $ref: `#/definitions/${name}`,
    definitions: { ...definitions, [name]: root },
  };
}

/**
 * Returns JSON Schema for the agent artifact (`agent.json` / the
 * underlying shape behind `agent.pack`). The JSON Schema describes
 * the JSON shape; PACK consumers can use it to validate the result
 * of decoding a pack into typed records.
 */
export function agentJsonSchema(): unknown {
  return namedDraft7('AgentArtifact', AgentArtifactSchema);
}

/**
 * Returns JSON Schema for the human artifact (`human.json`). Useful
 * for downstream tools that consume the dashboard data shape (e.g.,
 * a CXO dashboard generator, a static site exporter).
 */
export function humanJsonSchema(): unknown {
  return namedDraft7('HumanArtifact', HumanArtifactSchema);
}

/** Convenience accessor by kind name — drives the MCP resource URI
 *  template `facts://schema/{kind}`. Returns `null` for unknown
 *  kinds so the caller can return a structured 404 instead of a
 *  thrown error. */
export function jsonSchemaByKind(kind: string): unknown | null {
  switch (kind) {
    case 'agent':
      return agentJsonSchema();
    case 'human':
      return humanJsonSchema();
    default:
      return null;
  }
}
