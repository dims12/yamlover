// The SINGLE owner of the TOC's query-filter state. Several hosts can drive the filtered
// TOC — the breadcrumb (browse), an in-place reference cell, the tag picker — but the TOC
// is one surface, so exactly ONE session is active at a time: `begin()` evicts the previous
// owner (which must abandon its edit — e.g. the breadcrumb dispatches ESCAPE), and TOC row
// clicks route to the active owner's `onPick` instead of navigating.
//
// App instantiates the hook, renders `filter` in place of the normal tree, and provides the
// session through `TocFilterCtx` so hosts deep under NodeView reach it without prop drilling.

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { fetchTree, TreeNode } from "./api";
import { replaceChildren } from "./tree-model";

export interface TocFilter {
  root: TreeNode; // the pruned tree (matches + ancestors + match children)
  truncated: boolean;
}

/** What a host holds while it owns the TOC filter. All methods are no-ops after eviction. */
export interface TocFilterHandle {
  /** Publish a fresh filter result (null clears the tree but keeps the session). */
  set(f: TocFilter | null): void;
  /** Chevron loads of REAL children inside the filter tree. */
  loadChildren(path: string, levels?: number): Promise<void>;
  /** Release the session (the normal TOC returns). */
  end(): void;
}

export interface TocFilterSession {
  /** The active owner's filter — App renders it in place of the normal tree. */
  filter: TocFilter | null;
  /** Whether any host currently owns the session (TOC clicks route to it). */
  active: boolean;
  /** A TOC row clicked while a session is active — routed to the owner's onPick. */
  pick(path: string): void;
  /** Chevron loads on the currently displayed filter tree. */
  loadChildren(path: string, levels?: number): Promise<void>;
  /** Claim the TOC filter. Evicts (and notifies) the previous owner. */
  begin(owner: { onPick: (path: string) => void; onEvicted?: () => void }): TocFilterHandle;
}

interface Owner {
  onPick: (path: string) => void;
  onEvicted?: () => void;
}

/** The session implementation — lives in App (the TOC's owner). */
export function useTocFilterSession(): TocFilterSession {
  const [filter, setFilter] = useState<TocFilter | null>(null);
  const [active, setActive] = useState(false);
  const ownerRef = useRef<Owner | null>(null);

  const loadChildren = useCallback(async (path: string, levels = 1) => {
    const sub = await fetchTree(path, levels);
    setFilter((f) => (f ? { ...f, root: replaceChildren(f.root, path, sub.children) } : f));
  }, []);

  const begin = useCallback(
    (owner: Owner): TocFilterHandle => {
      const prev = ownerRef.current;
      if (prev && prev !== owner) prev.onEvicted?.(); // the loser abandons its edit
      ownerRef.current = owner;
      setActive(true);
      setFilter(null); // a fresh session starts with no filter (normal TOC until the first result)
      const mine = () => ownerRef.current === owner;
      return {
        set: (f) => {
          if (mine()) setFilter(f);
        },
        loadChildren: (path, levels) => (ownerRef.current === owner ? loadChildren(path, levels) : Promise.resolve()),
        end: () => {
          if (!mine()) return; // already evicted — the next owner's state stands
          ownerRef.current = null;
          setActive(false);
          setFilter(null);
        },
      };
    },
    [loadChildren],
  );

  const pick = useCallback((path: string) => {
    ownerRef.current?.onPick(path);
  }, []);

  return { filter, active, pick, loadChildren, begin };
}

export const TocFilterCtx = createContext<TocFilterSession | null>(null);

/** The nearest session (null outside App — e.g. bare component tests). */
export function useTocFilter(): TocFilterSession | null {
  return useContext(TocFilterCtx);
}
