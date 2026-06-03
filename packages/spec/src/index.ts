/**
 * @factstack/spec — canonical types + schemas for every FACTS surface.
 *
 * This package has no dependencies outside zod. Every other package and
 * app depends on it, directly or transitively. Schema changes within a
 * major version must be additive only.
 */

export * from './agent.js';
export * from './human.js';
export * from './fs.js';
export * from './file-writer.js';
export * from './mcp.js';
export * from './diff.js';
export * from './review.js';
export * from './docs.js';
export * from './styles.js';
export {
  agentJsonSchema,
  humanJsonSchema,
  jsonSchemaByKind,
} from './schema-export.js';
