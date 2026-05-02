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
export { decode, PackDecodeError } from './decode.js';
export { escapeCell, unescapeCell, PackEscapeError } from './escape.js';
export {
  isInternedColumn,
  type DecodedPack,
  type DecodedTable,
  type EncodeOptions,
  type IncrementalEncodeOptions,
  type IncrementalTable,
  type PackColumn,
  type PackHeader,
  type PackRow,
  type PackTable,
} from './types.js';
