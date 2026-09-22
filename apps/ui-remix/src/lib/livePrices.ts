/**
 * livePrices — the "?" button's on-demand price refresh.
 *
 * STRICTLY ADDITIVE, BY CONSTRUCTION
 * The panel renders complete, labelled prices from lib/modelCatalog.ts with
 * zero network. This module can only ever overwrite those numbers with
 * fresher ones. Every failure path — offline, blocked, rate-limited, timed
 * out, malformed, model absent upstream — resolves to "keep the baked value
 * and say why", never to a blank or a zero. Nothing here runs on load; it
 * runs when a human clicks.
 *
 * WHY THIS SOURCE
 * The LiteLLM price index on raw.githubusercontent.com, because:
 *   - It sends `Access-Control-Allow-Origin: *`, so a static page can read it
 *     with no key and no backend of ours.
 *   - raw.githubusercontent.com is ALREADY in this app's CSP `connect-src`
 *     (the in-browser GitHub repo scanner uses it), so enabling this feature
 *     required no new third-party origin and no CSP change.
 *   - Checked against vendor pricing pages on 2026-09-23 it matched the
 *     primary source on the models where sources disagreed.
 *
 * WHAT IT COSTS THE VISITOR
 * ~2.7 MB raw / ~143 KB gzip, one request, only on click. That is why it is
 * behind a button and not on the load path.
 *
 * UNIT TRAP — the single most dangerous line in this file
 * The upstream file quotes USD per SINGLE token as a JSON number, often in
 * scientific notation: `7.5e-7` means $0.75 per 1M. Our catalog is per 1M.
 * Multiply by 1e6, exactly once, in perMFromPerToken() below. Getting this
 * wrong by 1e6 produces numbers that still look plausible in the UI, which is
 * precisely why it is isolated in one tested function rather than inlined.
 *
 * MATCHING IS EXACT, NEVER FUZZY
 * We look up `model.litellmKey` verbatim. No normalising, no regex, no
 * "close enough" match on the label. A near-miss silently prices one model
 * with another model's rate — the worst possible failure for a page whose
 * whole claim is honesty. A key that is absent upstream returns `missing`.
 */

/** Where the live index lives. Origin already present in the app CSP. */
export const LIVE_PRICE_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/** Give up rather than hang a click forever. */
export const LIVE_FETCH_TIMEOUT_MS = 20_000;

const CACHE_KEY = 'factstack.livePrices.v1';
/** Serve a recent answer instead of re-downloading ~2.7 MB on every click. */
export const CACHE_TTL_MS = 60 * 60 * 1000;

export interface LivePrice {
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  cachedInputPerMTok: number | null;
}

export type LiveStatus = 'idle' | 'loading' | 'ok' | 'error';

export interface LiveResult {
  /** Keyed by our catalog model id, NOT by the upstream key. */
  prices: Record<string, LivePrice>;
  /** Catalog ids the upstream index carried no usable price for. */
  missing: string[];
  /** Epoch ms when this data was fetched. */
  fetchedAt: number;
  /** True when served from this browser's cache rather than the network. */
  fromCache: boolean;
}

interface CatalogLike {
  id: string;
  litellmKey: string;
}

/**
 * USD-per-single-token -> USD-per-million-tokens.
 *
 * Returns null for anything that is not a finite, non-negative number —
 * upstream uses `undefined`, missing keys, and occasionally strings. A zero
 * IS meaningful (genuinely free models exist) and is preserved.
 */
export function perMFromPerToken(raw: unknown): number | null {
  /* An empty or blank string must NOT become 0. `Number('')` and
     `Number('   ')` are both 0, and 0 is meaningful here (genuinely free
     models exist), so without this guard a missing upstream price renders a
     PAID model as free — a wrong number shown confidently, which is the one
     failure this panel cannot afford. */
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  const perM = n * 1_000_000;
  /* Guard the unit trap from the other side: no real model costs more than
     $10,000 per 1M input tokens. A value past that means the upstream unit
     changed under us, and a wrong number is worse than no number. */
  if (perM > 10_000) return null;
  return perM;
}

/** Pull our models' rates out of the raw upstream index. */
export function extractPrices(
  index: unknown,
  models: readonly CatalogLike[],
): { prices: Record<string, LivePrice>; missing: string[] } {
  const prices: Record<string, LivePrice> = {};
  const missing: string[] = [];
  const db = (index ?? {}) as Record<string, Record<string, unknown> | undefined>;

  for (const m of models) {
    if (!m.litellmKey) {
      missing.push(m.id);
      continue;
    }
    const rec = db[m.litellmKey];
    const input = rec ? perMFromPerToken(rec['input_cost_per_token']) : null;
    if (input === null) {
      /* Either the key is absent upstream or it carries no usable input
         price. Both mean the same thing to the caller: keep the baked value. */
      missing.push(m.id);
      continue;
    }
    prices[m.id] = {
      inputPerMTok: input,
      outputPerMTok: perMFromPerToken(rec!['output_cost_per_token']),
      cachedInputPerMTok: perMFromPerToken(rec!['cache_read_input_token_cost']),
    };
  }
  return { prices, missing };
}

/* ─────────── per-browser cache ─────────── */

export function readCache(now: number): LiveResult | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LiveResult;
    if (typeof parsed?.fetchedAt !== 'number') return null;
    if (now - parsed.fetchedAt > CACHE_TTL_MS) return null;
    return { ...parsed, fromCache: true };
  } catch {
    /* Private mode, cleared storage, quota, corrupt entry — all non-fatal. */
    return null;
  }
}

export function writeCache(result: LiveResult): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ...result, fromCache: false }));
  } catch {
    /* Storage refused. The fetch still succeeded; only the cache is lost. */
  }
}

/**
 * A human-readable reason a refresh failed. Deliberately blunt: the panel
 * shows this verbatim, and a vague message here becomes a vague UI.
 */
export function describeFetchError(e: unknown): string {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'You appear to be offline — showing the prices baked into this page.';
  }
  if (e instanceof DOMException && e.name === 'AbortError') {
    return `The price source did not answer within ${Math.round(LIVE_FETCH_TIMEOUT_MS / 1000)}s — showing baked prices.`;
  }
  const msg = e instanceof Error ? e.message : String(e);
  return `Could not reach the live price source (${msg}) — showing baked prices.`;
}

/**
 * Fetch and map live prices. Rejects on network/HTTP/parse failure so the
 * caller can surface a reason; it never resolves to partial nonsense.
 *
 * @param models  catalog rows to look up
 * @param now     injected clock, so tests are deterministic
 * @param opts.force  skip the cache (the "check again" path)
 */
export async function fetchLivePrices(
  models: readonly CatalogLike[],
  now: number,
  opts: { force?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<LiveResult> {
  if (!opts.force) {
    const cached = readCache(now);
    if (cached) return cached;
  }

  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIVE_FETCH_TIMEOUT_MS);
  try {
    const res = await doFetch(LIVE_PRICE_URL, {
      signal: controller.signal,
      /* No credentials to a third party, ever. */
      credentials: 'omit',
      headers: { Accept: 'application/json, text/plain, */*' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    /* Upstream serves text/plain; res.json() parses it regardless. */
    const index = (await res.json()) as unknown;
    const { prices, missing } = extractPrices(index, models);
    if (Object.keys(prices).length === 0) {
      /* A 200 that yields nothing usable means the schema moved. Treat it as
         a failure rather than silently reporting "0 models updated". */
      throw new Error('price index returned no usable rates — its format may have changed');
    }
    const result: LiveResult = { prices, missing, fetchedAt: now, fromCache: false };
    writeCache(result);
    return result;
  } finally {
    clearTimeout(timer);
  }
}
