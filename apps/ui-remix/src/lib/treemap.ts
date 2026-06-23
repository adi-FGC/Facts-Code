/**
 * Treemap layout — pure, deterministic squarified treemap geometry.
 *
 * Given weighted leaf items, it fills a rectangle with smaller rectangles
 * whose AREA is proportional to each item's value, packed to keep aspect
 * ratios close to square (the Bruls/Huizing/van Wijk "squarified" algorithm).
 * That makes the rectangles readable and comparable by eye — the whole point
 * of a treemap: "where is the weight?" at a glance.
 *
 * No DOM, no clock, no randomness — same items in yield byte-identical rects
 * out, so it is trivially unit-testable and the map stays stable across
 * re-renders. The renderer (Treemap.tsx) only draws what this returns.
 */

export interface TreemapItem {
  id: string;
  label: string;
  value: number;
  /** Optional fill colour (a CSS colour or var()). */
  color?: string;
}

export interface TreemapOptions {
  width: number;
  height: number;
  /** Inset applied to every rect so tiles read as separate, px. Default 1. */
  padding?: number;
}

export interface TreemapRect {
  id: string;
  label: string;
  value: number;
  color?: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TreemapLayout {
  rects: TreemapRect[];
  width: number;
  height: number;
}

interface Scaled {
  item: TreemapItem;
  area: number;
}

/** Worst (largest) aspect ratio of a row laid across a strip of length `len`. */
function worstRatio(row: ReadonlyArray<Scaled>, len: number): number {
  if (row.length === 0) return Infinity;
  let sum = 0;
  let max = -Infinity;
  let min = Infinity;
  for (const r of row) {
    sum += r.area;
    if (r.area > max) max = r.area;
    if (r.area < min) min = r.area;
  }
  const len2 = len * len;
  const sum2 = sum * sum;
  // Guard against a zero-area row (len or sum 0) — treat as no constraint.
  if (sum2 === 0 || len2 === 0) return Infinity;
  return Math.max((len2 * max) / sum2, sum2 / (len2 * min));
}

export function computeTreemap(
  items: ReadonlyArray<TreemapItem>,
  options: TreemapOptions,
): TreemapLayout {
  const width = options.width;
  const height = options.height;
  const pad = options.padding ?? 1;

  // Drop zero/negative-weight items; sort by value desc, ties broken by id so
  // the layout is fully deterministic.
  const live = items
    .filter((i) => i.value > 0)
    .slice()
    .sort((a, b) => b.value - a.value || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  if (live.length === 0 || width <= 0 || height <= 0) {
    return { rects: [], width, height };
  }

  const total = live.reduce((s, i) => s + i.value, 0);
  const areaScale = (width * height) / total;
  const scaled: Scaled[] = live.map((item) => ({ item, area: item.value * areaScale }));

  const out: TreemapRect[] = [];
  // The remaining free rectangle, shrinking as rows are placed.
  let x = 0;
  let y = 0;
  let w = width;
  let h = height;

  let i = 0;
  while (i < scaled.length) {
    const short = Math.min(w, h);
    // Grow a row while adding the next tile improves (lowers) the worst ratio.
    const row: Scaled[] = [scaled[i]!];
    let j = i + 1;
    while (j < scaled.length && worstRatio([...row, scaled[j]!], short) <= worstRatio(row, short)) {
      row.push(scaled[j]!);
      j++;
    }
    i = j;

    const rowArea = row.reduce((s, r) => s + r.area, 0);
    if (w >= h) {
      // Shorter side is h → place a vertical strip on the left; tiles stack down.
      const stripW = rowArea / h;
      let yy = y;
      for (const r of row) {
        const rh = stripW > 0 ? r.area / stripW : 0;
        out.push(pack(r.item, x, yy, stripW, rh, pad));
        yy += rh;
      }
      x += stripW;
      w -= stripW;
    } else {
      // Shorter side is w → place a horizontal strip on top; tiles run across.
      const stripH = rowArea / w;
      let xx = x;
      for (const r of row) {
        const rw = stripH > 0 ? r.area / stripH : 0;
        out.push(pack(r.item, xx, y, rw, stripH, pad));
        xx += rw;
      }
      y += stripH;
      h -= stripH;
    }
  }

  return { rects: out, width, height };
}

/** Build a TreemapRect, applying the gap inset (never producing negatives). */
function pack(item: TreemapItem, x: number, y: number, w: number, h: number, pad: number): TreemapRect {
  const inset = Math.min(pad, w / 2, h / 2);
  return {
    id: item.id,
    label: item.label,
    value: item.value,
    ...(item.color !== undefined ? { color: item.color } : {}),
    x: x + inset,
    y: y + inset,
    w: Math.max(0, w - inset * 2),
    h: Math.max(0, h - inset * 2),
  };
}
