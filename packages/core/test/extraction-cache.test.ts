/**
 * F8 extraction-cache contract. The cache's headline invariant is INV2 — a
 * cached run must be byte-identical to an uncached run — plus the isolation
 * rule that downstream mutation (resolver backfill, Astro line shifts) can
 * never leak into a shared/persistent store. Neither was covered, so a future
 * "optimization" that returned the stored reference directly, or a key that
 * failed to segregate the refs/ext modes, would have passed silently. These
 * tests pin all of it at the function level.
 */

import { describe, expect, it } from 'vitest';
import {
  EXTRACTION_CACHE_VERSION,
  extractFile,
  extractFileCached,
  extractionCacheKey,
  fromCache,
  type ExtractionCache,
  type FileExtraction,
} from '../src/extraction-cache.js';

const SRC = [
  "import { foo } from './foo';",
  '',
  'export function bar() {',
  '  const key = process.env.API_KEY;',
  '  return foo(key);',
  '}',
].join('\n');

function makeCache(): { cache: ExtractionCache; store: Map<string, FileExtraction>; sets: number } {
  const store = new Map<string, FileExtraction>();
  const state = { sets: 0 };
  const cache: ExtractionCache = {
    get: (k) => store.get(k),
    set: (k, v) => {
      state.sets++;
      store.set(k, v);
    },
  };
  return { cache, store, get sets() { return state.sets; } } as never;
}

describe('extractFile — pure baseline', () => {
  it('extracts imports, symbols, env reads from a TS file', () => {
    const r = extractFile(SRC, '.ts', false);
    expect(r.imports.map((i) => i.specifier)).toContain('./foo');
    expect(r.symbols.map((s) => s.name)).toContain('bar');
    expect(r.envReads.map((e) => e.name)).toContain('API_KEY');
  });

  it('populates refs ONLY when wantRefs is set', () => {
    expect(extractFile(SRC, '.ts', false).refs).toHaveLength(0);
    expect(extractFile(SRC, '.ts', true).refs.length).toBeGreaterThan(0);
  });

  it('degrades to the empty quad on an unparseable extension', () => {
    expect(extractFile('hello world', '.unknownext', true)).toEqual({
      imports: [],
      symbols: [],
      refs: [],
      envReads: [],
    });
  });
});

describe('extractionCacheKey — segregation', () => {
  it('embeds the cache version so an extractor upgrade invalidates everything', () => {
    expect(extractionCacheKey(SRC, '.ts', false).startsWith(`v${EXTRACTION_CACHE_VERSION}:`)).toBe(true);
  });

  it('segregates by refs flag — a no-refs entry must not serve a --symbols run', () => {
    expect(extractionCacheKey(SRC, '.ts', false)).not.toBe(extractionCacheKey(SRC, '.ts', true));
  });

  it('segregates by extension (parsing branches on it)', () => {
    expect(extractionCacheKey(SRC, '.ts', true)).not.toBe(extractionCacheKey(SRC, '.tsx', true));
  });

  it('is stable for identical inputs (content-addressed)', () => {
    expect(extractionCacheKey(SRC, '.ts', true)).toBe(extractionCacheKey(SRC, '.ts', true));
  });
});

describe('extractFileCached — INV2 + isolation', () => {
  it('with no cache behaves exactly like extractFile', () => {
    expect(extractFileCached(SRC, '.ts', true, undefined)).toEqual(extractFile(SRC, '.ts', true));
  });

  it('a cache hit equals a cache miss (INV2: cached == uncached)', () => {
    const { cache } = makeCache();
    const miss = extractFileCached(SRC, '.ts', true, cache); // computes + stores
    const hit = extractFileCached(SRC, '.ts', true, cache); // served from store
    expect(hit).toEqual(miss);
    expect(hit).toEqual(extractFile(SRC, '.ts', true));
  });

  it('only parses once — the second call is served, not recomputed', () => {
    const store = new Map<string, FileExtraction>();
    let gets = 0;
    let sets = 0;
    const cache: ExtractionCache = {
      get: (k) => { gets++; return store.get(k); },
      set: (k, v) => { sets++; store.set(k, v); },
    };
    extractFileCached(SRC, '.ts', true, cache);
    extractFileCached(SRC, '.ts', true, cache);
    expect(sets).toBe(1); // stored once
    expect(gets).toBe(2); // consulted twice
  });

  it('mutating a returned value never corrupts the stored entry (store-side clone)', () => {
    const store = new Map<string, FileExtraction>();
    const cache: ExtractionCache = { get: (k) => store.get(k), set: (k, v) => void store.set(k, v) };
    const first = extractFileCached(SRC, '.ts', true, cache); // miss: returns the live object, stores a clone
    first.imports.push({ specifier: 'INJECTED', kind: 'import', line: 999 } as never);
    first.symbols.length = 0;
    const second = extractFileCached(SRC, '.ts', true, cache); // hit
    expect(second.imports.map((i) => i.specifier)).not.toContain('INJECTED');
    expect(second.symbols.map((s) => s.name)).toContain('bar');
  });

  it('mutating one hit never corrupts the next (read-side clone)', () => {
    const store = new Map<string, FileExtraction>();
    const cache: ExtractionCache = { get: (k) => store.get(k), set: (k, v) => void store.set(k, v) };
    extractFileCached(SRC, '.ts', true, cache); // prime
    const a = extractFileCached(SRC, '.ts', true, cache); // hit -> clone
    a.imports.length = 0;
    const b = extractFileCached(SRC, '.ts', true, cache); // hit -> fresh clone
    expect(b.imports.map((i) => i.specifier)).toContain('./foo');
  });
});

describe('fromCache — deep clone', () => {
  it('returns a value disconnected from the source object', () => {
    const original = extractFile(SRC, '.ts', true);
    const clone = fromCache(original);
    expect(clone).toEqual(original);
    clone.imports.length = 0;
    expect(original.imports.length).toBeGreaterThan(0);
  });
});
