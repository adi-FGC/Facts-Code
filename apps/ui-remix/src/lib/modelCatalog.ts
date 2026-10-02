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
 * HOW THESE NUMBERS WERE OBTAINED (first 2026-09-23, re-verified 2026-10-02)
 * Each row was researched against the vendor's own pricing or model page,
 * then INDEPENDENTLY re-checked by a second pass whose instructions were to
 * refute it — open the primary page again and compare every rate. On
 * 2026-10-02 every row was re-read that way: no list price had moved; the
 * corrections were cached-input rates, max-input figures and caveats
 * (peak-hour and prompt-length tiers, an introductory price). Sonnet 5.5 and
 * GPT-6.1 Sol were added; Devstral 2 was dropped (Mistral retired it on
 * 2026-07-31); Inkling's earlier source disagreement was resolved by the
 * vendor's own serverless price. Where sources disagree, the disagreement is
 * recorded in `notes` rather than resolved silently in the product's favour.
 *
 * `verifiedOn` IS PER MODEL, DELIBERATELY
 * Not one global "last updated" stamp. Prices move independently — Sonnet 5
 * held introductory pricing past its announced end date; Gemini 3.8 Flash is
 * on an introductory rate until the end of 2026; Qwen re-tiers by region. A
 * single banner date would claim freshness for rows nobody re-checked.
 * Re-verify one row, bump one date. The UI surfaces the OLDEST date in the
 * visible set, so the panel can never look fresher than its stalest row.
 *
 * RULES FOR EDITING
 *   - Never adjust a price without opening `sourceUrl` and bumping
 *     `verifiedOn` in the same edit. A price without a re-read is a guess.
 *   - `inputPerMTok: null` means "no published per-token price", NOT free and
 *     NOT zero. Free models are 0. The two render differently on purpose.
 *   - `litellmKey` must be an EXACT key from the live price file, verified by
 *     lookup — never guessed from the label, never fuzzy-matched at runtime.
 *     A wrong key silently shows another model's price. '' = deliberately
 *     absent from the live source, or present only under a reseller whose
 *     rate differs from the vendor's (a live refresh must never swap the
 *     vendor's price for a reseller's).
 *   - All rates are USD per 1,000,000 tokens, standard (non-batch,
 *     non-cached) rates, normalised from whatever unit the vendor quotes.
 *     Where a vendor tiers by prompt length or time of day, the row carries
 *     the base tier and `notes` says what the other tiers cost.
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

const V = '2026-10-02';

/**
 * Roughly the top two or three models per vendor, biased to what people
 * actually code with rather than to the cheapest or the newest. Kept
 * deliberately short: the panel is a cost calculator, not a model directory,
 * and a 150-row list makes "find yourself" harder, not easier.
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
      'Released 2026-09-22; still the newest Opus. Cache read is 0.05x base input, not the usual 0.1x. Fast mode (research preview) reprices to $8/$40.',
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Sonnet 5.5',
    vendor: 'Anthropic',
    apiModelId: 'claude-sonnet-5-5',
    inputPerMTok: 2,
    outputPerMTok: 10,
    cachedInputPerMTok: 0.2,
    contextWindow: 1_000_000,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://platform.claude.com/docs/en/models/sonnet-5-5/overview',
    confidence: 'primary',
    litellmKey: 'claude-sonnet-5-5',
    notes:
      'Released 2026-09-28. Same per-token price as Sonnet 5. Cache read is the standard 0.1x ($0.20).',
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
    contextWindow: 922_000,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-6-astra',
    confidence: 'primary',
    litellmKey: 'gpt-6-astra',
    notes:
      'Released 2026-09-03. Base rate for prompts up to 272K input tokens; longer prompts cost 2x input and 1.5x output. Cached input is 0.1x base. The window is 1,050,000 tokens, of which up to 922,000 can be input.',
  },
  {
    id: 'gpt-6-1-sol',
    label: 'GPT-6.1 Sol',
    vendor: 'OpenAI',
    apiModelId: 'gpt-6.1-sol',
    inputPerMTok: 2,
    outputPerMTok: 10,
    cachedInputPerMTok: 0.1,
    contextWindow: 922_000,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-6.1-sol',
    confidence: 'primary',
    litellmKey: 'gpt-6.1-sol',
    notes:
      'Released 2026-09-29; now OpenAI’s featured Sol model. Same $2/$10 as GPT-6 Sol with half the cached-input rate. Base rate for prompts up to 272K input tokens; longer prompts cost 2x input and 1.5x output. The API id uses a DOT (gpt-6.1-sol).',
  },
  {
    id: 'gpt-6-sol',
    label: 'GPT-6 Sol',
    vendor: 'OpenAI',
    apiModelId: 'gpt-6-sol',
    inputPerMTok: 2,
    outputPerMTok: 10,
    cachedInputPerMTok: 0.2,
    contextWindow: 922_000,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-6-sol',
    confidence: 'primary',
    litellmKey: 'gpt-6-sol',
    notes:
      'Released 2026-09-22. Still active, but GPT-6.1 Sol has replaced it as the featured Sol model. Base rate for prompts up to 272K input tokens.',
  },
  {
    id: 'gpt-5-6-terra',
    label: 'GPT-5.6 Terra',
    vendor: 'OpenAI',
    apiModelId: 'gpt-5.6-terra',
    inputPerMTok: 2,
    outputPerMTok: 12,
    cachedInputPerMTok: 0.2,
    contextWindow: 922_000,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-5.6-terra',
    confidence: 'primary',
    litellmKey: 'gpt-5.6-terra',
    notes:
      'Previous generation, still active. Prompts over 272K input tokens cost 2x input and 1.5x output. The API id uses a DOT (gpt-5.6-terra); the hyphenated spelling is not a valid model id.',
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
    litellmKey: 'gemini/gemini-3.8-flash',
    notes:
      'Introductory paid-tier price until 2026-12-31. From 2027-01-01 Google lists $1.50 input / $7.50 output ($0.15 cached).',
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
    litellmKey: 'gemini/gemini-3.1-pro-preview',
    notes:
      'Preview channel, no shutdown date announced. Base rate for prompts up to 200K tokens; longer prompts cost $4 input / $18 output ($0.40 cached).',
  },
  {
    id: 'gemini-antigravity',
    label: 'Antigravity',
    vendor: 'Google',
    apiModelId: 'antigravity-preview-09-2026',
    inputPerMTok: null,
    outputPerMTok: null,
    cachedInputPerMTok: null,
    contextWindow: 0,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://ai.google.dev/gemini-api/docs/antigravity-agent',
    confidence: 'primary',
    litellmKey: '',
    notes:
      'A managed coding agent with no per-token price of its own: you pay the rates of the Gemini model underneath it (Gemini 3.8 Flash by default), and sandbox compute is not billed during the preview. Listed so its absence from the price list is visible rather than silently omitted.',
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
    notes:
      'Cache hits are 0.1x ($0.30); writing to the cache costs extra ($3 per 1M for a 5-minute TTL, $6 for 1 hour). Vendor also quotes CNY; this is the USD rate.',
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
      'Coding-specialised. A high-speed variant costs exactly 2x this rate ($1.90/$8.00, $0.38 cached).',
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
    contextWindow: 991_808,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://www.alibabacloud.com/help/en/model-studio/qwen3-8-max',
    confidence: 'primary',
    litellmKey: 'dashscope/qwen3.8-max',
    notes:
      'Singapore region, flat across prompt lengths; Beijing and global regions charge $1.65/$4.951. The window is 1,000,000 tokens, of which up to 991,808 can be input (983,616 in thinking mode). The API id uses a DOT — qwen3.8-max.',
  },
  {
    id: 'qwen3-coder-plus',
    label: 'Qwen3-Coder Plus',
    vendor: 'Alibaba',
    apiModelId: 'qwen3-coder-plus',
    inputPerMTok: 1,
    outputPerMTok: 5,
    cachedInputPerMTok: 0.2,
    contextWindow: 997_952,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://www.alibabacloud.com/help/en/model-studio/qwen3-coder-plus',
    confidence: 'primary',
    litellmKey: 'dashscope/qwen3-coder-plus',
    notes:
      'Singapore region, base tier for prompts up to 32K tokens; longer prompts cost more ($1.80/$9 to 128K, $3/$15 to 256K, $6/$60 to 1M). The live price source carries this key with no price, so a live refresh leaves this row on its baked value.',
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
      'Peak-hours rate (weekdays 01:00–04:00 and 06:00–10:00 UTC); every other hour bills at half this. Cache-hit input is 0.033x base.',
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
      'Released 2026-09-10. Peak-hours rate; off-peak bills at half. Cache-hit input is $0.006/M — effectively free to re-read context.',
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
    notes:
      'Released 2026-09-21; still xAI’s newest. Base rate for prompts under 200K tokens; at 200K or more, every token bills at $4 input / $12 output ($1 cached).',
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
    sourceUrl: 'https://docs.x.ai/developers/models/grok-build-0.1',
    confidence: 'primary',
    litellmKey: 'xai/grok-build-0.1',
    notes:
      'Build-focused variant; the cheapest xAI output rate. Base rate under 200K tokens; at 200K or more, $2 input / $4 output ($0.40 cached).',
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
      'Reasoning is always on. Z.ai also sells flat-rate coding subscriptions that bypass per-token pricing entirely.',
  },
  {
    id: 'glm-5-3-flash',
    label: 'GLM-5.3 Flash',
    vendor: 'Z.ai',
    apiModelId: 'glm-5.3-flash',
    inputPerMTok: 0.15,
    outputPerMTok: 0.5,
    cachedInputPerMTok: 0.03,
    contextWindow: 1_000_000,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://docs.z.ai/guides/overview/pricing',
    confidence: 'primary',
    litellmKey: 'zai/glm-5.3-flash',
    notes:
      'Cheapest coding model in this catalog. A faster FlashX variant costs $0.37/$1.25 ($0.075 cached).',
  },

  /* ── Thinking Machines Lab ─────────────────────────────────────────── */
  {
    id: 'inkling',
    label: 'Inkling',
    vendor: 'Thinking Machines',
    apiModelId: 'thinkingmachines/Inkling:peft:262144:sampling-nvfp4',
    inputPerMTok: 1,
    outputPerMTok: 4.05,
    cachedInputPerMTok: 0.17,
    contextWindow: 262_144,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl:
      'https://tinker-docs.thinkingmachines.ai/tinker/models/models_and_pricing/#serverless-inference-beta',
    confidence: 'primary',
    /* The live index carries Inkling only under resellers; '' so a refresh
       never swaps the vendor's own price for one. */
    litellmKey: '',
    notes:
      'Thinking Machines’ own serverless inference price — in beta and “not recommended for intensive production use”. The model handles 1M tokens natively; the vendor’s API serves 256K. The higher figures seen earlier came from its fine-tuning price table.',
  },
  {
    id: 'inkling-small',
    label: 'Inkling Small',
    vendor: 'Thinking Machines',
    apiModelId: 'thinkingmachines/Inkling-Small:peft:262144:sampling-nvfp4',
    inputPerMTok: 0.3,
    outputPerMTok: 1.2,
    cachedInputPerMTok: 0.06,
    contextWindow: 262_144,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl:
      'https://tinker-docs.thinkingmachines.ai/tinker/models/models_and_pricing/#serverless-inference-beta',
    confidence: 'primary',
    /* Resellers in the live index charge $0.45-$0.50 input; '' so a refresh
       never shows theirs as this row's price. */
    litellmKey: '',
    notes:
      'The vendor’s own beta serverless price; resellers in the LiteLLM index charge more for input ($0.45–$0.50). The vendor’s API serves 256K of a 1M native window.',
  },

  /* ── Mistral ───────────────────────────────────────────────────────── */
  {
    id: 'mistral-medium-3-5',
    label: 'Mistral Medium 3.5',
    vendor: 'Mistral',
    apiModelId: 'mistral-medium-3-5',
    inputPerMTok: 1.5,
    outputPerMTok: 7.5,
    cachedInputPerMTok: 0.15,
    contextWindow: 262_144,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://docs.mistral.ai/inference/pricing',
    confidence: 'primary',
    litellmKey: 'mistral/mistral-medium-3-5',
    notes:
      'Mistral’s recommended coding model since Devstral 2 was retired on 2026-07-31. Mistral states the window only as “256k”; 262,144 is the live index’s figure.',
  },

  /* ── MiniMax ───────────────────────────────────────────────────────── */
  {
    id: 'minimax-m3',
    label: 'MiniMax M3',
    vendor: 'MiniMax',
    apiModelId: 'MiniMax-M3',
    inputPerMTok: 0.3,
    outputPerMTok: 1.2,
    cachedInputPerMTok: 0.06,
    contextWindow: 1_000_000,
    codingNotable: true,
    verifiedOn: V,
    sourceUrl: 'https://platform.minimax.io/docs/guides/pricing-paygo',
    confidence: 'primary',
    litellmKey: 'minimax/MiniMax-M3',
    notes:
      'Base tier for prompts up to 512K tokens; above that $0.60/$2.40. These rates include what MiniMax labels a “permanent 50% off”. Its newer M3.1 Flash preview is subscription-only, with no per-token price.',
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
      'Standard tier. A cheaper “contributor” tier ($0.10/$0.20) lets Meta train on your data. No long-context premium.',
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
