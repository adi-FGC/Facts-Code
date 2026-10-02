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
import { AgentArtifactSchema } from '../src/agent.js';
import { agentJsonSchema, humanJsonSchema, jsonSchemaByKind } from '../src/schema-export.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any>;

function jsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

/** Minimal draft-07 check of the contract under test: type + `required` keys,
 *  followed through $ref / properties / items / anyOf. Returns the failures. */
function check(s: J, defs: J, v: unknown, at = '$'): string[] {
  if (s.$ref) return check(defs[String(s.$ref).slice('#/definitions/'.length)], defs, v, at);
  const branches = s.anyOf ?? s.oneOf;
  if (branches) {
    const results = (branches as J[]).map((b) => check(b, defs, v, at));
    return results.some((r) => r.length === 0) ? [] : results[0]!;
  }
  if (s.type) {
    const types = ([] as string[]).concat(s.type);
    const t = jsonType(v);
    if (!types.includes(t) && !(t === 'integer' && types.includes('number'))) {
      return [`${at}: expected ${types.join('|')}, got ${t}`];
    }
  }
  const out: string[] = [];
  if (jsonType(v) === 'object') {
    const o = v as J;
    for (const k of (s.required as string[] | undefined) ?? []) {
      if (!(k in o)) out.push(`${at}: missing required ${k}`);
    }
    for (const [k, sub] of Object.entries((s.properties as J | undefined) ?? {})) {
      if (k in o) out.push(...check(sub, defs, o[k], `${at}.${k}`));
    }
  }
  if (Array.isArray(v) && s.items && !Array.isArray(s.items)) {
    v.forEach((item, i) => out.push(...check(s.items, defs, item, `${at}[${i}]`)));
  }
  return out;
}

/** An agent.json from before the additive fields: no $schema / factsVersion /
 *  dependencyManifests / vulnerabilities / docs / rationale, no edge
 *  `confidence`, no import `isTypeOnly`, no export `isDefault`. */
const preAdditiveArtifact = {
  generatedAt: '2026-01-01T00:00:00.000Z',
  project: { name: 'p', root: '.', languages: [], frameworks: [], entryPoints: [], monorepo: null },
  files: [
    {
      path: 'a.ts',
      language: 'typescript',
      loc: 1,
      bytes: 10,
      bundleSize: null,
      tokenCost: 3,
      imports: [{ source: './b', resolved: 'b.ts', specifiers: ['x'] }],
      exports: [{ name: 'y', kind: 'constant' }],
      declarations: [],
      todos: [],
      complexity: { cyclomatic: 1, cognitive: 0 },
      status: 'ok',
      lastModifiedMs: null,
      churnScore: null,
    },
  ],
  graph: { nodes: [], edges: [{ from: 'a.ts', to: 'b.ts', kind: 'import' }], cycles: [] },
  routes: [],
  scripts: {},
  capabilities: [],
  risks: [],
  stats: { loc: 1, fileCount: 1, packageCount: 0, totalTokenCost: 3 },
};

describe('agentJsonSchema accepts what AgentArtifactSchema accepts (INV4)', () => {
  const schema = agentJsonSchema() as J;
  const validate = (v: unknown) => check(schema, schema.definitions as J, v);

  it('accepts an artifact written before the additive defaulted fields', () => {
    expect(AgentArtifactSchema.safeParse(preAdditiveArtifact).success).toBe(true);
    expect(validate(preAdditiveArtifact)).toEqual([]);
  });

  it('keeps .default() fields out of every `required` list', () => {
    const root = schema.definitions.AgentArtifact as J;
    for (const k of ['$schema', 'factsVersion', 'dependencyManifests', 'vulnerabilities', 'docs']) {
      expect(root.required).not.toContain(k);
    }
    expect(root.required).not.toContain('rationale');
    expect(root.required).toEqual(expect.arrayContaining(['generatedAt', 'files', 'graph']));
  });

  it('still rejects a missing genuinely-required key (the check is not vacuous)', () => {
    const noStamp: Record<string, unknown> = { ...preAdditiveArtifact };
    delete noStamp.generatedAt;
    expect(AgentArtifactSchema.safeParse(noStamp).success).toBe(false);
    expect(validate(noStamp)).toContain('$: missing required generatedAt');
    const badEdge = {
      ...preAdditiveArtifact,
      graph: { ...preAdditiveArtifact.graph, edges: [{ from: 'a.ts', kind: 'import' }] },
    };
    expect(AgentArtifactSchema.safeParse(badEdge).success).toBe(false);
    expect(validate(badEdge)).toContain('$.graph.edges[0]: missing required to');
  });
});

describe('agentJsonSchema', () => {
  it('returns an object with properties (or definitions/$ref)', () => {
    const schema = agentJsonSchema() as Record<string, unknown>;
    expect(typeof schema).toBe('object');
    // The named-root shape: `definitions` holds the root, `$ref` points at it.
    const hasProps = 'properties' in schema;
    const hasDefs = 'definitions' in schema;
    expect(hasProps || hasDefs).toBe(true);
  });

  it('keeps the shape the MCP resource has always served: draft-07, named root', () => {
    const schema = agentJsonSchema() as {
      $schema: string;
      $ref: string;
      definitions: Record<string, { properties?: Record<string, unknown> }>;
    };
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema.$ref).toBe('#/definitions/AgentArtifact');
    expect(Object.keys(schema.definitions.AgentArtifact!.properties!)).toEqual(
      expect.arrayContaining(['files', 'graph', 'routes']),
    );
  });

  it('resolves every $ref inside the document (recursive shapes included)', () => {
    for (const schema of [agentJsonSchema(), humanJsonSchema()] as Array<{
      definitions: Record<string, unknown>;
    }>) {
      const refs = JSON.stringify(schema).match(/"\$ref":"#\/definitions\/[^"]+"/g) ?? [];
      for (const r of refs) {
        const name = r.slice('"$ref":"#/definitions/'.length, -1);
        expect(schema.definitions, name).toHaveProperty([name]);
      }
    }
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
