/**
 * @factstack/extractors — AST-based symbol / import / route extractors.
 *
 * v0.1 ships the import extractor for JS/TS (pure-JS via @babel/parser).
 * Symbol + route + component extractors arrive in v0.2 alongside the
 * tree-sitter WASM grammar registry — at which point this package
 * re-exports both backends from a single entry.
 */

export * from './imports.js';
export { extractPythonImports, isPython } from './imports-python.js';
export { detectFileBasedRoutes, detectSourceRoutes, type DetectedRoute } from './routes.js';
export { parseJS, isParseable, walkAst, type ParsedFile } from './parse.js';
export { extractSymbols, type ExtractedSymbol, type SymbolKind } from './symbols.js';
export { extractOutline, type OutlineNode, type OutlineKind } from './outline.js';
