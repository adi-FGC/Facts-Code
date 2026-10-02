/**
 * modelSearch — the filtering behind the Overview's model combobox.
 *
 * Pure: the catalog in, the vendor groups that match a typed query out, in
 * catalog order (the order people learned the picker in). No ranking — a
 * list of ~25 rows is easier to scan when it never reshuffles under you.
 */
import type { CatalogModel } from './modelCatalog.ts';

export interface ModelGroup {
  vendor: string;
  models: CatalogModel[];
}

/** The input rate ($/1M tokens) to show for a model, or null for none. The
 *  default is the baked catalog rate; the token panel passes the rate in
 *  force, so a live price fetched with "?" shows here too. */
export type PriceOf = (m: CatalogModel) => number | null;

const bakedPrice: PriceOf = (m) => m.inputPerMTok;

/** "$4/M", or "no price" for a model that publishes no per-token rate. */
export function modelPriceText(m: CatalogModel, priceOf: PriceOf = bakedPrice): string {
  const p = priceOf(m);
  return typeof p === 'number' ? `$${p}/M` : 'no price';
}

/** What the closed combobox shows for a model: "Opus 5.5 — $4/M". */
export function modelDisplayText(m: CatalogModel, priceOf: PriceOf = bakedPrice): string {
  return `${m.label} — ${modelPriceText(m, priceOf)}`;
}

/**
 * The groups whose models match every whitespace-separated term of `query`,
 * case-insensitively, against the model's label, vendor, API id and the text
 * the closed box shows — so "gpt sol", "anthropic", "qwen3.8" and an edited
 * "Opus 5.5 — $4/" all find what they should. An empty query matches all.
 * `priceOf` is the same one the box shows prices with.
 */
export function searchModels(
  models: readonly CatalogModel[],
  query: string,
  priceOf: PriceOf = bakedPrice,
): ModelGroup[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const groups: ModelGroup[] = [];
  for (const m of models) {
    const hay = `${modelDisplayText(m, priceOf)} ${m.vendor} ${m.apiModelId}`.toLowerCase();
    if (!terms.every((t) => hay.includes(t))) continue;
    const g = groups.find((x) => x.vendor === m.vendor);
    if (g) g.models.push(m);
    else groups.push({ vendor: m.vendor, models: [m] });
  }
  return groups;
}

/** The matching models in the order they are shown — what the arrow keys walk. */
export function flatModels(groups: readonly ModelGroup[]): CatalogModel[] {
  return groups.flatMap((g) => g.models);
}

/**
 * The id `delta` steps from `fromId` in `ids`, wrapping at both ends. From
 * nothing (or an id that was filtered out), down lands on the first and up
 * on the last — the way a fresh list is entered from either side.
 */
export function stepId(
  ids: readonly string[],
  fromId: string | null,
  delta: 1 | -1,
): string | null {
  if (ids.length === 0) return null;
  const i = fromId === null ? -1 : ids.indexOf(fromId);
  if (i < 0) return delta > 0 ? ids[0]! : ids[ids.length - 1]!;
  return ids[(i + delta + ids.length) % ids.length]!;
}
