#!/usr/bin/env node
/**
 * Generate the bundled demo dataset (FactStack analyzing itself) for the
 * extension's zero-setup first run. Reads <repoRoot>/.facts/{agent,human}.json,
 * adapts via the canonical humanToViz() (same as the dashboard bake), folds in
 * snapshot history, strips doc bodies (the panel doesn't render them in v1),
 * and writes apps/chrome-ext/public/demo/factstack.json (copied into dist by
 * Vite). Regenerate with `pnpm --filter @factstack/chrome-ext make-demo`.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(__dirname, '..');
const REPO_ROOT = resolve(APP_DIR, '..', '..');
const OUT_DIR = resolve(APP_DIR, 'public', 'demo');
const OUT = join(OUT_DIR, 'factstack.json');

const agentP = join(REPO_ROOT, '.facts', 'agent.json');
const humanP = join(REPO_ROOT, '.facts', 'human.json');
if (!existsSync(agentP) || !existsSync(humanP)) {
  console.error('[make-demo] .facts/{agent,human}.json not found — run `factstack analyze .` from the repo root first.');
  process.exit(1);
}

const { humanToViz } = await import('@factstack/emit/pure');
const agent = JSON.parse(readFileSync(agentP, 'utf8'));
const human = JSON.parse(readFileSync(humanP, 'utf8'));
const viz = humanToViz(agent, human);

/* Fold in snapshot history so the demo's History route has data. */
const snapDir = join(REPO_ROOT, '.facts', 'snapshots');
if (existsSync(snapDir)) {
  const hist = [];
  for (const name of readdirSync(snapDir).filter((n) => n.endsWith('.json')).sort()) {
    try {
      const b = JSON.parse(readFileSync(join(snapDir, name), 'utf8'));
      hist.push({
        at: b.at,
        loc: b.stats?.loc ?? 0,
        tokens: b.stats?.totalTokenCost ?? 0,
        files: b.stats?.fileCount ?? 0,
        risks: b.risks ?? 0,
        todos: b.todos ?? 0,
      });
    } catch { /* skip malformed */ }
  }
  if (hist.length) viz.history = hist;
}

/* Strip all doc bodies — the panel lists docs but doesn't render bodies in v1;
   this is ~54% of the payload (per the plan's measurement). */
if (Array.isArray(viz.docs)) {
  for (const d of viz.docs) if (d && d.content != null) d.content = null;
}

mkdirSync(OUT_DIR, { recursive: true });
const json = JSON.stringify(viz);
writeFileSync(OUT, json);
console.log(`[make-demo] wrote ${(Buffer.byteLength(json) / 1024).toFixed(1)} KB → ${OUT}`);
console.log(`  project: ${viz.project?.name}  files: ${viz.stats?.files}  risks: ${viz.risks?.length ?? 0}`);
