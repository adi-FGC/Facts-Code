/**
 * docsModel — pure transforms over `Dataset.docs` that feed the Docs tab's
 * inferred views (Todos, Roadmap, Diagrams, Features). No DOM, no rendering:
 * each function maps the analyzer's parsed doc structure into a view model so
 * the components stay thin.
 */
import type { DocFile, DocDiagram, DocTodo } from '@factstack/spec';
import type { Dataset } from './loadArtifacts.ts';

export function getDocs(data: Dataset): DocFile[] {
  return data.docs ?? [];
}

/** Top-level directory of a path ('docs/x/y.md' → 'docs'), '·' for root. */
export function topDir(path: string): string {
  const i = path.indexOf('/');
  return i === -1 ? '·' : path.slice(0, i);
}

export interface DocGroup {
  dir: string;
  docs: DocFile[];
}

/** Group docs by top-level directory, dirs alpha (root '·' last), docs by name. */
export function groupDocs(docs: DocFile[]): DocGroup[] {
  const by = new Map<string, DocFile[]>();
  for (const d of docs) {
    const k = topDir(d.path);
    const arr = by.get(k) ?? [];
    arr.push(d);
    by.set(k, arr);
  }
  const groups: DocGroup[] = [...by.entries()].map(([dir, ds]) => ({
    dir,
    docs: ds.slice().sort((a, b) => a.path.localeCompare(b.path)),
  }));
  groups.sort((a, b) => (a.dir === '·' ? 1 : b.dir === '·' ? -1 : a.dir.localeCompare(b.dir)));
  return groups;
}

/* ─────────── Todos ─────────── */

export interface DocTodoRow extends DocTodo {
  docPath: string;
  docTitle: string;
}
export interface DocTodoBucket {
  docPath: string;
  docTitle: string;
  items: DocTodo[];
  checkboxes: number;
  done: number;
  markers: number;
}
export interface TodoSummary {
  buckets: DocTodoBucket[];
  totalCheckboxes: number;
  totalDone: number;
  totalMarkers: number;
}

export function summarizeTodos(docs: DocFile[]): TodoSummary {
  const buckets: DocTodoBucket[] = [];
  let totalCheckboxes = 0, totalDone = 0, totalMarkers = 0;
  for (const d of docs) {
    if (!d.todos.length) continue;
    let checkboxes = 0, done = 0, markers = 0;
    for (const t of d.todos) {
      if (t.done === null) markers++;
      else { checkboxes++; if (t.done) done++; }
    }
    totalCheckboxes += checkboxes; totalDone += done; totalMarkers += markers;
    buckets.push({ docPath: d.path, docTitle: d.title || d.name, items: d.todos, checkboxes, done, markers });
  }
  // Most actionable first: open checkboxes, then markers, then completed.
  buckets.sort((a, b) => (b.checkboxes - b.done + b.markers) - (a.checkboxes - a.done + a.markers));
  return { buckets, totalCheckboxes, totalDone, totalMarkers };
}

/* ─────────── Roadmaps ─────────── */

export interface RoadmapItem {
  text: string;
  done: boolean;
  line: number;
}
export interface RoadmapSection {
  title: string;
  items: RoadmapItem[];
  done: number;
  total: number;
}
export interface Roadmap {
  docPath: string;
  docTitle: string;
  sections: RoadmapSection[];
  done: number;
  total: number;
}

/**
 * A roadmap is any doc that carries checkbox tasks — explicit ROADMAP docs
 * first, then anything with a checklist. Tasks are grouped by their nearest
 * heading (`section`) so the UI can render collapsible, verifiable sections
 * with per-section progress.
 */
export function detectRoadmaps(docs: DocFile[]): Roadmap[] {
  const roadmaps: Roadmap[] = [];
  for (const d of docs) {
    const checks = d.todos.filter((t) => t.done !== null);
    if (checks.length === 0) continue;
    const isRoadmapish = d.kind === 'roadmap' || /roadmap|plan|milestone|phase|backlog/i.test(d.title) || checks.length >= 3;
    if (!isRoadmapish) continue;

    const order: string[] = [];
    const groups = new Map<string, RoadmapItem[]>();
    for (const t of checks) {
      const key = t.section ?? '';
      if (!groups.has(key)) { groups.set(key, []); order.push(key); }
      groups.get(key)!.push({ text: t.text, done: t.done === true, line: t.line });
    }
    const sections: RoadmapSection[] = order.map((title) => {
      const items = groups.get(title) ?? [];
      return { title: title || '(top level)', items, done: items.filter((x) => x.done).length, total: items.length };
    });
    const done = sections.reduce((s, x) => s + x.done, 0);
    const total = sections.reduce((s, x) => s + x.total, 0);
    roadmaps.push({ docPath: d.path, docTitle: d.title || d.name, sections, done, total });
  }
  // Furthest-from-done first so the work that needs attention leads.
  roadmaps.sort((a, b) => (b.total - b.done) - (a.total - a.done));
  return roadmaps;
}

/* ─────────── Diagrams ─────────── */

export interface DiagramRow extends DocDiagram {
  docPath: string;
  docTitle: string;
}

export function collectDiagrams(docs: DocFile[]): DiagramRow[] {
  const out: DiagramRow[] = [];
  for (const d of docs) {
    for (const g of d.diagrams) out.push({ ...g, docPath: d.path, docTitle: d.title || d.name });
  }
  return out;
}

/** Human label for a mermaid subtype (and a synthetic 'er' bucket key). */
export function diagramTypeLabel(row: DiagramRow): string {
  if (row.kind !== 'mermaid' || !row.type) return row.kind;
  const t = row.type.toLowerCase();
  if (t.startsWith('flowchart') || t === 'graph') return 'flowchart';
  if (t.startsWith('sequence')) return 'sequence';
  if (t.startsWith('er')) return 'entity-relationship';
  if (t.startsWith('class')) return 'class';
  if (t.startsWith('state')) return 'state';
  if (t === 'gantt') return 'gantt';
  return row.type;
}

/* ─────────── Features ─────────── */

export interface DocFeature {
  docPath: string;
  docTitle: string;
  text: string;
  line: number;
}
export interface FeatureModel {
  /** Capabilities the analyzer inferred from the code itself. */
  fromAnalyzer: Array<{ head: string; sub: string }>;
  /** Feature names lifted from doc sections titled "Features"/"Capabilities". */
  fromDocs: DocFeature[];
}

const FEATURE_HEADING = /\b(features?|capabilit(?:y|ies)|what (?:it|we) (?:can )?do|surfaces?)\b/i;

export function extractFeatures(data: Dataset): FeatureModel {
  const fromAnalyzer = (data.summary?.capabilities ?? []).map((c) => ({ head: c.head, sub: c.sub }));
  const fromDocs: DocFeature[] = [];
  for (const d of getDocs(data)) {
    const hs = d.headings;
    for (let i = 0; i < hs.length; i++) {
      const h = hs[i];
      if (!h || !FEATURE_HEADING.test(h.text)) continue;
      // Child headings = the ones deeper than this, until a heading of
      // equal/shallower depth closes the section.
      for (let j = i + 1; j < hs.length; j++) {
        const c = hs[j];
        if (!c || c.depth <= h.depth) break;
        if (c.depth === h.depth + 1) {
          fromDocs.push({ docPath: d.path, docTitle: d.title || d.name, text: c.text, line: c.line });
        }
      }
    }
  }
  return { fromAnalyzer, fromDocs };
}
