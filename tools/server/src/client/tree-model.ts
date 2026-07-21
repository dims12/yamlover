// Pure TreeNode-shape helpers shared by the TOC owners: App's live tree (lazy loads, SSE
// merges) and the breadcrumb's query-filter tree. No React, no fetching — just tree surgery.

import { TreeNode } from "./api";

/** Return a copy of `tree` with the children of the node at `path` replaced. */
export function replaceChildren(tree: TreeNode, path: string, children: TreeNode[]): TreeNode {
  if (tree.path === path) return { ...tree, children };
  if (!tree.children.length) return tree;
  return { ...tree, children: tree.children.map((c) => replaceChildren(c, path, children)) };
}

/** Merge a freshly fetched branch over the old one at the same path: the fresh rows win
 *  (labels, flags, order, additions/removals), but a row that already had its children
 *  loaded keeps them (recursively) when the fresh fetch didn't reach that deep — so a live
 *  refresh never collapses what the user has expanded. */
export function mergeBranch(old: TreeNode | undefined, fresh: TreeNode): TreeNode {
  if (!old) return fresh;
  const byPath = new Map(old.children.map((c) => [c.path, c] as const));
  const children = fresh.children.length
    ? fresh.children.map((c) => mergeBranch(byPath.get(c.path), c))
    : fresh.hasChildren
      ? old.children // past the fetch depth — keep the loaded subtree
      : [];
  return { ...fresh, children };
}

/** How many levels of children are LOADED under `node` — the depth a live refresh must refetch
 *  so no stale row survives past the fetch boundary (see mergeBranch). */
export function loadedDepth(node: TreeNode): number {
  if (!node.children.length) return 0;
  return 1 + Math.max(...node.children.map(loadedDepth));
}

/** Return a copy of `tree` with the fresh subtree merged in at `path` (see mergeBranch). */
export function mergeAt(tree: TreeNode, path: string, fresh: TreeNode): TreeNode {
  if (tree.path === path) return mergeBranch(tree, fresh);
  if (!tree.children.length) return tree;
  return { ...tree, children: tree.children.map((c) => mergeAt(c, path, fresh)) };
}

/** Find the node at `path` in the (partially loaded) tree. */
export function findNode(tree: TreeNode, path: string): TreeNode | null {
  if (tree.path === path) return tree;
  for (const c of tree.children) {
    const f = findNode(c, path);
    if (f) return f;
  }
  return null;
}
