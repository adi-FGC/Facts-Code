/**
 * savingsLadder — pure layout for the cross-model savings chart.
 *
 * THE CLAIM THE CHART MAKES
 * On a log10 dollar axis a constant token-reduction ratio becomes a constant
 * LEFTWARD TRANSLATION. Every model's pair of marks is therefore separated by
 * the same distance, and that distance IS the artifact's effect — visible
 * without reading a single number. The absolute dollars stay honest and
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
  /** Exact whole-codebase tokens. */
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
  /** Space reserved at the right for the cost readout. */
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
  savedCost: number;
  /** Label text for the right-hand readout. */
  valueText: string;
  /** True when the price is not from a primary vendor source. */
  flagged: boolean;
  /** True when cost was clamped to the axis floor (a free model). */
  clampedLow: boolean;
}

export interface LadderAxisTick {
  x: number;
  /** Dollar label for one whole-codebase send. */
  label: string;
}

export interface SavingsLadderLayout {
  width: number;
  height: number;
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
  rows: LadderRow[];
  axisTicks: LadderAxisTick[];
  /** Dashed rule at the dearest artifact cost, with its computed finding. */
  crossover: { x: number; caption: string } | null;
  /** Models with no published per-token price — listed, never dropped. */
  unpriced: Array<{ id: string; label: string; vendor: string }>;
  /** Constant multiple every model's cost falls by. 0 when undefined. */
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
  crossover: null,
  unpriced: [],
  ratio: 0,
  ariaSummary: 'No priced models to chart.',
};

/** USD for one run that sends `tokens` input tokens at `perMTok`. */
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
  const valueWidth = options.valueWidth ?? 86;

  const unpriced = models
    .filter((m) => typeof m.inputPerMTok !== 'number')
    .map((m) => ({ id: m.id, label: m.label, vendor: m.vendor }));

  const priced = models.filter(
    (m): m is LadderModel & { inputPerMTok: number } => typeof m.inputPerMTok === 'number',
  );
  if (priced.length === 0) return { ...EMPTY, width, unpriced };

  /* Cost each model twice: the naive whole-repo send, and the artifact. */
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

  const plotTop = stacked ? 8 : 14;
  const rows: LadderRow[] = costed.map((c, i) => {
    const y = plotTop + i * rowHeight + rowHeight / 2;
    const f = xOf(c.fullCost);
    const a = xOf(c.artifactCost);
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
      valueText: fmtLadderUsd(c.artifactCost),
      flagged: (c.model.confidence ?? 'primary') !== 'primary',
      clampedLow: a.clamped || f.clamped,
    };
  });

  const plotBottom = plotTop + costed.length * rowHeight;
  const axisH = 26;
  const height = plotBottom + axisH;

  /* One tick per decade inside the domain. */
  const axisTicks: LadderAxisTick[] = [];
  for (let e = Math.ceil(loL); e <= Math.floor(hiL); e += 1) {
    const v = Math.pow(10, e);
    axisTicks.push({ x: xOf(v).x, label: decadeLabel(v) });
  }

  /* The finding, computed rather than asserted: how many models were dearer
     on the whole codebase than the DEAREST model now is on the artifact. */
  const dearestArtifact = Math.max(...costed.map((c) => c.artifactCost));
  const beaten = costed.filter((c) => c.fullCost > dearestArtifact).length;
  const crossover =
    beaten > 0
      ? {
          x: xOf(dearestArtifact).x,
          caption: `Every model on the FACTS artifact costs less than ${beaten} of ${costed.length} models did on the whole codebase.`,
        }
      : null;

  /* The translation is constant by construction, so one ratio describes all. */
  const ratio = project.artifactTokens > 0 ? project.fullTokens / project.artifactTokens : 0;

  const cheapest = costed[0]!;
  const dearest = costed[costed.length - 1]!;
  const vendorCount = new Set(costed.map((c) => c.model.vendor)).size;
  const ariaSummary =
    `${costed.length} priced model${costed.length === 1 ? '' : 's'} across ` +
    `${vendorCount} vendor${vendorCount === 1 ? '' : 's'}. ` +
    `Sending the whole codebase costs ${fmtLadderUsd(Math.min(...costed.map((c) => c.fullCost)))} to ` +
    `${fmtLadderUsd(Math.max(...costed.map((c) => c.fullCost)))} per run; the FACTS artifact costs ` +
    `${fmtLadderUsd(cheapest.artifactCost)} to ${fmtLadderUsd(dearest.artifactCost)} — ` +
    `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)} times less for every model. ` +
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
    crossover,
    unpriced,
    ratio,
    ariaSummary,
  };
}
