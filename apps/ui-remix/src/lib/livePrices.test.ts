/**
 * The live price refresh.
 *
 * Two failure modes here are genuinely dangerous because they look fine in
 * the UI: a 1e6 unit slip (the upstream file quotes USD per SINGLE token), and
 * a fuzzy key match that prices one model with another model's rate. Both are
 * pinned below. Everything else is about degrading to the baked prices
 * loudly rather than silently.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CACHE_TTL_MS,
  describeFetchError,
  extractPrices,
  fetchLivePrices,
  perMFromPerToken,
  readCache,
  writeCache,
} from './livePrices.ts';

const NOW = 1_790_000_000_000;

describe('perMFromPerToken — the unit conversion', () => {
  it('converts USD-per-token to USD-per-million', () => {
    expect(perMFromPerToken(0.000004)).toBeCloseTo(4, 9); // Opus 5.5
    expect(perMFromPerToken(7.5e-7)).toBeCloseTo(0.75, 9); // Gemini 3.8 Flash
    expect(perMFromPerToken(0.00001)).toBeCloseTo(10, 9); // Fable 5.1
  });

  it('accepts the scientific-notation and string spellings upstream uses', () => {
    expect(perMFromPerToken(1.5e-7)).toBeCloseTo(0.15, 9);
    expect(perMFromPerToken('0.000005')).toBeCloseTo(5, 9);
  });

  it('preserves a genuine zero — free is not the same as unknown', () => {
    expect(perMFromPerToken(0)).toBe(0);
  });

  it('rejects anything that is not a usable number', () => {
    expect(perMFromPerToken(undefined)).toBeNull();
    expect(perMFromPerToken(null)).toBeNull();
    expect(perMFromPerToken('free')).toBeNull();
    expect(perMFromPerToken(-1)).toBeNull();
    expect(perMFromPerToken(Number.NaN)).toBeNull();
  });

  it('rejects a value implying the upstream unit changed', () => {
    // 0.02 per token would be $20,000/M — no real model. Better no number.
    expect(perMFromPerToken(0.02)).toBeNull();
  });
});

describe('extractPrices — exact keys only', () => {
  const index = {
    'claude-opus-5-5': {
      input_cost_per_token: 0.000004,
      output_cost_per_token: 0.00002,
      cache_read_input_token_cost: 2e-7,
    },
    'gemini-3.8-flash': { input_cost_per_token: 7.5e-7, output_cost_per_token: 0.00000375 },
    'dashscope/qwen3-coder-plus': { litellm_provider: 'dashscope' }, // present, no price
  };

  it('maps upstream rates onto our catalog ids', () => {
    const { prices } = extractPrices(index, [
      { id: 'claude-opus-5-5', litellmKey: 'claude-opus-5-5' },
      { id: 'gemini-3-8-flash', litellmKey: 'gemini-3.8-flash' },
    ]);
    // Compared field-wise with a tolerance: 2e-7 * 1e6 is 0.19999999999999998
    // in IEEE754. Rounding the rate to make an assertion pretty would mean
    // rounding real prices, so the float is kept and the test absorbs it.
    expect(prices['claude-opus-5-5']!.inputPerMTok).toBeCloseTo(4, 9);
    expect(prices['claude-opus-5-5']!.outputPerMTok).toBeCloseTo(20, 9);
    expect(prices['claude-opus-5-5']!.cachedInputPerMTok).toBeCloseTo(0.2, 9);
    expect(prices['gemini-3-8-flash']!.inputPerMTok).toBeCloseTo(0.75, 9);
  });

  it('NEVER fuzzy-matches a near-miss key onto another model', () => {
    // 'claude-opus-5' is not in the index; 'claude-opus-5-5' is. A normalising
    // or prefix match would hand back Opus 5.5's rate for Opus 5.
    const { prices, missing } = extractPrices(index, [
      { id: 'claude-opus-5', litellmKey: 'claude-opus-5' },
    ]);
    expect(prices['claude-opus-5']).toBeUndefined();
    expect(missing).toEqual(['claude-opus-5']);
  });

  it('reports a key that exists upstream but carries no price as missing', () => {
    const { prices, missing } = extractPrices(index, [
      { id: 'qwen3-coder-plus', litellmKey: 'dashscope/qwen3-coder-plus' },
    ]);
    expect(prices['qwen3-coder-plus']).toBeUndefined();
    expect(missing).toEqual(['qwen3-coder-plus']);
  });

  it('reports a model we deliberately have no key for as missing', () => {
    const { missing } = extractPrices(index, [{ id: 'gemini-antigravity', litellmKey: '' }]);
    expect(missing).toEqual(['gemini-antigravity']);
  });

  it('survives a garbage index without throwing', () => {
    for (const bad of [null, undefined, 42, 'nope', []]) {
      expect(() => extractPrices(bad, [{ id: 'a', litellmKey: 'a' }])).not.toThrow();
    }
  });
});

describe('the per-browser cache', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });

  it('round-trips a result and marks it as cached on the way out', () => {
    writeCache({
      prices: { a: { inputPerMTok: 1, outputPerMTok: 2, cachedInputPerMTok: null } },
      missing: [],
      fetchedAt: NOW,
      fromCache: false,
    });
    const got = readCache(NOW + 1000);
    expect(got!.prices['a']!.inputPerMTok).toBe(1);
    expect(got!.fromCache).toBe(true);
  });

  it('ignores an answer older than the TTL', () => {
    writeCache({
      prices: { a: { inputPerMTok: 1, outputPerMTok: 2, cachedInputPerMTok: null } },
      missing: [],
      fetchedAt: NOW,
      fromCache: false,
    });
    expect(readCache(NOW + CACHE_TTL_MS + 1)).toBeNull();
  });

  it('survives a browser that refuses storage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('private mode');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {},
    });
    expect(() =>
      writeCache({ prices: {}, missing: [], fetchedAt: NOW, fromCache: false }),
    ).not.toThrow();
    expect(readCache(NOW)).toBeNull();
  });
});

describe('fetchLivePrices', () => {
  const models = [{ id: 'opus', litellmKey: 'claude-opus-5-5' }];
  const good = {
    'claude-opus-5-5': { input_cost_per_token: 0.000004, output_cost_per_token: 0.00002 },
  };
  const jsonRes = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });

  it('fetches, converts and caches', async () => {
    const fetchImpl = vi.fn(() => jsonRes(good)) as unknown as typeof fetch;
    const r = await fetchLivePrices(models, NOW, { fetchImpl });
    expect(r.prices['opus']!.inputPerMTok).toBe(4);
    expect(r.fromCache).toBe(false);
    // Second call is served from cache — no second network hit.
    const r2 = await fetchLivePrices(models, NOW + 1000, { fetchImpl });
    expect(r2.fromCache).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('force bypasses the cache', async () => {
    const fetchImpl = vi.fn(() => jsonRes(good)) as unknown as typeof fetch;
    await fetchLivePrices(models, NOW, { fetchImpl });
    await fetchLivePrices(models, NOW + 1000, { fetchImpl, force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws on an HTTP error rather than reporting empty prices', async () => {
    const fetchImpl = (() => jsonRes({}, 503)) as unknown as typeof fetch;
    await expect(fetchLivePrices(models, NOW, { fetchImpl })).rejects.toThrow(/503/);
  });

  it('treats a 200 that yields no usable rate as a failure, not as "0 updated"', async () => {
    const fetchImpl = (() =>
      jsonRes({ 'something-else': { input_cost_per_token: 1e-6 } })) as unknown as typeof fetch;
    await expect(fetchLivePrices(models, NOW, { fetchImpl })).rejects.toThrow(
      /format may have changed/,
    );
  });
});

describe('describeFetchError names the cause', () => {
  it('calls out being offline', () => {
    vi.stubGlobal('navigator', { onLine: false });
    expect(describeFetchError(new Error('boom'))).toMatch(/offline/i);
  });

  it('calls out a timeout', () => {
    vi.stubGlobal('navigator', { onLine: true });
    const abort = new DOMException('aborted', 'AbortError');
    expect(describeFetchError(abort)).toMatch(/did not answer/i);
  });

  it('always says the baked prices are still showing', () => {
    vi.stubGlobal('navigator', { onLine: true });
    expect(describeFetchError(new Error('nope'))).toMatch(/baked prices/i);
  });
});
