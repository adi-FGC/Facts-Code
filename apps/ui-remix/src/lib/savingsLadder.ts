/**
 * savingsLadder — pure layout for the cross-model savings chart.
 *
 * WHAT A DOLLAR FIGURE MEANS
 * The MINIMUM an agent pays to read this project before it attempts a change
 * request: one read, input tokens at list price. Not the cost of the change.
 *   - Whole codebase: every source file, once. That already includes the
 *     files the change will touch.
 *   - FACTS artifact: the map alone. The agent then opens the files the change
 *     touches on top of it, which no one can size before the change is known,
 *     so part of the gap between the two marks is spent later. (The measured
 *     block is also a superset of the lean agent.json, which pulls the other
 *     way; the panel caption states both.)
 * Anything that re-reads (an agent re-sending context each turn) pays more;
 * that is why these are minimums. The panel caption says all of this in plain
 * words; keep the two in step.
 *
 * THE CLAIM THE CHART MAKES
 * On a log10 dollar axis a constant token-reduction ratio becomes a constant
 * LEFTWARD TRANSLATION. Every model's pair of marks is therefore separated by
 * the same distance: the gap between the two reads, before the files the
 * change touches — visible without reading a single number. The absolute dollars stay honest and
 * comparable across a ~100x price spread, which a linear axis could not show
 * (GLM-5.3 Flash would be a 1px smear next to GPT-6 Astra).
 *
 * WHY A ROW PER MODEL
 * An earlier design grouped models into vendor rows because the catalog was
 * ~150 long and a row each would be a 1700px barcode. The shipped catalog is
 * ~24 (roughly the top two per vendor), so a row each fits in one screen AND
 * lets every model carry its own label and price — strictly better at this
 * cardinality. If the catalog ever grows past ~40, revisit: group by vendor
 * and drop the per-row labels rather than letting this scroll.
 *
 * Pure: no DOM, no clock, no randomness. Same input, byte-identical geometry.
 * Rendering lives in ui/SavingsLadder.tsx, mirroring the established
 * computeSankey / SankeyDiagram split.
 */

export interface LadderModel {
  id: string;
  label: string;
  vendor: string;
  /** USD per 1M input tokens. null = no published per-token price. */
  inputPerMTok: number | null;
  /** Drives the "unverified" dagger on the label. */
  confidence?: 'primary' | 'aggregator' | 'unverified';
}

export interface LadderProject {
  /** Whole-codebase tokens (the analyzer's characters ÷ 3.5 estimate). */
  fullTokens: number;
  /** Estimated FACTS artifact tokens. */
  artifactTokens: number;
}

export interface LadderOptions {
  width: number;
  /** Vertical pitch per model row. */
  rowHeight?: number;
  /** Space reserved at the left for model labels. */
  labelWidth?: number;
  /** Space reserved at the right for the cost readout (0 when stacked: the
   *  readout then shares the label line above each row). */
  valueWidth?: number;
  /** Compact mode: labels above rows instead of beside them (narrow screens). */
  stacked?: boolean;
}

export interface LadderRow {
  id: string;
  label: string;
  vendor: string;
  y: number;
  /** x of the whole-codebase cost mark. */
  fullX: number;
  /** x of the artifact cost mark. */
  artifactX: number;
  fullCost: number;
  artifactCost: number;
  /** fullCost − artifactCost: the difference on this read, not the saving on
   *  the change (the agent later opens the files the change touches). */
  savedCost: number;
  /** Whole-codebase cost, formatted. */
  fullText: string;
  /** FACTS-map cost, formatted. */
  artifactText: string;
  /** Both, in legend order: "$1.84 vs $0.05" (the renderer styles the parts). */
  valueText: string;
  /** True when the price is not from a primary vendor source. */
  flagged: boolean;
  /** True when cost was clamped to the axis floor (a free model). */
  clampedLow: boolean;
}

export interface LadderAxisTick {
  x: number;
  /** Dollar label at that gridline. */
  label: string;
}

/** Names the axis, so its unit and its log scale are read, not guessed. Two
 *  parts, so a phone-width chart stacks them instead of clipping the line. */
export const LADDER_AXIS_TITLE = [
  'Minimum cost to read the project once',
  'log scale, each gridline 10×',
] as const;

export interface SavingsLadderLayout {
  width: number;
  height: number;
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
  rows: LadderRow[];
  axisTicks: LadderAxisTick[];
  /** Baseline of the tick labels. */
  tickY: number;
  /** The axis title under them: one line, or two when stacked. */
  axisTitle: Array<{ y: number; text: string }>;
  /** Models with no published per-token price — listed, never dropped. */
  unpriced: Array<{ id: string; label: string; vendor: string }>;
  /** fullTokens / artifactTokens: the same on every row. 0 when undefined. */
  ratio: number;
  ariaSummary: string;
}

const EMPTY: SavingsLadderLayout = {
  width: 0,
  height: 0,
  plotLeft: 0,
  plotRight: 0,
  plotTop: 0,
  plotBottom: 0,
  rows: [],
  axisTicks: [],
  tickY: 0,
  axisTitle: [],
  unpriced: [],
  ratio: 0,
  ariaSummary: 'No priced models to chart.',
};

/** USD for one read of `tokens` input tokens at `perMTok`. */
function costOf(tokens: number, perMTok: number): number {
  return (Math.max(0, tokens) / 1_000_000) * Math.max(0, perMTok);
}

/**
 * Compact USD, tuned for the $0.001-$50 band these costs live in.
 *
 * "$0" is reserved for a genuinely free model. A tiny positive cost must never
 * render as "$0": toFixed(4) on 0.00004 gives "0.0000", which the trailing-zero
 * strip collapses to "0", making a paid model indistinguishable from a free one
 * on a panel whose whole subject is cost. Below the 4-decimal floor, switch to
 * significant figures rather than truncating to nothing.
 */
export function fmtLadderUsd(n: number): string {
  if (n <= 0) return '$0';
  if (n < 0.0001) {
    const sig = Number(n.toPrecision(2));
    const decimals = Math.min(20, Math.max(0, -Math.floor(Math.log10(sig)) + 1));
    return '$' + sig.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '');
  }
  if (n < 0.01) return '$' + n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  if (n < 1) return '$' + n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  if (n < 100) return '$' + n.toFixed(2);
  return '$' + Math.round(n).toLocaleString('en-US');
}

/** Decade label for the axis: $0.001, $0.01, $1, $100 … */
function decadeLabel(value: number): string {
  if (value >= 1) return '$' + Math.round(value).toLocaleString('en-US');
  return '$' + value.toFixed(value < 0.01 ? 3 : 2);
}

export function computeSavingsLadder(
  models: readonly LadderModel[],
  project: LadderProject,
  options: LadderOptions,
): SavingsLadderLayout {
  const width = Math.max(0, options.width);
  if (width <= 0) return EMPTY;

  const stacked = options.stacked ?? false;
  const rowHeight = options.rowHeight ?? (stacked ? 34 : 24);
  const labelWidth = stacked ? 0 : (options.labelWidth ?? 168);
  /* Stacked rows print their readout on the label line above the row, so the
     plot keeps the full width. */
  const valueWidth = stacked ? 0 : (options.valueWidth ?? 120);

  const unpriced = models
    .filter((m) => typeof m.inputPerMTok !== 'number')
    .map((m) => ({ id: m.id, label: m.label, vendor: m.vendor }));

  const priced = models.filter(
    (m): m is LadderModel & { inputPerMTok: number } => typeof m.inputPerMTok === 'number',
  );
  if (priced.length === 0) return { ...EMPTY, width, unpriced };

  /* Cost each model twice: one read of the whole codebase, one of the artifact. */
  const costed = priced.map((m) => ({
    model: m,
    fullCost: costOf(project.fullTokens, m.inputPerMTok),
    artifactCost: costOf(project.artifactTokens, m.inputPerMTok),
  }));

  /* Log domain over every positive value. Zeros (genuinely free models) can
     have no log position, so they clamp to the floor and are flagged rather
     than silently plotted somewhere arbitrary. */
  const positives = costed.flatMap((c) => [c.fullCost, c.artifactCost]).filter((v) => v > 0);
  if (positives.length === 0) return { ...EMPTY, width, unpriced };

  let lo = Math.min(...positives);
  let hi = Math.max(...positives);
  /* A single model, or every model priced identically, would make hi === lo
     and every x NaN. Open the domain a decade either side instead. */
  if (hi <= lo) {
    lo = lo / 10;
    hi = hi * 10;
  }
  const loL = Math.log10(lo);
  const hiL = Math.log10(hi);

  const plotLeft = labelWidth;
  const plotRight = Math.max(plotLeft + 1, width - valueWidth);
  const span = plotRight - plotLeft;
  const xOf = (v: number): { x: number; clamped: boolean } => {
    if (!(v > 0)) return { x: plotLeft, clamped: true };
    const t = (Math.log10(v) - loL) / (hiL - loL);
    return { x: plotLeft + Math.min(1, Math.max(0, t)) * span, clamped: false };
  };

  /* Cheapest artifact cost first: the row order answers "what is my cheapest
     credible option" without the reader being told the sort rule. */
  costed.sort(
    (a, b) => a.artifactCost - b.artifactCost || a.model.label.localeCompare(b.model.label),
  );

  /* Room above the first row for the readout's column header (side layout)
     or the first row's label line (stacked). */
  const plotTop = stacked ? 8 : 22;
  const rows: LadderRow[] = costed.map((c, i) => {
    const y = plotTop + i * rowHeight + rowHeight / 2;
    const f = xOf(c.fullCost);
    const a = xOf(c.artifactCost);
    const fullText = fmtLadderUsd(c.fullCost);
    const artifactText = fmtLadderUsd(c.artifactCost);
    return {
      id: c.model.id,
      label: c.model.label,
      vendor: c.model.vendor,
      y,
      fullX: f.x,
      artifactX: a.x,
      fullCost: c.fullCost,
      artifactCost: c.artifactCost,
      savedCost: Math.max(0, c.fullCost - c.artifactCost),
      fullText,
      artifactText,
      valueText: `${fullText} vs ${artifactText}`,
      flagged: (c.model.confidence ?? 'primary') !== 'primary',
      clampedLow: a.clamped || f.clamped,
    };
  });

  const plotBottom = plotTop + costed.length * rowHeight;
  const tickY = plotBottom + 18;
  const axisTitle = stacked
    ? LADDER_AXIS_TITLE.map((text, i) => ({ y: tickY + 18 + i * 14, text }))
    : [{ y: tickY + 18, text: LADDER_AXIS_TITLE.join(' · ') }];
  const height = axisTitle[axisTitle.length - 1]!.y + 8;

  /* One tick per decade inside the domain. */
  const axisTicks: LadderAxisTick[] = [];
  for (let e = Math.ceil(loL); e <= Math.floor(hiL); e += 1) {
    const v = Math.pow(10, e);
    axisTicks.push({ x: xOf(v).x, label: decadeLabel(v) });
  }

  /* The translation is constant by construction, so one ratio describes all. */
  const ratio = project.artifactTokens > 0 ? project.fullTokens / project.artifactTokens : 0;

  /* No "the artifact beats N models" finding: the artifact side excludes the
     files the change touches, so any comparison against it overstates the
     saving by an unknown amount. The chart states the two floors and stops. */
  const cheapest = costed[0]!;
  const dearest = costed[costed.length - 1]!;
  const vendorCount = new Set(costed.map((c) => c.model.vendor)).size;
  const ariaSummary =
    `${costed.length} priced model${costed.length === 1 ? '' : 's'} across ` +
    `${vendorCount} vendor${vendorCount === 1 ? '' : 's'}. ` +
    `Minimum cost to read this project once before a change request: the whole codebase costs ` +
    `${fmtLadderUsd(Math.min(...costed.map((c) => c.fullCost)))} to ` +
    `${fmtLadderUsd(Math.max(...costed.map((c) => c.fullCost)))}; the FACTS artifact costs ` +
    `${fmtLadderUsd(cheapest.artifactCost)} to ${fmtLadderUsd(dearest.artifactCost)}, ` +
    `plus the files the change touches. ` +
    (unpriced.length
      ? unpriced.length === 1
        ? '1 model publishes no per-token price and is listed separately.'
        : `${unpriced.length} models publish no per-token price and are listed separately.`
      : '');

  return {
    width,
    height,
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    rows,
    axisTicks,
    tickY,
    axisTitle,
    unpriced,
    ratio,
    ariaSummary,
  };
}
