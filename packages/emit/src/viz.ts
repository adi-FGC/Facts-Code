/**
 * @factstack/emit — canonical HumanArtifact → prototype "viz" shape.
 *
 * The standalone prototype HTML expects a specific JSON shape that mirrors
 * the editorial UI's needs (flat stats block, tree with files[]/children[],
 * language-brand colors inline on nodes, etc.). This module translates the
 * canonical HumanArtifact into that shape so the same CLI can both emit the
 * canonical artifacts AND drive the prototype without a parallel analyzer.
 *
 * Kept deliberately additive: we never mutate the inputs, and the viz
 * artifact lives alongside (not instead of) agent.json + human.json.
 */

import type { AgentArtifact, DependencyManifest, DocFile, HumanArtifact, StyleAudit, Vulnerability } from '@factstack/spec';

export interface VizLanguage {
  id: string;
  label: string;
  iconColor: string;
  tag: string;
  loc: number;
  tokens: number;
  files: number;
}

export interface VizFile {
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
  /** v0.3.8 — read-through time estimate; absent when analyzer didn't compute it. */
  readingMinutes?: number;
  /** v0.3.8 — top-3 git contributors; absent when no git history available. */
  topContributors?: Array<{ email: string; name: string; commits: number; lastTouchedMs: number }>;
}

export interface VizTreeNode {
  name: string;
  path: string;
  files: VizFile[];
  children: VizTreeNode[];
  rollup?: { size: number; gzip: number; tokens: number; files: number; loc: number; todos: number };
}

export interface VizSnapshot {
  at: string;
  loc: number;
  tokens: number;
  files: number;
  risks: number;
  todos: number;
}

export interface VizArtifact {
  $schema: 'https://factstack.dev/schema/prototype.v1.json';
  generatedAt: string;
  project: {
    name: string;
    root: string;
    languages: VizLanguage[];
    frameworks: string[];
  };
  summary: {
    oneLiner: string;
    description: string;
    capabilities: Array<{ icon: string; head: string; sub: string }>;
    /** Full composite health (v0.3): flat counts + headline + grade/score/
     *  factors. Mirrors the spec so the in-browser FSA-scan Overview shows the
     *  same grade as the CLI-baked dashboard (INV7 browser parity). */
    health: HumanArtifact['summary']['health'];
  };
  stats: { files: number; loc: number; size: number; gzip: number; tokens: number };
  tree: VizTreeNode;
  edges: Array<{ from: string; to: string; kind: 'import' | 'dynamic-import' | 'type-import' }>;
  /** F5 — per-node graph analytics: `importance` (normalized PageRank, 0..1)
   *  and `community` (label-propagation cluster id). One entry per node that
   *  carries metrics; empty on pre-F5 artifacts. Drives the Modules surface,
   *  importance-ranked key files, and community node coloring. */
  nodeMetrics: Array<{ path: string; importance?: number; community?: number }>;
  entryPoints: Array<{ label: string; path: string; handlerFile: string; kind: string }>;
  /**
   * Detected URL routes — frontend pages + API endpoints.
   *
   * Populated from `agent.routes`. The Routes tab renders these as
   * "Pages & API" (URLs a user can bookmark or an AI agent can call),
   * separate from `entryPoints` (CLI commands like `npm run dev`).
   *
   * Empty array (not absent) when no routes were detected, so the UI
   * can render the empty state without an `if (routes)` guard.
   */
  routes: Array<{ framework: string; method: string | null; path: string; handlerFile: string; handlerSymbol: string | null }>;
  risks: Array<{
    severity: string;
    category: string;
    rule: string;
    file?: string;
    line?: number;
    message: string;
    /** v0.3.8 — original technical message before the CXO rewrite, when present. */
    messageTechnical?: string;
    preview?: string;
  }>;
  /** Populated by `factstack ui`/`factstack export` from .facts/snapshots/. */
  history?: VizSnapshot[];
  /** Strongly-connected components in the import graph — one array per cycle,
   *  listing the files that form the loop. Empty when no cycles. Carried
   *  through so the UI can mark back-edges and surface the cycle list. */
  cycles: string[][];
  /** v0.3.6 — env-var inventory. Optional for backward-compat with
   *  artifacts that pre-date the env-var extractor. */
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
        | 'process.env' | 'import.meta.env' | 'os.getenv' | 'os.environ' | 'destructure' | 'unknown' | null;
    }>;
    schemas: unknown[];
  };
  /** v0.6 — security tier passthrough. Both are always present
   *  (empty array when no manifests detected / scan-vulns not run).
   *  Types come straight from @factstack/spec so the schema is the
   *  single source of truth — no shape drift between artifact and viz. */
  dependencyManifests: DependencyManifest[];
  vulnerabilities: Vulnerability[];
  /** v0.8 — flagged documentation files with parsed structure + capped raw
   *  content. Always present (empty array when no docs were detected). */
  docs: DocFile[];
  /** v0.8 — CSS / styling audit of the scanned project. Absent when the
   *  project has no stylesheet sources. */
  styles?: StyleAudit;
}

/** Language-brand colors mirror the ones used by the prototype scan.mjs. */
const LANG_COLORS: Record<string, string> = {
  typescript: '#3178c6',
  javascript: '#f7df1e',
  python:     '#3776ab',
  json:       '#cbd5e1',
  yaml:       '#cb171e',
  toml:       '#9c4221',
  markdown:   '#60a5fa',
  html:       '#e34f26',
  css:        '#1572b6',
  scss:       '#c6538c',
  svg:        '#ffb13b',
  go:         '#00add8',
  rust:       '#dea584',
  java:       '#b07219',
  kotlin:     '#a97bff',
  swift:      '#f05138',
  csharp:     '#178600',
  php:        '#4f5d95',
  ruby:       '#701516',
};

const LANG_TAGS: Record<string, string> = {
  typescript: 'TS', javascript: 'JS', python: 'PY', json: 'JSON', yaml: 'YAML',
  toml: 'TOML', markdown: 'MD', html: 'HTML', css: 'CSS', scss: 'SCSS',
  svg: 'SVG', go: 'GO', rust: 'RS', java: 'JAVA', kotlin: 'KT', swift: 'SWIFT',
  csharp: 'CS', php: 'PHP', ruby: 'RB', other: '?',
};

const LANG_LABELS: Record<string, string> = {
  typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python',
  json: 'JSON', yaml: 'YAML', toml: 'TOML', markdown: 'Markdown',
  html: 'HTML', css: 'CSS', scss: 'SCSS', svg: 'SVG', go: 'Go',
  rust: 'Rust', java: 'Java', kotlin: 'Kotlin', swift: 'Swift',
  csharp: 'C#', php: 'PHP', ruby: 'Ruby', other: 'Other',
};

function langInfo(id: string | null): VizFile['language'] {
  if (!id || id === 'other') return null;
  return {
    id,
    label: LANG_LABELS[id] ?? id,
    iconColor: LANG_COLORS[id] ?? '#94a3b8',
    tag: LANG_TAGS[id] ?? id.slice(0, 4).toUpperCase(),
  };
}

/** Transform canonical artifacts into the prototype's viz shape. */
export function humanToViz(agent: AgentArtifact, human: HumanArtifact): VizArtifact {
  // ── project ────────────────────────────────────────────────────────────
  const langStats = new Map<string, VizLanguage>();
  for (const f of agent.files) {
    if (!f.language || f.language === 'other') continue;
    const id = f.language;
    const cur = langStats.get(id) ?? {
      id,
      label: LANG_LABELS[id] ?? id,
      iconColor: LANG_COLORS[id] ?? '#94a3b8',
      tag: LANG_TAGS[id] ?? id.slice(0, 4).toUpperCase(),
      loc: 0,
      tokens: 0,
      files: 0,
    };
    cur.loc += f.loc;
    cur.tokens += f.tokenCost;
    cur.files += 1;
    langStats.set(id, cur);
  }
  const languages = [...langStats.values()].sort((a, b) => b.loc - a.loc);

  // ── tree ───────────────────────────────────────────────────────────────
  // Canonical tree is recursive {kind, children}; prototype wants
  // {name, files[], children[], rollup}. Split kids into dirs vs files.
  const fileMetaByPath = new Map<string, AgentArtifact['files'][number]>();
  for (const f of agent.files) fileMetaByPath.set(f.path, f);

  const todosByPath = new Map<string, Array<{ kind: string; line: number; text: string }>>();
  for (const f of agent.files) {
    if (f.todos?.length) {
      todosByPath.set(
        f.path,
        f.todos.map((t) => ({ kind: t.kind, line: t.line, text: t.text })),
      );
    }
  }

  const tree = toVizTree(human.tree, fileMetaByPath, todosByPath);

  // Rollup (post-order) — the prototype reads `rollup` on every directory.
  (function roll(n: VizTreeNode): { size: number; gzip: number; tokens: number; files: number; loc: number; todos: number } {
    let size = 0, gzip = 0, tokens = 0, files = 0, loc = 0, todos = 0;
    for (const f of n.files) {
      size += f.size; gzip += f.gzip ?? 0; tokens += f.tokens; files++;
      loc += f.loc; todos += f.todos;
    }
    for (const c of n.children) {
      const r = roll(c);
      size += r.size; gzip += r.gzip; tokens += r.tokens;
      files += r.files; loc += r.loc; todos += r.todos;
      c.rollup = r;
    }
    return { size, gzip, tokens, files, loc, todos };
  })(tree);

  // ── summary capabilities → editorial chip shape ───────────────────────
  const capabilities = human.summary.capabilities.map((c) => {
    const [head, ...subParts] = c.split(' — ');
    return { icon: '✓', head: head ?? c, sub: subParts.join(' — ') || '' };
  });

  // ── entry points → prototype shape ────────────────────────────────────
  const entryPoints = human.summary.entryPoints.map((ep) => ({
    label: ep.label,
    path: ep.path,
    handlerFile: ep.handlerFile,
    kind: mapEntryKind(ep.kind),
  }));

  // ── stats ──────────────────────────────────────────────────────────────
  const totalGzip = agent.files.reduce((s, f) => s + (f.bundleSize?.gzipped ?? 0), 0);
  const totalBytes = agent.files.reduce((s, f) => s + f.bytes, 0);

  return {
    $schema: 'https://factstack.dev/schema/prototype.v1.json',
    generatedAt: human.generatedAt,
    project: {
      name: agent.project.name,
      root: agent.project.root,
      languages,
      frameworks: agent.project.frameworks,
    },
    summary: {
      oneLiner: human.summary.oneLiner,
      // `description` is the longer-form supporting paragraph (the "dek"
      // in editorial layout). When `intent` is empty it would previously
      // fall back to `oneLiner`, causing the headline + dek to render the
      // exact same sentence twice. Leave it empty so the dek is just
      // hidden in the Overview render.
      description: human.summary.intent || '',
      capabilities,
      // Carry the whole health object — headline + grade/score/factors
      // included — so the browser-scan dashboard grades identically (INV7).
      health: { ...human.summary.health },
    },
    stats: {
      files: agent.stats.fileCount,
      loc: agent.stats.loc,
      size: totalBytes,
      gzip: totalGzip,
      tokens: agent.stats.totalTokenCost,
    },
    tree,
    edges: human.graph.edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind })),
    cycles: human.graph.cycles ?? [],
    // F5 — surface graph analytics per node (importance + community). Only
    // nodes that carry metrics are emitted, conditional-spread for
    // exactOptionalPropertyTypes.
    nodeMetrics: agent.graph.nodes
      .filter((n) => n.importance !== undefined || n.community !== undefined)
      .map((n) => ({
        path: n.path,
        ...(n.importance !== undefined ? { importance: n.importance } : {}),
        ...(n.community !== undefined ? { community: n.community } : {}),
      })),
    entryPoints,
    routes: agent.routes.map((r) => ({
      framework: r.framework,
      method: r.method,
      path: r.path,
      handlerFile: r.handlerFile,
      handlerSymbol: r.handlerSymbol,
    })),
    risks: human.risks.map((r) => ({
      severity: r.severity,
      category: r.category,
      rule: r.rule,
      ...(r.file ? { file: r.file } : {}),
      ...(r.line ? { line: r.line } : {}),
      message: r.message,
      /* v0.3.8 — pass through messageTechnical when present so the
         dashboard's <details> disclosure can render the original
         rule-text underneath the CXO-readable summary. */
      ...(r.messageTechnical ? { messageTechnical: r.messageTechnical } : {}),
      ...(r.preview ? { preview: r.preview } : {}),
    })),
    /* v0.3.6 — env-var inventory, when the analyzer produced one. */
    ...(agent.config ? { config: agent.config } : {}),
    /* v0.6 — security tier passthrough. Both default to [] in the
       schema so they're always present on agent. Empty-array is
       meaningful (the analyzer ran but found nothing) so we always
       emit — the UI renders "no manifests detected" or "no known
       vulns" rather than treating absence as "scan didn't run." */
    dependencyManifests: agent.dependencyManifests,
    vulnerabilities: agent.vulnerabilities,
    docs: agent.docs ?? [],
    ...(agent.styles ? { styles: agent.styles } : {}),
  };
}

function toVizTree(
  node: HumanArtifact['tree'],
  fileMeta: Map<string, AgentArtifact['files'][number]>,
  todosByPath: Map<string, Array<{ kind: string; line: number; text: string }>>,
): VizTreeNode {
  if (node.kind !== 'directory') {
    // Shouldn't happen at the root, but handle defensively.
    return { name: node.name, path: node.path, files: [], children: [] };
  }
  const viz: VizTreeNode = {
    name: node.name,
    path: node.path,
    files: [],
    children: [],
  };
  for (const child of node.children ?? []) {
    if (child.kind === 'directory') {
      viz.children.push(toVizTree(child, fileMeta, todosByPath));
    } else {
      const meta = fileMeta.get(child.path);
      const ext = meta ? extOf(meta.path) : extOf(child.path);
      viz.files.push({
        name: child.name,
        path: child.path,
        ext,
        language: langInfo(child.language),
        size: meta?.bytes ?? 0,
        gzip: meta?.bundleSize?.gzipped ?? child.bundleSizeGzip ?? null,
        loc: child.loc,
        tokens: child.tokenCost,
        todos: todosByPath.get(child.path)?.length ?? 0,
        todoEntries: todosByPath.get(child.path) ?? [],
        status: (child.status === 'parse_error' ? 'parse_error' : child.status) as VizFile['status'],
        mtime: meta?.lastModifiedMs ?? 0,
        /* v0.3.8 — pass through reading time + top contributors when
           the analyzer produced them. The Files detail view + the
           tree-row tooltip both consume these fields. */
        ...(typeof meta?.readingMinutes === 'number' ? { readingMinutes: meta.readingMinutes } : {}),
        ...(meta?.topContributors && meta.topContributors.length > 0 ? { topContributors: meta.topContributors } : {}),
      });
    }
  }
  // Prototype convention: directories first alpha, then files alpha.
  viz.children.sort((a, b) => a.name.localeCompare(b.name));
  viz.files.sort((a, b) => a.name.localeCompare(b.name));
  return viz;
}

function extOf(p: string): string {
  const dot = p.lastIndexOf('.');
  const slash = p.lastIndexOf('/');
  return dot > slash ? p.slice(dot).toLowerCase() : '';
}

function mapEntryKind(kind: string): string {
  // Prototype expects "cli" / "ui" / "http" rather than the canonical values.
  if (kind === 'cli-command') return 'cli';
  if (kind === 'page' || kind === 'screen') return 'ui';
  if (kind === 'http-route') return 'http';
  return 'other';
}
