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
 * We use `zod-to-json-schema` for the conversion. The output is JSON
 * Schema draft-07 by default — wide consumer support.
 *
 * Pure / no Node imports — usable in any environment that already
 * has the spec package.
 */

import { zodToJsonSchema } from 'zod-to-json-schema';
import { AgentArtifactSchema } from './agent.js';
import { HumanArtifactSchema } from './human.js';

/**
 * Returns JSON Schema for the agent artifact (`agent.json` / the
 * underlying shape behind `agent.pack`). The JSON Schema describes
 * the JSON shape; PACK consumers can use it to validate the result
 * of decoding a pack into typed records.
 */
export function agentJsonSchema(): unknown {
  return zodToJsonSchema(AgentArtifactSchema, {
    name: 'AgentArtifact',
    $refStrategy: 'none', // inline everything for downstream simplicity
  });
}

/**
 * Returns JSON Schema for the human artifact (`human.json`). Useful
 * for downstream tools that consume the dashboard data shape (e.g.,
 * a CXO dashboard generator, a static site exporter).
 */
export function humanJsonSchema(): unknown {
  return zodToJsonSchema(HumanArtifactSchema, {
    name: 'HumanArtifact',
    $refStrategy: 'none',
  });
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
