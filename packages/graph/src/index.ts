/**
 * @factstack/graph — dependency + outline graph builders.
 *
 * v0.1 ships the dependency graph (file-level import edges). Outline graph
 * (project → package → file → symbol) arrives with the v0.2 symbol extractor.
 */

export * from './resolver.js';
export * from './dependency.js';
export { buildCallerIndex, type CallerIndex } from './callers.js';
export { buildSymbolGraph, type SymbolGraph } from './symbol-resolver.js';
