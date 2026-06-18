/**
 * F8 — per-file extraction + the content-hash extraction cache contract.
 *
 * `extractFile()` is the AST-expensive slice of analyze()'s per-file loop,
 * lifted into a PURE function of `(text, ext, wantRefs)`: it parses once and
 * returns the quad every language branch produces — imports, symbols, refs,
 * env-var reads. Because the quad depends ONLY on those inputs, it can be
 * memoized by content hash: that is the whole F8 cache. A cache hit skips the
 * Babel parse entirely, which is what makes warm re-analyzes fast ("touching
 * one file re-analyzes ~that file").
 *
 * The cache itself is just the `ExtractionCache` interface — a synchronous
 * Map-shaped contract. The core stays pure (INV1): pass nothing and analyze()
 * behaves exactly as before; the browser build passes nothing (INV7 no-op);
 * the Node CLI passes the sqlite-backed store from @factstack/emit.
 *
 * Correctness invariants:
 *  - INV2 (incremental == full): guaranteed by keying on `djb2(text)` + ext +
 *    refs-flag + EXTRACTION_CACHE_VERSION. Same key ⇒ extractFile would have
 *    returned the same value, so serving the stored value is indistinguishable
 *    from recomputing. Bump the VERSION whenever any extractor's behavior
 *    changes — a stale entry must never survive an extractor upgrade.
 *  - Isolation: consumers MUTATE extraction results downstream (the resolver
 *    backfills `imp.resolved`; Astro adjusts lines). `fromCache()` therefore
 *    deep-clones on read so a shared/persistent cache can never leak one
 *    run's mutations into the next.
 */

import {
  extractAstroFrontmatter,
  extractEnvVars,
  extractGoImports,
  extractGoSymbols,
  extractImports,
  extractPythonImports,
  extractSymbols,
  extractSymbolRefs,
  isAstro,
  isGo,
  isParseable,
  isPython,
  parseJS,
  type EnvVarRead,
  type ExtractedSymbol,
  type RawImport,
  type RawRef,
} from '@factstack/extractors';
import { sha256hex } from '@factstack/factspack';
import { detectLanguage } from '@factstack/scanners';

/** Bump on ANY behavior change in extractors/parse so stale entries die.
 *  v2: cache key switched from a 32-bit djb2 digest to SHA-256 — a djb2
 *  collision between two same-ext files could serve the wrong file's parse
 *  (silent INV2 violation). Bumping retires every djb2-keyed entry. */
export const EXTRACTION_CACHE_VERSION = 2;

/** The parse-derived facts of one file — everything analyze() takes from the
 *  AST pass. Plain JSON data (structuredClone/serialization safe). */
export interface FileExtraction {
  imports: RawImport[];
  symbols: ExtractedSymbol[];
  /** Identifier refs for the F2 symbol graph; populated only when extracted
   *  with `wantRefs` (the cache key segregates the two modes). */
  refs: RawRef[];
  envReads: EnvVarRead[];
}

/**
 * Synchronous content-addressed store. `get` may return undefined/null on
 * miss. Implementations may persist anywhere (sqlite, JSON, memory) — values
 * round-trip as JSON. Core treats the store as UNTRUSTED for freshness only
 * (keys handle that), but trusted for integrity.
 */
export interface ExtractionCache {
  get(key: string): FileExtraction | undefined | null;
  set(key: string, value: FileExtraction): void;
}

/** The canonical cache key. ext is part of the key because parsing behavior
 *  branches on it; the refs flag because a no-refs entry can't serve a
 *  `--symbols` run; the version so extractor upgrades invalidate everything.
 *  The content hash is SHA-256 (not djb2): the store keys purely on this
 *  string with no secondary content check, so the hash must be collision
 *  -resistant or a hit could return another file's parse — a silent INV2
 *  violation (warm-cache output diverging from a fresh parse). */
export function extractionCacheKey(text: string, ext: string, wantRefs: boolean): string {
  return `v${EXTRACTION_CACHE_VERSION}:${ext.toLowerCase()}:${wantRefs ? 'r1' : 'r0'}:${sha256hex(text)}`;
}

/** Fresh empty quad per call — consumers mutate extraction arrays, so a
 *  shared module-level constant would be silently corrupted. */
function empty(): FileExtraction {
  return { imports: [], symbols: [], refs: [], envReads: [] };
}

/**
 * The AST-expensive per-file extraction, pure in `(text, ext, wantRefs)`.
 * Mirrors analyze()'s former inline branches exactly:
 *  - JS/TS (and .jsx/.tsx/.mjs/…): one Babel parse shared by all extractors.
 *  - Astro: frontmatter sliced, parsed as TS, line numbers shifted back.
 *  - Python / Go: regex import + symbol extractors, regex env-var scan.
 *  - Everything else: the empty quad.
 * Never throws; a parse failure degrades to the empty quad (matching the
 * previous inline behavior where `parsed == null` skipped extraction).
 */
export function extractFile(text: string, ext: string, wantRefs: boolean): FileExtraction {
  const lang = detectLanguage(ext);

  if (lang && isParseable(ext)) {
    const parsed = parseJS(text, ext);
    if (!parsed) return empty();
    return {
      imports: extractImports(text, ext, parsed),
      symbols: extractSymbols(text, ext, parsed),
      refs: wantRefs ? extractSymbolRefs(text, ext, parsed) : [],
      envReads: extractEnvVars(text, ext, parsed),
    };
  }

  if (isAstro(ext)) {
    const fm = extractAstroFrontmatter(text);
    if (!fm) return empty();
    const parsed = parseJS(fm.source, '.ts');
    if (!parsed) return empty();
    const imports = extractImports(fm.source, '.ts', parsed);
    for (const r of imports) {
      if (typeof r.line === 'number') r.line += fm.lineOffset;
    }
    const symbols = extractSymbols(fm.source, '.ts', parsed).map((s) => ({
      ...s,
      startLine: s.startLine + fm.lineOffset,
      endLine: s.endLine + fm.lineOffset,
      ...(s.children ? { children: s.children.map((c) => ({
        ...c,
        startLine: c.startLine + fm.lineOffset,
        endLine: c.endLine + fm.lineOffset,
      })) } : {}),
    }));
    const refs = wantRefs
      ? extractSymbolRefs(fm.source, '.ts', parsed).map((r) => ({ ...r, line: r.line + fm.lineOffset }))
      : [];
    const envReads = extractEnvVars(fm.source, '.ts', parsed).map((r) => ({
      ...r,
      line: r.line + fm.lineOffset,
    }));
    return { imports, symbols, refs, envReads };
  }

  if (isPython(ext)) {
    return {
      imports: extractPythonImports(text),
      symbols: [],
      refs: [],
      envReads: extractEnvVars(text, ext, null),
    };
  }

  if (isGo(ext)) {
    return {
      imports: extractGoImports(text),
      symbols: extractGoSymbols(text),
      refs: [],
      envReads: extractEnvVars(text, ext, null),
    };
  }

  return empty();
}

/** Deep-clone a cached value before handing it to analyze() — downstream
 *  passes mutate extraction objects (resolved-backfill, line shifts), and a
 *  persistent or in-memory cache must never observe those mutations. */
export function fromCache(value: FileExtraction): FileExtraction {
  return structuredClone(value);
}

/**
 * Cache-consulting wrapper used by analyze(): hit → isolated clone of the
 * stored quad; miss → compute via extractFile and store. With no cache this
 * is exactly extractFile (the pre-F8 path).
 */
export function extractFileCached(
  text: string,
  ext: string,
  wantRefs: boolean,
  cache: ExtractionCache | undefined,
): FileExtraction {
  if (!cache) return extractFile(text, ext, wantRefs);
  const key = extractionCacheKey(text, ext, wantRefs);
  const hit = cache.get(key);
  if (hit) return fromCache(hit);
  const fresh = extractFile(text, ext, wantRefs);
  // Store a CLONE: the returned quad is mutated downstream (resolved-backfill),
  // and a reference-holding cache (in-memory Map) must keep the pristine value.
  cache.set(key, structuredClone(fresh));
  return fresh;
}
