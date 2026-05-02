/**
 * JSON Schema export tests — agent + human shapes resolve to valid
 * JSON Schemas, jsonSchemaByKind dispatches correctly, unknown kinds
 * return null instead of throwing.
 *
 * We don't run a JSON Schema validator here (that would pull in
 * ajv); we just check the shape of the output is recognizable as a
 * Schema object — `$ref` or `properties` at the top level, depending
 * on conversion strategy.
 */

import { describe, expect, it } from 'vitest';
import {
  agentJsonSchema,
  humanJsonSchema,
  jsonSchemaByKind,
} from '../src/schema-export.js';

describe('agentJsonSchema', () => {
  it('returns an object with properties (or definitions/$ref)', () => {
    const schema = agentJsonSchema() as Record<string, unknown>;
    expect(typeof schema).toBe('object');
    // zod-to-json-schema with $refStrategy:none + name option produces
    // a schema with `definitions` containing the named root.
    const hasProps = 'properties' in schema;
    const hasDefs = 'definitions' in schema;
    expect(hasProps || hasDefs).toBe(true);
  });

  it('describes the AgentArtifact root by name', () => {
    const schema = agentJsonSchema() as Record<string, unknown>;
    const text = JSON.stringify(schema);
    expect(text).toContain('AgentArtifact');
    // Spot-check that core fields make it into the schema.
    expect(text).toContain('files');
    expect(text).toContain('graph');
    expect(text).toContain('routes');
  });
});

describe('humanJsonSchema', () => {
  it('returns a recognizable JSON Schema object', () => {
    const schema = humanJsonSchema() as Record<string, unknown>;
    expect(typeof schema).toBe('object');
    const text = JSON.stringify(schema);
    expect(text).toContain('HumanArtifact');
  });
});

describe('jsonSchemaByKind', () => {
  it('returns the agent schema when kind is "agent"', () => {
    expect(jsonSchemaByKind('agent')).toBeTruthy();
  });

  it('returns the human schema when kind is "human"', () => {
    expect(jsonSchemaByKind('human')).toBeTruthy();
  });

  it('returns null for unknown kinds', () => {
    expect(jsonSchemaByKind('unknown')).toBeNull();
    expect(jsonSchemaByKind('')).toBeNull();
    expect(jsonSchemaByKind('AGENT')).toBeNull(); // case-sensitive on purpose
  });

  it('produces deterministic output (same input → same JSON string)', () => {
    const a = JSON.stringify(jsonSchemaByKind('agent'));
    const b = JSON.stringify(jsonSchemaByKind('agent'));
    expect(a).toBe(b);
  });
});
