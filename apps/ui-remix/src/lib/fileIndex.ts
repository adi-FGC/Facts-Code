import type { Dataset, DatasetFile, DatasetTreeNode } from './loadArtifacts.ts';

/**
 * Flatten the dataset's tree to a `path → file` map. Every consumer that
 * needs a file record by path (graph double-click, file route, imports
 * list) goes through this instead of re-walking the tree.
 */
export function buildFileIndex(data: Dataset): Map<string, DatasetFile> {
  const map = new Map<string, DatasetFile>();
  (function walk(node: DatasetTreeNode) {
    for (const f of node.files ?? []) map.set(f.path, f);
    for (const c of node.children ?? []) walk(c);
  })(data.tree);
  return map;
}
