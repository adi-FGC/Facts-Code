#!/usr/bin/env node
/**
 * Carry the LIVE site's History forward before a production build.
 *
 * The History tab plots .facts/snapshots, which is local state (gitignored).
 * A deploy from a checkout that lacks the older snapshots — a fresh CI runner,
 * a new worktree — would publish a one-point History and wipe the live series.
 * This fetches the live /data/factstack.json and writes each missing point back
 * as a snapshot file (named and shaped like the ones `factstack analyze`
 * writes), so the bake re-emits the whole series plus today's point.
 * Points already present locally (same `at`) are left alone.
 *
 * Also reports the commit the live site was built from (the current checkout's
 * head in its git topology), for the weekly data-only refresh
 * (.github/workflows/cve-refresh.yml), which rebuilds THAT commit.
 *
 * Fails (exit 1) when the live dataset cannot be read or carries no History —
 * publishing anyway would reset the tab. FACTS_ALLOW_HISTORY_RESET=1 accepts
 * the reset (first deploy, or a deliberate restart).
 *
 * Run it AFTER `factstack analyze`: analyze keeps only the newest 50
 * snapshots, so points carried before it would be pruned, oldest first, and
 * the live dataset is the only copy of them. `--report-only` reads and checks
 * the live dataset and reports, but writes no snapshot (the weekly refresh
 * needs the live commit before it can check out and analyze).
 *
 * Usage:
 *   node scripts/carry-history.mjs [--from <url|file>] [--root <checkout>] [--report-only]
 * On GitHub Actions it appends `live_commit=<sha>` and `points=<n>` (the live
 * point count, for `deploy-check.mjs post --min-history`) to $GITHUB_OUTPUT.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';

export const LIVE_DATASET_URL = 'https://factstack.pages.dev/data/factstack.json';

/** The History points a live dataset carries (malformed entries dropped). */
export function historyPoints(live) {
  return Array.isArray(live?.history)
    ? live.history.filter((p) => p && typeof p.at === 'string' && !Number.isNaN(Date.parse(p.at)))
    : [];
}

/** The full sha the live site was built from, or null when the bake does not say. */
export function liveCommit(live) {
  const wts = live?.git?.worktrees;
  const head = Array.isArray(wts) ? wts.find((w) => w && w.isCurrent)?.head : null;
  return typeof head === 'string' && /^[0-9a-f]{40}$/.test(head) ? head : null;
}

/** Snapshot file name for a point — the same stamp `factstack analyze` uses. */
export const snapshotName = (at) => `${at.replace(/[:.]/g, '-')}.json`;

/**
 * Write every live point not already in `snapDir` as a snapshot file.
 * Returns `{ written, present }` counts.
 */
export function carryHistory(live, snapDir) {
  mkdirSync(snapDir, { recursive: true });
  const have = new Set();
  for (const name of readdirSync(snapDir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const at = JSON.parse(readFileSync(join(snapDir, name), 'utf8'))?.at;
      if (typeof at === 'string') have.add(at);
    } catch {
      /* a malformed local snapshot is the bake's problem, not ours */
    }
  }
  let written = 0;
  let present = 0;
  for (const p of historyPoints(live)) {
    if (have.has(p.at) || existsSync(join(snapDir, snapshotName(p.at)))) {
      present++;
      continue;
    }
    writeFileSync(
      join(snapDir, snapshotName(p.at)),
      JSON.stringify({
        at: p.at,
        stats: { loc: p.loc ?? 0, fileCount: p.files ?? 0, totalTokenCost: p.tokens ?? 0 },
        risks: p.risks ?? 0,
        todos: p.todos ?? 0,
      }),
    );
    have.add(p.at);
    written++;
  }
  return { written, present };
}

async function readLive(from) {
  if (/^https?:\/\//.test(from)) {
    const res = await fetch(from, { cache: 'no-store', signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`GET ${from} → ${res.status}`);
    return res.json();
  }
  return JSON.parse(readFileSync(from, 'utf8'));
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(arg('--root', resolve(here, '../../..')));
  const from = arg('--from', LIVE_DATASET_URL);
  const allowReset = process.env.FACTS_ALLOW_HISTORY_RESET === '1';
  const stop = (msg) => {
    if (allowReset) {
      console.warn(
        `[carry-history] ${msg} — FACTS_ALLOW_HISTORY_RESET=1, continuing with local History only.`,
      );
      process.exit(0);
    }
    console.error(
      `[carry-history] ${msg}.\n  Publishing now would reset the live History tab. ` +
        'Set FACTS_ALLOW_HISTORY_RESET=1 to accept that.',
    );
    process.exit(1);
  };
  let live;
  try {
    live = await readLive(from);
  } catch (e) {
    return stop(`could not read the live dataset (${e?.message || e})`);
  }
  /* Distinct points: the bake holds one snapshot per `at`. */
  const points = new Set(historyPoints(live).map((p) => p.at)).size;
  if (points === 0) return stop('the live dataset carries no History');
  const commit = liveCommit(live);
  if (process.argv.includes('--report-only')) {
    console.log(
      `[carry-history] live History has ${points} point(s) (not written: --report-only); ` +
        `live build commit ${commit ?? 'unknown'}.`,
    );
  } else {
    const { written, present } = carryHistory(live, join(root, '.facts', 'snapshots'));
    console.log(
      `[carry-history] ${written} live History point(s) carried forward, ${present} already present; ` +
        `live build commit ${commit ?? 'unknown'}.`,
    );
  }
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `live_commit=${commit ?? ''}\npoints=${points}\n`);
}

/* Run only as a script, not when imported by the test suite. */
if (isMain(import.meta.url)) await main();
