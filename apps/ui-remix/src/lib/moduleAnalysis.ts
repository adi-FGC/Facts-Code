/**
 * F5 module-view derivation — turns the analyzer's per-node metrics
 * (`data.nodeMetrics`: importance + community, computed deterministically in
 * @factstack/graph) into the two shapes the Modules tab renders:
 *
 *   - `keyFiles`: every file ranked by importance (normalized PageRank). The
 *     "read these first" list, but graph-weighted, not raw in-degree.
 *   - `modules`:  files grouped by community (label propagation), each named by
 *     its most important member. The "what clusters together" lens.
 *
 * This is pure aggregation — it does NOT recompute PageRank/communities in the
 * browser. The metrics come from the core (one deterministic computation feeds
 * both the agent and this dashboard), so the UI and the agent never disagree.
 */

import type { Dataset, DatasetFile, DatasetTreeNode } from './loadArtifacts.ts';

export interface KeyFile {
  path: string;
  name: string;
  dir: string;
  importance: number; // 0..1 (normalized PageRank; top file = 1.0)
  inDegree: number;
  tokens: number;
  language: string | null;
  community: number | undefined;
}

export interface ModuleGroup {
  id: number;
  /** Full path of the most-important member — the module's identity. */
  name: string;
  shortName: string;
  memberCount: number;
  totalTokens: number;
  peakImportance: number;
  /** Members sorted by importance desc. */
  members: KeyFile[];
}

export interface ModuleView {
  hasMetrics: boolean;
  keyFiles: KeyFile[];
  modules: ModuleGroup[];
}

export const KEY_FILES_LIMIT = 25;

function splitPath(p: string): { dir: string; name: string } {
  const i = p.lastIndexOf('/');
  return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i), name: p.slice(i + 1) };
}

export function buildModuleView(data: Dataset): ModuleView {
  const metrics = data.nodeMetrics ?? [];
  if (metrics.length === 0) return { hasMetrics: false, keyFiles: [], modules: [] };

  // path → file metadata (tokens, language) from the flattened tree.
  const fileByPath = new Map<string, DatasetFile>();
  const walk = (n: DatasetTreeNode): void => {
    for (const f of n.files) fileByPath.set(f.path, f);
    for (const c of n.children) walk(c);
  };
  walk(data.tree);

  // in-degree from the file import graph (a secondary signal next to importance).
  const inDeg = new Map<string, number>();
  for (const e of data.edges) inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);

  const all: KeyFile[] = metrics.map((m) => {
    const f = fileByPath.get(m.path);
    const { dir, name } = splitPath(m.path);
    return {
      path: m.path,
      name,
      dir,
      importance: m.importance ?? 0,
      inDegree: inDeg.get(m.path) ?? 0,
      tokens: f?.tokens ?? 0,
      language: f?.language?.label ?? null,
      community: m.community,
    };
  });

  const byImportance = (a: KeyFile, b: KeyFile): number =>
    b.importance - a.importance || b.inDegree - a.inDegree || a.path.localeCompare(b.path);

  const keyFiles = [...all].sort(byImportance).slice(0, KEY_FILES_LIMIT);

  // Group by community; a real module has ≥2 files (singletons aren't modules).
  const byCommunity = new Map<number, KeyFile[]>();
  for (const kf of all) {
    if (kf.community === undefined) continue;
    const arr = byCommunity.get(kf.community);
    if (arr) arr.push(kf);
    else byCommunity.set(kf.community, [kf]);
  }

  const modules: ModuleGroup[] = [...byCommunity.entries()]
    .filter(([, members]) => members.length >= 2)
    .map(([id, members]) => {
      const sorted = [...members].sort(byImportance);
      const top = sorted[0]!;
      return {
        id,
        name: top.path,
        shortName: top.name,
        memberCount: members.length,
        totalTokens: members.reduce((s, m) => s + m.tokens, 0),
        peakImportance: top.importance,
        members: sorted,
      };
    })
    .sort((a, b) => b.memberCount - a.memberCount || a.name.localeCompare(b.name));

  return { hasMetrics: true, keyFiles, modules };
}
