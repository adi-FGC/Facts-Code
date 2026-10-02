/**
 * 1-indexed line lookup for many offsets into one text: the newline offsets
 * are collected once (O(n)) and each lookup is a binary search (O(log n)).
 * Replaces a per-call rescan from offset 0, which made the SQL and HCL
 * parsers quadratic (~13–18 s on a ~1 MB dump, 2026-09-24).
 *
 * Isomorphic (constraint C1): no node:* imports.
 */
export function lineIndex(text: string) {
  const newlines: number[] = [];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) newlines.push(i);
  return (offset: number): number => {
    // Count newlines strictly before `offset` (capped at the text's end).
    const cap = Math.min(offset, text.length);
    let lo = 0;
    let hi = newlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (newlines[mid]! < cap) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
}
