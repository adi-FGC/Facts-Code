/**
 * Single data-loading entry point used by every route.
 *
 * Two implementations, picked at runtime:
 *
 *   1. **Static mode** (`pnpm build` + Netlify deploy + `factstack export`):
 *        read the inline <script id="factstack-data"> block. No server.
 *   2. **Server mode** (`pnpm dev` + `factstack ui`):
 *        fetch('/data/factstack.json'). Vite proxies to :4848 in dev.
 *
 * The inline block is the placeholder `__INLINE_FACTSTACK_JSON__` in
 * the template; `scripts/inject-data.mjs` substitutes real JSON at build
 * time. When the placeholder is still present (dev mode without a served
 * artifact) we fall back to fetch.
 *
 * Framework-agnostic — no React, no Remix runtime, just the browser
 * platform. Same module shape as the previous React version.
 */

import type {
  DependencyManifest,
  DocFile,
  GitTopology,
  StyleAudit,
  Vulnerability,
} from '@factstack/spec';

export interface DatasetFile {
  name: string;
  path: string;
  ext: string;
  language: { id: string; label: string; iconColor: string; tag: string } | null;
  size: number;
  gzip: number | null;
  loc: number;
  tokens: number;
  todos: number;
  todoEntries: Array<{ kind: string; line: number; text: string }>;
  status: 'ok' | 'broken' | 'stale' | 'parse_error' | 'read_error';
  mtime: number;
  /** v0.3.8 — pre-computed read-through time in minutes. Undefined
   *  for older artifacts that pre-date the spec change. */
  readingMinutes?: number;
  /** v0.3.8 — top-3 git contributors. Undefined when no git history
   *  was available at analyze time. */
  topContributors?: Array<{ email: string; name: string; commits: number; lastTouchedMs: number }>;
}

export interface DatasetTreeNode {
  name: string;
  path: string;
  files: DatasetFile[];
  children: DatasetTreeNode[];
  rollup?: {
    size: number;
    gzip: number;
    tokens: number;
    files: number;
    loc: number;
    todos: number;
  };
}

export interface Dataset {
  $schema?: string;
  generatedAt: string;
  project: {
    name: string;
    root: string;
    languages: Array<{
      id: string;
      label: string;
      iconColor: string;
      tag: string;
      loc: number;
      tokens: number;
      files: number;
    }>;
    frameworks: string[];
  };
  summary: {
    oneLiner: string;
    description: string;
    capabilities: Array<{ icon: string; head: string; sub: string }>;
    health: {
      broken: number;
      stale: number;
      todos: number;
      secrets: number;
      /** Prose summary — required since the original schema (e.g.
       *  "B · 84 — 2 secrets exposed, 9 import cycles"). */
      headline: string;
      /** v0.3 — composite grade. `score` 0–100, `grade` its letter (A–F),
       *  `factors` the top deductions ({label,count,penalty}). All optional
       *  for backward-compat with pre-v0.3 baked datasets — the Health card
       *  falls back to the flat counts when the grade is absent. */
      score?: number;
      grade?: 'A' | 'B' | 'C' | 'D' | 'F';
      factors?: Array<{ label: string; count: number; penalty: number }>;
    };
  };
  stats: { files: number; loc: number; size: number; gzip: number; tokens: number };
  tree: DatasetTreeNode;
  edges: Array<{ from: string; to: string; kind: 'import' | 'dynamic-import' | 'type-import' }>;
  /** F5 — per-node graph analytics (importance = normalized PageRank 0..1,
   *  community = label-propagation cluster id). One entry per node that carries
   *  metrics. Optional for backward-compat with pre-F5 baked datasets — the
   *  Modules surface renders an empty state when absent. */
  nodeMetrics?: Array<{ path: string; importance?: number; community?: number }>;
  entryPoints: Array<{ label: string; path: string; handlerFile: string; kind: string }>;
  /**
   * Detected routes from per-framework AST extraction. `framework` is
   * the matched framework name (e.g. `remix`, `express`, `node-http`,
   * `fastapi`); `method` is null for non-HTTP routes (Next.js pages,
   * Remix file routes). The Dataset shape is permissive — different
   * framework adapters may attach extra fields beyond these.
   */
  routes?: Array<{
    framework: string;
    method: string | null;
    path: string;
    handlerFile: string;
    handlerSymbol: string | null;
  }>;
  risks: Array<{
    severity: string;
    category: string;
    rule: string;
    file?: string;
    line?: number;
    message: string;
    /** v0.3.8 — original technical message when a CXO rewrite replaced
     *  it. UI hides this behind a <details> disclosure. */
    messageTechnical?: string;
    preview?: string;
  }>;
  history?: Array<{
    at: string;
    loc: number;
    tokens: number;
    files: number;
    risks: number;
    todos: number;
  }>;
  /**
   * v0.3.6 — env-var inventory. Optional for backward-compat with
   * pre-v0.3.6 artifacts; the UI's Config tab renders an empty state
   * when absent. The shape mirrors `@factstack/spec`'s Config schema.
   */
  config?: {
    envVars: Array<{
      name: string;
      reads: Array<{
        file: string;
        line: number;
        access:
          | 'process.env'
          | 'import.meta.env'
          | 'os.getenv'
          | 'os.environ'
          | 'destructure'
          | 'unknown';
        defaultValue: string | null;
      }>;
      defaults: string[];
      primaryAccess:
        | 'process.env'
        | 'import.meta.env'
        | 'os.getenv'
        | 'os.environ'
        | 'destructure'
        | 'unknown'
        | null;
    }>;
    schemas: unknown[];
  };
  /** v0.6 — security tier. Types come straight from @factstack/spec
   *  so the schema is the single source of truth. Optional on the
   *  type for backward-compat with pre-v0.6 inline datasets — older
   *  artifacts that lack these fields entirely should still load. */
  dependencyManifests?: DependencyManifest[];
  vulnerabilities?: Vulnerability[];
  /** v0.11 — metadata of the last `scan-vulns` run; present after a scan even
   *  when the findings list is empty (the "scanned and clean" marker). */
  vulnerabilityScan?: {
    scannedAt: string;
    source: 'osv.dev';
    packagesQueried: number;
    packagesSkipped: number;
    findings: number;
    /** Lockfiles the scan read installed versions from (spec
     *  VulnerabilityScanSchema, optional). Non-empty = the scan covered
     *  transitive packages the browser's weekly re-check cannot. */
    lockfiles?: string[];
    /** Dependencies that changed while OSV.dev was answering, so the scan
     *  never checked them (spec VulnerabilityScanSchema, optional). > 0 means
     *  "no findings" is not a clean answer for every dependency. */
    unscanned?: number;
  };
  /** v0.8 — flagged documentation files with parsed structure + capped raw
   *  content. Optional for backward-compat with pre-v0.8 datasets; the Docs
   *  tab renders an empty state when absent. */
  docs?: DocFile[];
  /** v0.8 — CSS / styling audit of the scanned project. Absent when the
   *  project has no stylesheet sources; the RHS suggestions panel hides. */
  styles?: StyleAudit;
  /** v0.3.11 — worktrees, branches, request records, commit + deploy
   *  readiness. Absent for non-git projects and pre-v0.3.11 datasets; the
   *  Worktrees tab renders an empty state. */
  git?: GitTopology;
  /** performance#5 — a static build may move heavy sections out of the
   *  inline block into same-origin JSON files (`/data/sections/<name>.json`,
   *  written by inject-data.mjs). loadArtifacts fetches every listed section
   *  that is absent inline before the first render, so no view ever sees a
   *  half-loaded dataset. UI-only build metadata, never part of the artifact. */
  sectionUrls?: Partial<Record<DatasetSection, string>>;
}

/** The sections a build may serve outside the inline block. */
export const DATASET_SECTIONS = ['edges', 'nodeMetrics', 'docs', 'tree'] as const;
export type DatasetSection = (typeof DATASET_SECTIONS)[number];

/* Same-origin data files only: a ROOT-relative path under /data/, ending in
   .json, with no `..` segment. A relative `data/…` is refused: on a deep
   link (/docs/a/b) it resolves to /docs/a/data/…, which the SPA fallback
   answers with index.html (UI-R4). */
const SECTION_URL = /^\/data\/(?:[\w-]+\/)*[\w.-]+\.json$/;
const isSectionUrl = (u: unknown): u is string =>
  typeof u === 'string' && SECTION_URL.test(u) && !u.split('/').includes('..');

const RELOAD_HINT = 'the site may have been updated since this page opened; reload.';

/**
 * Fill in every section `data.sectionUrls` lists that is absent inline,
 * fetched in parallel (a `<link rel=preload as=fetch crossorigin>` for each
 * lets the fetch start while the page is still parsing). Mutates `data`;
 * returns the fetched JSON's total length so the baked artifact's size stays
 * exact. A failed section fails the load — a view must never present a
 * missing section as an empty one ("no dependencies", "no docs"). That
 * includes a listed section whose URL is not a `/data/…json` path: it is
 * never fetched, and the load fails naming it.
 */
export async function hydrateSections(
  data: Dataset,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const urls = data.sectionUrls;
  if (!urls || typeof urls !== 'object') return 0;
  const wanted = DATASET_SECTIONS.filter((k) => data[k] === undefined && urls[k] !== undefined);
  const refused = wanted.find((k) => !isSectionUrl(urls[k]));
  if (refused) {
    throw new Error(
      `The dataset's ${refused} section is listed at an unsupported URL (sections load only from /data/…json) — rebuild the site.`,
    );
  }
  const texts = await Promise.all(
    wanted.map(async (k) => {
      const res = await fetchImpl(urls[k]!);
      if (!res.ok) {
        throw new Error(
          `HTTP ${res.status} loading the dataset's ${k} section (${urls[k]}) — ${RELOAD_HINT}`,
        );
      }
      return [k, await res.text()] as const;
    }),
  );
  let chars = 0;
  for (const [k, text] of texts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* A 200 that is not JSON is almost always the SPA fallback's
         index.html for a file a newer deploy renamed. */
      throw new Error(`Could not parse the dataset's ${k} section (${urls[k]}) — ${RELOAD_HINT}`);
    }
    (data as unknown as Record<string, unknown>)[k] = parsed;
    chars += text.length;
  }
  return chars;
}

const INLINE_ID = 'factstack-data';
const INLINE_PLACEHOLDER = '__INLINE_FACTSTACK_JSON__';

/**
 * True when the inline block's text is a baked dataset. Detected by EXACT
 * match against the bare placeholder, never a substring `includes()`: the
 * baked dataset can legitimately *contain* the token — a project doc that
 * documents this bake pipeline does (apps/ui-remix/test/e2e/README.md). The
 * un-baked template's text IS the bare token; anything else is real data.
 * Shared by loadArtifacts and ReanalyzeButton's static-mode check.
 */
export function hasBakedInline(text: string | null | undefined): boolean {
  return !!text && text.trim() !== INLINE_PLACEHOLDER;
}

/* Exact serialized size of a dataset parsed from the inline block, keyed by
   identity. A hot-swapped dataset (⌘O scan, re-analyze) is a different
   object, so it can never inherit the baked page's size. */
const inlineChars = new WeakMap<Dataset, number>();

/**
 * Serialized size (chars) of the artifact a dataset stands for. The baked
 * dataset reports its inline block's length (that block IS the artifact);
 * any other dataset is measured by re-serializing it.
 */
export function artifactCharsOf(data: Dataset): number {
  const baked = inlineChars.get(data);
  if (baked !== undefined) return baked;
  try {
    return JSON.stringify(data).length;
  } catch {
    return 0;
  }
}

export async function loadArtifacts(): Promise<Dataset> {
  // 1. Inline (static deploy / exported single-file HTML)
  //
  // Detect "baked" by EXACT match against the bare placeholder
  // (hasBakedInline). A substring check would mistake a dataset that
  // mentions the token for an un-baked template and fall through to the
  // (404/502) dev fetch, blanking the whole app. The try/catch still covers
  // a genuinely malformed inline blob.
  // script#…, not the bare id: a doc heading can carry the same slug.
  const inline = document.querySelector(`script#${INLINE_ID}`);
  if (inline && inline.textContent && hasBakedInline(inline.textContent)) {
    let data: Dataset | null = null;
    try {
      data = JSON.parse(inline.textContent) as Dataset;
    } catch (err) {
      console.warn('[loadArtifacts] inline JSON parse failed, falling back to fetch', err);
    }
    if (data) {
      /* Sections served beside the page count toward the artifact's size. */
      const sectionChars = await hydrateSections(data);
      inlineChars.set(data, inline.textContent.length + sectionChars);
      return data;
    }
  }
  // 2. Fetch — works when served by `factstack ui`
  const res = await fetch('/data/factstack.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' loading /data/factstack.json');
  const data = (await res.json()) as Dataset;
  await hydrateSections(data);
  return data;
}

/** Triggers a re-analyze on the served CLI. No-op in static mode. */
export async function requestReanalyze(): Promise<Dataset> {
  if (location.protocol === 'file:' || typeof window === 'undefined') {
    throw new Error('re-analyze requires a served CLI (run `factstack ui`).');
  }
  const post = await fetch('/api/reanalyze', { method: 'POST' });
  if (!post.ok) throw new Error('reanalyze failed: HTTP ' + post.status);
  return loadArtifacts();
}
