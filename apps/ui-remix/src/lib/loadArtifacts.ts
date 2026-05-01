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
  status: 'ok' | 'broken' | 'stale' | 'parse_error';
  mtime: number;
}

export interface DatasetTreeNode {
  name: string;
  path: string;
  files: DatasetFile[];
  children: DatasetTreeNode[];
  rollup?: { size: number; gzip: number; tokens: number; files: number; loc: number; todos: number };
}

export interface Dataset {
  $schema?: string;
  generatedAt: string;
  project: {
    name: string;
    root: string;
    languages: Array<{ id: string; label: string; iconColor: string; tag: string; loc: number; tokens: number; files: number }>;
    frameworks: string[];
  };
  summary: {
    oneLiner: string;
    description: string;
    capabilities: Array<{ icon: string; head: string; sub: string }>;
    health: { broken: number; stale: number; todos: number; secrets: number };
  };
  stats: { files: number; loc: number; size: number; gzip: number; tokens: number };
  tree: DatasetTreeNode;
  edges: Array<{ from: string; to: string; kind: 'import' | 'dynamic-import' | 'type-import' }>;
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
  risks: Array<{ severity: string; category: string; rule: string; file?: string; line?: number; message: string; preview?: string }>;
  history?: Array<{ at: string; loc: number; tokens: number; files: number; risks: number; todos: number }>;
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
        access: 'process.env' | 'import.meta.env' | 'os.getenv' | 'os.environ' | 'destructure' | 'unknown';
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
}

const INLINE_ID = 'factstack-data';
const INLINE_PLACEHOLDER = '__INLINE_FACTSTACK_JSON__';

export async function loadArtifacts(): Promise<Dataset> {
  // 1. Inline (static deploy / exported single-file HTML)
  const inline = document.getElementById(INLINE_ID);
  if (inline && inline.textContent && !inline.textContent.includes(INLINE_PLACEHOLDER)) {
    try {
      return JSON.parse(inline.textContent) as Dataset;
    } catch (err) {
      console.warn('[loadArtifacts] inline JSON parse failed, falling back to fetch', err);
    }
  }
  // 2. Fetch — works when served by `factstack ui`
  const res = await fetch('/data/factstack.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' loading /data/factstack.json');
  return (await res.json()) as Dataset;
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
