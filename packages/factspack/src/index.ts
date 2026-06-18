/**
 * @factstack/factspack — FactsPack (.pack) wire format encoder + decoder.
 *
 * Public API:
 *
 *   - `encode(opts)`           → baseline pack (only `-` rows)
 *   - `encodeIncremental(opts)` → patch pack (`+` and `x` rows)
 *   - `decode(text)`            → DecodedPack { header, tables }
 *
 * Plus the type contracts for callers (PackHeader, PackTable,
 * PackColumn, PackRow, IncrementalTable, etc.) and three tagged error
 * classes for `instanceof` discrimination at the call site:
 *
 *   - `PackEscapeError`  → unknown / unterminated escape inside a cell
 *   - `PackEncodeError`  → caller passed a malformed input shape
 *   - `PackDecodeError`  → wire-format violation while reading
 *
 * Spec: see `docs/FACTSPACK.md` at the repo root. The 8-line preamble
 * to paste into an LLM system prompt is in `docs/FACTSPACK_PROMPT.md`.
 */

export { encode, encodeIncremental, PackEncodeError } from './encode.js';
export { decode, decodeStrict, decodeLegacy, PackDecodeError } from './decode.js';
export { computeDiff, applyChain, type AppliedTable } from './chain.js';
export { escapeCell, unescapeCell, PackEscapeError } from './escape.js';
export { canonicalizePath, canonicalizeNumber } from './canonicalize.js';
// Pure isomorphic SHA-256 — reused as a collision-resistant content hash for
// the F8 extraction-cache key (a 32-bit djb2 key risked serving the wrong
// file's parse on a hash collision, violating INV2).
export { sha256hex } from './sha256.js';
export {
  isInternedColumn,
  STRICT_DEFAULT_LIMITS,
  type DecodedPack,
  type DecodedTable,
  type DecodeLimits,
  type DecodeMode,
  type DecodeOptions,
  type EncodeOptions,
  type IncrementalEncodeOptions,
  type IncrementalTable,
  type PackColumn,
  type PackHeader,
  type PackMeta,
  type PackRow,
  type PackTable,
} from './types.js';
