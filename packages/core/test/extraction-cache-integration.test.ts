/**
 * F8 — analyze()-level extraction-cache integration tests.
 *
 * The function-level contract lives in extraction-cache.test.ts. This file
 * pins the end-to-end safety case through the real analyze() pipeline:
 *  - INCREMENTAL == FULL (INV2): a cached analyze emits a byte-identical
 *    artifact to an uncached one — cold AND warm.
 *  - A one-file edit re-parses ~that one file (the F8 DoD): unchanged code
 *    files hit the cache; only the changed file is a miss.
 */

import { describe, expect, it } from 'vitest';
import { analyze } from '../src/index.js';
import type { ExtractionCache, FileExtraction } from '../src/extraction-cache.js';
import { memoryFS } from '@factstack/fs-memory';

class MemCache implements ExtractionCache {
  store = new Map<string, FileExtraction>();
  hits = 0;
  misses = 0;
  get(key: string): FileExtraction | undefined {
    const v = this.store.get(key);
    if (v) this.hits++;
    else this.misses++;
    return v;
  }
  set(key: string, value: FileExtraction): void {
    this.store.set(key, value);
  }
}

const FILES = {
  'package.json': JSON.stringify({ name: 'app', version: '0.1.0' }),
  'src/index.ts': `import { user } from './user';\nexport function main() { return user(); }\n`,
  'src/user.ts': `export function user() { return process.env.DB_URL; }\n`,
  'svc/main.go': `package main\nimport "fmt"\nfunc Main() { fmt.Println("hi") }\n`,
  'etl/load.py': `import os\nDB = os.environ['DB']\n`,
  'docs/readme.md': `# App\n\nSee [user](src/user.ts).\n`,
};

function stripVolatile(agent: unknown): unknown {
  const a = JSON.parse(JSON.stringify(agent));
  delete a.generatedAt;
  return a;
}

describe('analyze() + extraction cache — INCREMENTAL == FULL (INV2)', () => {
  it('cache-less vs (cold then warm) cached runs are byte-identical', async () => {
    // ONE fs instance for all three runs: memoryFS stamps per-file mtimes at
    // construction, so separate instances would differ on lastModifiedMs alone
    // (unrelated to the cache). Reusing it holds the input truly constant.
    const fs = memoryFS({ ...FILES });
    const noCache = await analyze(fs, { root: '.', projectName: 'app', symbols: true });

    const cache = new MemCache();
    const cold = await analyze(fs, { root: '.', projectName: 'app', symbols: true, extractionCache: cache });
    expect(cache.misses).toBeGreaterThan(0); // cold = everything parsed fresh
    expect(cache.hits).toBe(0);

    const warm = await analyze(fs, { root: '.', projectName: 'app', symbols: true, extractionCache: cache });
    expect(cache.hits).toBeGreaterThan(0); // warm = served from cache

    expect(stripVolatile(cold.agent)).toEqual(stripVolatile(noCache.agent));
    expect(stripVolatile(warm.agent)).toEqual(stripVolatile(noCache.agent));
  });

  it('a one-file edit re-parses ~that one file', async () => {
    const cache = new MemCache();
    await analyze(memoryFS({ ...FILES }), { root: '.', projectName: 'app', extractionCache: cache });
    const coldMisses = cache.misses;
    expect(coldMisses).toBeGreaterThan(1);

    // Re-analyze with exactly one code file changed.
    cache.hits = 0;
    cache.misses = 0;
    const edited = await analyze(
      memoryFS({
        ...FILES,
        'src/index.ts': `import { user } from './user';\nexport function main() { return user() + 1; }\n`,
      }),
      { root: '.', projectName: 'app', extractionCache: cache },
    );

    expect(cache.misses).toBe(1); // only the edited file re-parsed
    expect(cache.hits).toBeGreaterThan(0); // the rest served from cache
    expect(edited.agent.files.length).toBeGreaterThan(0);
  });

  it('a --symbols run does not reuse a no-symbols cache entry (refs-mode segregation)', async () => {
    const cache = new MemCache();
    // Prime WITHOUT symbols.
    await analyze(memoryFS({ ...FILES }), { root: '.', projectName: 'app', extractionCache: cache });
    cache.hits = 0;
    cache.misses = 0;
    // Re-run WITH symbols — the keys differ (r1 vs r0), so code files miss again
    // and produce refs (otherwise the symbol graph would be silently empty).
    const withSyms = await analyze(memoryFS({ ...FILES }), { root: '.', projectName: 'app', symbols: true, extractionCache: cache });
    expect(cache.misses).toBeGreaterThan(0);
    expect(withSyms.agent.graph.symbolNodes.length).toBeGreaterThan(0);
  });
});
