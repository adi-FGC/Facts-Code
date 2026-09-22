/**
 * modelCatalog — the baked model price list behind the savings analyzer.
 *
 * WHY THIS FILE EXISTS AS DATA, NOT AS A FETCH
 * The panel must render correct, fully-labelled prices with zero network.
 * A visitor on a plane, behind a corporate proxy, or with the tab opened
 * from cache still sees real numbers. The live refresh (lib/livePrices.ts,
 * behind the "?" button) is strictly additive — it can only ever replace
 * these numbers with fresher ones, never be required to show any.
 *
 * HOW THESE NUMBERS WERE OBTAINED (2026-09-23)
 * Each row was researched against the vendor's own pricing page, then
 * INDEPENDENTLY re-checked by a second pass whose instructions were to
 * refute it — open the primary page again and compare both rates. 160 of
 * 167 researched rates confirmed; the corrections that survived are noted
 * per row below. Where a vendor's page and multiple hosted providers
 * disagreed, the disagreement is recorded in `notes` rather than resolved
 * silently in the product's favour.
 *
 * `verifiedOn` IS PER MODEL, DELIBERATELY
 * Not one global "last updated" stamp. Prices move independently — Sonnet 5
 * held introductory pricing past its announced end date; Inkling is on a
 * limited-time discount; Qwen re-tiers by region. A single banner date would
 * claim freshness for rows nobody re-checked. Re-verify one row, bump one
 * date. The UI surfaces the OLDEST date in the visible set, so the panel can
 * never look fresher than its stalest row.
 *
 * RULES FOR EDITING
 *   - Never adjust a price without opening `sourceUrl` and bumping
 *     `verifiedOn` in the same edit. A price without a re-read is a guess.
 *   - `inputPerMTok: null` means "no published per-token price", NOT free and
 *     NOT zero. Free models are 0. The two render differently on purpose.
 *   - `litellmKey` must be an EXACT key from the live price file, verified by
 *     lookup — never guessed from the label, never fuzzy-matched at runtime.
 *     A wrong key silently shows another model's price. '' = deliberately
 *     absent from the live source.
 *   - All rates are USD per 1,000,000 tokens, standard (non-batch,
 *     non-cached) rates, normalised from whatever unit the vendor quotes.
 */

export type PriceConfidence = 'primary' | 'aggregator' | 'unverified';

export interface CatalogModel {
  /** Stable slug. Used in URLs/state — do not rename casually. */
  id: string;
  label: string;
  vendor: string;
  /** Exact API model string, as the vendor spells it (dots included). */
  apiModelId: string;
  /** USD per 1M input tokens. null = vendor publishes no per-token price. */
  inputPerMTok: number | null;
  /** USD per 1M output tokens. null = no published per-token price. */
  outputPerMTok: number | null;
  /** USD per 1M cached/context-hit input tokens. null = none published. */
  cachedInputPerMTok: number | null;
  /** Max input tokens; 0 when the vendor does not state one. */
  contextWindow: number;
  /** Is this a model people actually reach for to write code? */
  codingNotable: boolean;
  /** YYYY-MM-DD this row was last checked against `sourceUrl`. */
  verifiedOn: string;
  sourceUrl: string;
  confidence: PriceConfidence;
  /** Exact key in the live price file; '' when the model is absent there. */
  litellmKey: string;
  notes: string;
}

const V = '2026-09-23';

/**
 * Roughly the top two models per vendor, biased to what people actually code
 * with rather than to the cheapest or the newest. Kept deliberately short:
 * the panel is a cost calculator, not a model directory, and a 150-row list
 * makes "find yourself" harder, not easier.
 */
export const MODEL_CATALOG: readonly CatalogModel[] = [
  /* ── Anthropic ─────────────────────────────────────────────────────── */
  {
    id: 'claude-opus-5-5',
    label: 'Opus 5.5',
    vendor: 'Anthropic',
    apiModelId: 'claude-opus-5-5',
    inputPerMTok: 4,
    outputPerMTok: 20,
    cachedInputPerMTok: 0.2,
    contextWindow: 1_000_000,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://platform.claude.com/docs/en/models/opus-5-5/overview',
    confidence: 'primary',
    litellmKey: 'claude-opus-5-5',
    notes:
      'Released 2026-09-22. Cheaper than the Opus 5 it replaces ($5/$25) with a 2.5x better cache-read rate. Cache read is 0.05x base input, not the usual 0.1x. Fast mode (research preview) reprices to $8/$40.',
  },
  {
    id: 'claude-fable-5-1',
    label: 'Fable 5.1',
    vendor: 'Anthropic',
    apiModelId: 'claude-fable-5-1',
    inputPerMTok: 10,
    outputPerMTok: 50,
    cachedInputPerMTok: 0.25,
    contextWindow: 1_000_000,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://platform.claude.com/docs/en/models/fable-5-1/overview',
    confidence: 'primary',
    litellmKey: 'claude-fable-5-1',
    notes:
      'Top-end model for long-horizon agentic work. Cache read is 0.025x base input. Strictly cheaper to cache than Fable 5 ($0.25 vs $1.00) at the same base rate.',
  },

  /* ── OpenAI ────────────────────────────────────────────────────────── */
  {
    id: 'gpt-6-astra',
    label: 'GPT-6 Astra',
    vendor: 'OpenAI',
    apiModelId: 'gpt-6-astra',
    inputPerMTok: 10,
    outputPerMTok: 50,
    cachedInputPerMTok: 1,
    contextWindow: 1_050_000,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-6-astra',
    confidence: 'primary',
    litellmKey: 'gpt-6-astra',
    notes: 'Released 2026-09-03. Cached input is 0.1x base.',
  },
  {
    id: 'gpt-6-sol',
    label: 'GPT-6 Sol',
    vendor: 'OpenAI',
    apiModelId: 'gpt-6-sol',
    inputPerMTok: 2,
    outputPerMTok: 10,
    cachedInputPerMTok: 0.2,
    contextWindow: 1_050_000,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-6-sol',
    confidence: 'primary',
    litellmKey: 'gpt-6-sol',
    notes: 'Released 2026-09-22 — one day before this snapshot. Same rate as its 5.6 predecessor.',
  },
  {
    id: 'gpt-5-6-terra',
    label: 'GPT-5.6 Terra',
    vendor: 'OpenAI',
    apiModelId: 'gpt-5.6-terra',
    inputPerMTok: 2,
    outputPerMTok: 12,
    cachedInputPerMTok: 0.2,
    contextWindow: 1_050_000,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-5.6-terra',
    confidence: 'primary',
    litellmKey: 'gpt-5.6-terra',
    notes:
      'Note the API id uses a DOT (gpt-5.6-terra); the hyphenated spelling is not a valid model id.',
  },

  /* ── Google ────────────────────────────────────────────────────────── */
  {
    id: 'gemini-3-8-flash',
    label: 'Gemini 3.8 Flash',
    vendor: 'Google',
    apiModelId: 'gemini-3.8-flash',
    inputPerMTok: 0.75,
    outputPerMTok: 3.75,
    cachedInputPerMTok: 0.075,
    contextWindow: 1_048_576,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
    confidence: 'primary',
    litellmKey: 'gemini-3.8-flash',
    notes: 'Paid-tier rate. Half the price of the 3.5 Flash generation at the same context window.',
  },
  {
    id: 'gemini-3-1-pro',
    label: 'Gemini 3.1 Pro',
    vendor: 'Google',
    apiModelId: 'gemini-3.1-pro-preview',
    inputPerMTok: 2,
    outputPerMTok: 12,
    cachedInputPerMTok: 0.2,
    contextWindow: 1_048_576,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
    confidence: 'primary',
    litellmKey: 'gemini-3.1-pro-preview',
    notes:
      'Preview channel. The strongest non-Anthropic coding model on SWE-bench Verified (0.806) at this snapshot.',
  },
  {
    id: 'gemini-antigravity',
    label: 'Antigravity',
    vendor: 'Google',
    apiModelId: 'antigravity-preview-05-2026',
    inputPerMTok: null,
    outputPerMTok: null,
    cachedInputPerMTok: null,
    contextWindow: 0,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
    confidence: 'primary',
    litellmKey: '',
    notes:
      'Listed in the Gemini model catalog as a managed coding agent, but it has NO row on the pricing page and no entry in any live price source — so it has no per-token cost to show. Present here precisely so its absence is visible rather than silently omitted. If Google publishes a rate, fill it in and bump verifiedOn.',
  },

  /* ── Moonshot AI ───────────────────────────────────────────────────── */
  {
    id: 'kimi-k3',
    label: 'Kimi K3',
    vendor: 'Moonshot AI',
    apiModelId: 'kimi-k3',
    inputPerMTok: 3,
    outputPerMTok: 15,
    cachedInputPerMTok: 0.3,
    contextWindow: 1_048_576,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://platform.kimi.ai/docs/pricing/chat',
    confidence: 'primary',
    litellmKey: 'moonshot/kimi-k3',
    notes: 'Cache-hit input is 0.1x. Vendor also quotes CNY; this is the USD rate.',
  },
  {
    id: 'kimi-k2-7-code',
    label: 'Kimi K2.7 Code',
    vendor: 'Moonshot AI',
    apiModelId: 'kimi-k2.7-code',
    inputPerMTok: 0.95,
    outputPerMTok: 4,
    cachedInputPerMTok: 0.19,
    contextWindow: 262_144,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://platform.kimi.ai/docs/pricing/chat',
    confidence: 'primary',
    litellmKey: 'moonshot/kimi-k2.7-code',
    notes:
      'Coding-specialised. A "High-Speed" variant exists at exactly 2x this rate ($1.90/$8.00).',
  },

  /* ── Alibaba ───────────────────────────────────────────────────────── */
  {
    id: 'qwen3-8-max',
    label: 'Qwen3.8-Max',
    vendor: 'Alibaba',
    apiModelId: 'qwen3.8-max',
    inputPerMTok: 2,
    outputPerMTok: 6,
    cachedInputPerMTok: 0.25,
    contextWindow: 1_000_000,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://www.alibabacloud.com/help/en/model-studio/qwen3-8-max',
    confidence: 'primary',
    litellmKey: 'dashscope/qwen3.8-max',
    notes:
      'Singapore region, flat 0-1M (no context tiers). The API id uses a DOT — qwen3.8-max, not qwen3-8-max. Other Qwen models DO tier by prompt length.',
  },
  {
    id: 'qwen3-coder-plus',
    label: 'Qwen3-Coder Plus',
    vendor: 'Alibaba',
    apiModelId: 'qwen3-coder-plus',
    inputPerMTok: 1,
    outputPerMTok: 5,
    cachedInputPerMTok: null,
    contextWindow: 1_000_000,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://www.alibabacloud.com/help/en/model-studio/qwen3-coder-plus',
    confidence: 'primary',
    litellmKey: 'dashscope/qwen3-coder-plus',
    notes:
      'The live price source carries this key with no price attached, so a live refresh leaves this row on its baked value — which is the correct, visible behaviour rather than a silent fallback to a reseller rate.',
  },

  /* ── DeepSeek ──────────────────────────────────────────────────────── */
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4-Pro',
    vendor: 'DeepSeek',
    apiModelId: 'deepseek-v4-pro',
    inputPerMTok: 1.32,
    outputPerMTok: 3.96,
    cachedInputPerMTok: 0.044,
    contextWindow: 1_000_000,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
    confidence: 'primary',
    litellmKey: 'deepseek/deepseek-v4-pro',
    notes:
      'Cache-hit input is 0.033x base — among the steepest cache discounts published. Best open-weight model on SWE-bench Verified (0.806) at this snapshot.',
  },
  {
    id: 'deepseek-flash',
    label: 'DeepSeek V4.1-Flash',
    vendor: 'DeepSeek',
    apiModelId: 'deepseek-flash',
    inputPerMTok: 0.3,
    outputPerMTok: 1.2,
    cachedInputPerMTok: 0.006,
    contextWindow: 1_000_000,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
    confidence: 'primary',
    litellmKey: 'deepseek/deepseek-flash',
    notes:
      'Released 2026-09-10. Cache-hit input is $0.006/M — effectively free to re-read context.',
  },

  /* ── xAI ───────────────────────────────────────────────────────────── */
  {
    id: 'grok-4-7',
    label: 'Grok 4.7',
    vendor: 'xAI',
    apiModelId: 'grok-4.7',
    inputPerMTok: 2,
    outputPerMTok: 6,
    cachedInputPerMTok: 0.5,
    contextWindow: 500_000,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://docs.x.ai/developers/pricing',
    confidence: 'primary',
    litellmKey: 'xai/grok-4.7',
    notes: 'Released 2026-09-21, two days before this snapshot.',
  },
  {
    id: 'grok-build-0-1',
    label: 'Grok Build 0.1',
    vendor: 'xAI',
    apiModelId: 'grok-build-0.1',
    inputPerMTok: 1,
    outputPerMTok: 2,
    cachedInputPerMTok: 0.2,
    contextWindow: 256_000,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://docs.x.ai/developers/pricing',
    confidence: 'primary',
    litellmKey: 'xai/grok-build-0.1',
    notes: 'Build-focused variant; the cheapest xAI output rate at $2/M.',
  },

  /* ── Z.ai (Zhipu) ──────────────────────────────────────────────────── */
  {
    id: 'glm-5-3',
    label: 'GLM-5.3',
    vendor: 'Z.ai',
    apiModelId: 'glm-5.3',
    inputPerMTok: 1.4,
    outputPerMTok: 4.4,
    cachedInputPerMTok: 0.26,
    contextWindow: 1_000_000,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://docs.z.ai/guides/overview/pricing',
    confidence: 'primary',
    litellmKey: 'zai/glm-5.3',
    notes:
      'Highest-scoring non-US-lab model on Terminal-Bench 4.0 at this snapshot. Z.ai also sells flat-rate coding subscriptions that bypass per-token pricing entirely.',
  },
  {
    id: 'glm-5-3-flash',
    label: 'GLM-5.3 Flash',
    vendor: 'Z.ai',
    apiModelId: 'glm-5.3-flash',
    inputPerMTok: 0.15,
    outputPerMTok: 0.5,
    cachedInputPerMTok: 0.03,
    contextWindow: 0,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://docs.z.ai/guides/overview/pricing',
    confidence: 'primary',
    litellmKey: 'zai/glm-5.3-flash',
    notes: 'Cheapest credible coding model in this catalog.',
  },

  /* ── Thinking Machines Lab ─────────────────────────────────────────── */
  {
    id: 'inkling',
    label: 'Inkling',
    vendor: 'Thinking Machines',
    apiModelId: 'thinkingmachines/Inkling',
    inputPerMTok: 1,
    outputPerMTok: 4.05,
    cachedInputPerMTok: 0.17,
    contextWindow: 524_288,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://tinker-docs.thinkingmachines.ai/tinker/models/',
    confidence: 'aggregator',
    litellmKey: 'together_ai/thinkingmachines/Inkling',
    notes:
      'SOURCES DISAGREE, recorded rather than resolved: five independent hosted providers (Together, Fireworks, Databricks, Baseten, OpenRouter) all list $1.00/$4.05 for inference, and that is the figure baked here. An independent re-read of the vendor doc came back with $1.87/$4.68 (list $3.74, described as a limited-time 50% discount) at a 64K window — most likely the Tinker fine-tuning service rather than inference. Marked "aggregator" confidence for that reason; treat as approximate and re-verify before quoting.',
  },
  {
    id: 'inkling-small',
    label: 'Inkling Small',
    vendor: 'Thinking Machines',
    apiModelId: 'thinkingmachines/Inkling-Small',
    inputPerMTok: 0.45,
    outputPerMTok: 1.2,
    cachedInputPerMTok: 0.116,
    contextWindow: 524_288,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://tinker-docs.thinkingmachines.ai/tinker/models/',
    confidence: 'aggregator',
    litellmKey: 'deepinfra/thinkingmachines/Inkling-Small',
    notes:
      '276B/12B MoE. Same source disagreement as Inkling: hosted providers cluster at $0.45-$0.50 input / $1.20 output; the vendor re-read reported $0.58/$1.44 after a limited-time discount. Baked at the corroborated $0.45/$1.20.',
  },

  /* ── Mistral ───────────────────────────────────────────────────────── */
  {
    id: 'devstral-2',
    label: 'Devstral 2',
    vendor: 'Mistral',
    apiModelId: 'devstral-medium-latest',
    inputPerMTok: 0.4,
    outputPerMTok: 2,
    cachedInputPerMTok: null,
    contextWindow: 256_000,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://mistral.ai/news/devstral-2-vibe-cli/',
    confidence: 'primary',
    litellmKey: 'mistral/devstral-latest',
    notes:
      "Agentic-coding specific, 123B. Announced free via Mistral's API at the time of checking — the $0.40/$2.00 here is the published paid rate, so this row may overstate what you actually pay today.",
  },
  {
    id: 'mistral-medium-3-5',
    label: 'Mistral Medium 3.5',
    vendor: 'Mistral',
    apiModelId: 'mistral-medium-2604',
    inputPerMTok: 1.5,
    outputPerMTok: 7.5,
    cachedInputPerMTok: null,
    contextWindow: 262_144,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://docs.mistral.ai/models/mistral-medium-3-5-26-04',
    confidence: 'primary',
    litellmKey: 'mistral/mistral-medium-3.5',
    notes: 'General-purpose flagship; Devstral 2 is the cheaper coding-specific sibling.',
  },

  /* ── MiniMax ───────────────────────────────────────────────────────── */
  {
    id: 'minimax-m3',
    label: 'MiniMax M3',
    vendor: 'MiniMax',
    apiModelId: 'MiniMax-M3',
    inputPerMTok: 0.3,
    outputPerMTok: 1.2,
    cachedInputPerMTok: null,
    contextWindow: 0,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://platform.minimax.io/docs/guides/pricing-paygo',
    confidence: 'primary',
    litellmKey: 'minimax/MiniMax-M3',
    notes:
      'Self-reported SWE-bench Verified 80.5%. MiniMax has held $0.30/$1.20 across the M2 and M3 generations.',
  },

  /* ── Meta ──────────────────────────────────────────────────────────── */
  {
    id: 'meta-muse-spark-1-3',
    label: 'Muse Spark 1.3',
    vendor: 'Meta',
    apiModelId: 'muse-spark-1.3',
    inputPerMTok: 1.25,
    outputPerMTok: 4.25,
    cachedInputPerMTok: 0.15,
    contextWindow: 1_048_576,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://dev.meta.ai/models/muse-spark/',
    confidence: 'primary',
    litellmKey: 'meta/muse-spark-1.3',
    notes:
      'Released 2026-09-02. A "contributor" tier exists at $0.10/$0.20 for qualifying open-source work.',
  },
] as const;

/** The model selected when the panel first renders. */
export const DEFAULT_MODEL_ID = 'claude-opus-5-5';

export function modelById(id: string): CatalogModel {
  return MODEL_CATALOG.find((m) => m.id === id) ?? MODEL_CATALOG[0]!;
}

/** Vendors in catalog order, each with its models — for grouped pickers. */
export function byVendor(
  models: readonly CatalogModel[] = MODEL_CATALOG,
): Array<{ vendor: string; models: CatalogModel[] }> {
  const out: Array<{ vendor: string; models: CatalogModel[] }> = [];
  for (const m of models) {
    const row = out.find((g) => g.vendor === m.vendor);
    if (row) row.models.push(m);
    else out.push({ vendor: m.vendor, models: [m] });
  }
  return out;
}

/**
 * The oldest `verifiedOn` across the given models — what the panel shows as
 * its freshness claim. Using the oldest (not the newest, not "today") means
 * the stamp can never overstate how current the visible set is.
 */
export function oldestVerifiedOn(models: readonly CatalogModel[] = MODEL_CATALOG): string {
  return models.reduce(
    (oldest, m) => (m.verifiedOn < oldest ? m.verifiedOn : oldest),
    '9999-99-99',
  );
}

/** Models carrying a usable per-token input price. */
export function pricedModels(
  models: readonly CatalogModel[] = MODEL_CATALOG,
): readonly CatalogModel[] {
  return models.filter((m) => typeof m.inputPerMTok === 'number');
}
