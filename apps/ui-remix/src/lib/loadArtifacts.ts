/**
 * Single data-loading entry point used by every route.
 *
 * Two implementations, picked at runtime:
 *
 *   1. **Server mode** (`pnpm dev` + `factstack ui`):
 *        fetch('/data/factstack.json'). Vite proxies to :4848 in dev.
 *   2. **Static mode** (`pnpm build:static` + `factstack export`):
 *        read the inline <script id="factstack-data"> block. No server.
 *
 * The inline block is left as the literal placeholder
 * `__INLINE_FACTSTACK_JSON__` in the template; `factstack export` / `ui`
 * replace it with real JSON at emit time. When the placeholder is still
 * present (dev mode without a served artifact) we fall back to fetch.
 */

// Shape locally declared — @factstack/emit is server-only (node:fs).
// If the canonical shape drifts, keep it in lockstep here.
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
  risks: Array<{ severity: string; category: string; rule: string; file?: string; line?: number; message: string; preview?: string }>;
  history?: Array<{ at: string; loc: number; tokens: number; files: number; risks: number; todos: number }>;
}

const INLINE_ID = 'factstack-data';
const INLINE_PLACEHOLDER = '__INLINE_FACTSTACK_JSON__';

export async function loadArtifacts(): Promise<Dataset> {
  // 1. Inline (static mode / exported single-file HTML)
  const inline = document.getElementById(INLINE_ID);
  if (inline && inline.textContent && !inline.textContent.includes(INLINE_PLACEHOLDER)) {
    try {
      return JSON.parse(inline.textContent) as Dataset;
    } catch (err) {
      console.warn('[loadArtifacts] inline JSON parse failed, falling back to fetch', err);
    }
  }
  // 2. Fetch — works against `factstack ui` (port 4848 in dev via Vite proxy)
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
