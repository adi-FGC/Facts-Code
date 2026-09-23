/**
 * @factstack/parsers — NOT YET IMPLEMENTED (F6 placeholder).
 *
 * This package is reserved for the F6 multi-language work: a `web-tree-sitter`
 * WASM grammar registry that would give non-JS/TS languages the same
 * AST-quality extraction the Babel path gives JS/TS. None of that exists yet.
 *
 * What ships today instead: hand-written line/regex extractors, which is why
 * Go and Python get imports (and Go gets top-level declarations) but no
 * symbol-level cross-file references —
 *   - packages/extractors/src/imports-go.ts
 *   - packages/extractors/src/imports-python.ts
 *
 * The package existed with a `main`/`types` pointing at this file while the
 * file itself was absent — a broken entry point that would fail the moment
 * anything imported it. This module makes the package resolvable and states
 * the gap plainly rather than letting an empty directory imply F6 progress.
 *
 * When F6 starts: replace this with the grammar registry and drop the notice.
 */

/** Marker that the tree-sitter grammar registry is not yet available. */
export const PARSERS_IMPLEMENTED = false as const;

/** Languages that would gain AST-quality extraction once F6 lands. */
export const PLANNED_GRAMMARS = ['go', 'python', 'rust', 'java', 'ruby'] as const;
export type PlannedGrammar = (typeof PLANNED_GRAMMARS)[number];
