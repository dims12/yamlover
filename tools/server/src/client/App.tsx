import { useCallback, useEffect, useRef, useState } from "react";
import { createNode, createObject, fetchInfo, fetchTasks, fetchTree, installAgentDocs, PasteResult, TaskInfo, TreeNode } from "./api";
import { api } from "./base";
import { Tree } from "./Tree";
import { TaskStrip } from "./TaskStrip";
import { NodeView, Format, FORMATS, DEFAULT_FORMAT, isJsonConcrete } from "./NodeView";
import { rendererName, tocView } from "./renderers/registry";

const isStandardFormat = (f: Format) => (FORMATS as string[]).includes(f);
/** Whether `format` may be CARRIED onto a node, given its concrete: every standard format except
 *  `json5p`, which the target node only offers when it is a json-family file. */
const formatTravelsTo = (f: Format, concrete?: string | null) =>
  isStandardFormat(f) && (f !== "json5p" || isJsonConcrete(concrete));
import { crumbs, formatFromUrl, isAncestorPath, pathFromUrl, segsToStr, strToSegs, writeUrl } from "./paths";
import { BrowserSettingsView } from "./BrowserSettingsView";
import { applyTheme, BROWSER_SETTINGS_PATH, isBrowserSettingsPath, primeProjectSettings } from "./browser-settings";
import { broadcastDiff } from "./live";
import { Fragments, fragmentGroups } from "./Fragments";
import { useAnnotations } from "./renderers/annotate";
import { useExplorerTagMenu } from "./renderers/tagmenu";
import { NODE_SCHEMA } from "./renderers/create";

/** Read a persisted boolean UI flag (collapse state) from localStorage, defaulting false when it
 *  is unset or unavailable (e.g. a jsdom test env). */
function persistedFlag(key: string): boolean {
  try { return localStorage.getItem(key) === "1"; } catch { return false; }
}

/** A pane separator that both RESIZES (drag anywhere on the line) and COLLAPSES (the chevron
 *  handle riding it) its pane. The handle replaced the old topbar toggles: the control lives on
 *  the line it acts on, and the line stays put when the pane is collapsed, so the same spot
 *  expands it back. Collapsed, the line no longer drags (there is nothing to resize). */
function Splitter({ collapsed, glyph, label, onToggle, onDragStart }: {
  collapsed: boolean;
  glyph: string;
  label: string;
  onToggle: () => void;
  onDragStart: () => void;
}) {
  return (
    <div className={"splitter" + (collapsed ? " collapsed" : "")} onMouseDown={collapsed ? undefined : onDragStart}>
      <button
        type="button"
        className="splitter-toggle"
        title={label}
        aria-label={label}
        aria-expanded={!collapsed}
        onClick={onToggle}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {glyph}
      </button>
    </div>
  );
}

// Levels of the TOC fetched at once — initially and on each lazy expand. One
// level keeps every fetch cheap on a huge/slow tree (a fetch only reads the
// directories it actually shows); deeper levels load instantly on expand.
const INITIAL_DEPTH = 1;

/** Return a copy of `tree` with the children of the node at `path` replaced. */
function replaceChildren(tree: TreeNode, path: string, children: TreeNode[]): TreeNode {
  if (tree.path === path) return { ...tree, children };
  if (!tree.children.length) return tree;
  return { ...tree, children: tree.children.map((c) => replaceChildren(c, path, children)) };
}

/** Merge a freshly fetched branch over the old one at the same path: the fresh rows win
 *  (labels, flags, order, additions/removals), but a row that already had its children
 *  loaded keeps them (recursively) when the fresh fetch didn't reach that deep — so a live
 *  refresh never collapses what the user has expanded. */
function mergeBranch(old: TreeNode | undefined, fresh: TreeNode): TreeNode {
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
function loadedDepth(node: TreeNode): number {
  if (!node.children.length) return 0;
  return 1 + Math.max(...node.children.map(loadedDepth));
}

/** Return a copy of `tree` with the fresh subtree merged in at `path` (see mergeBranch). */
function mergeAt(tree: TreeNode, path: string, fresh: TreeNode): TreeNode {
  if (tree.path === path) return mergeBranch(tree, fresh);
  if (!tree.children.length) return tree;
  return { ...tree, children: tree.children.map((c) => mergeAt(c, path, fresh)) };
}

/** Find the node at `path` in the (partially loaded) tree. */
function findNode(tree: TreeNode, path: string): TreeNode | null {
  if (tree.path === path) return tree;
  for (const c of tree.children) {
    const f = findNode(c, path);
    if (f) return f;
  }
  return null;
}

/** The shallowest ancestor of `current` that is loaded but whose children are
 *  not yet fetched — the next branch to load while revealing `current`. */
function nextToLoad(tree: TreeNode, current: string): string | null {
  const segs = strToSegs(current);
  for (let k = 0; k < segs.length; k++) {
    const ancestor = segsToStr(segs.slice(0, k));
    const node = findNode(tree, ancestor);
    if (!node) return null; // the path diverges from the tree (e.g. invalid) — stop
    if (node.hasChildren && node.children.length === 0) return ancestor;
  }
  return null;
}

/** The TOC rows in document (pre-order) order, mirroring exactly what `Tree`
 *  shows — `tocView` applies the same per-renderer unwrap/filter (chapters
 *  surface subchapters, dirs show children). Used by Ctrl-PgDn/PgUp to step the
 *  selection to the neighbouring entry. Covers only the LOADED tree: per-branch
 *  collapse state lives in each `Tree`'s local `open`, not here — branches start
 *  collapsed, so stepping may land on a row inside a collapsed branch; Tree's
 *  reveal-the-selection effect opens its ancestors, making it visible. Deep
 *  unloaded branches simply aren't reachable until expanded (lazy load). */
function flattenToc(tree: TreeNode | null): string[] {
  if (!tree) return [];
  const out: string[] = [];
  const walk = (n: TreeNode) => {
    out.push(n.path);
    for (const c of tocView(n).children) walk(c);
  };
  walk(tree);
  return out;
}

export function App() {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<string>(pathFromUrl());
  const [format, setFormat] = useState<Format>(formatFromUrl(DEFAULT_FORMAT) as Format);
  const [rootLabel, setRootLabel] = useState<string>(""); // CLI ROOT (breadcrumb head)
  const [docsState, setDocsState] = useState<"idle" | "busy">("idle");
  // The BROWSER SETTINGS page (BrowserSettingsView) lives at the VIRTUAL path
  // `:.browser:settings.yamlover` (`*:: .browser: settings.yamlover`): a real address — URL,
  // history, breadcrumbs — in a namespace no served tree can occupy (the walk skips every
  // dot-directory except `.yamlover`). The document itself is in localStorage, so the main pane
  // renders BrowserSettingsView for this path instead of the server-backed NodeView.
  const openBrowserSettings = useCallback(() => {
    writeUrl(BROWSER_SETTINGS_PATH, DEFAULT_FORMAT, false);
    setCurrent(BROWSER_SETTINGS_PATH);
    setFormat(DEFAULT_FORMAT);
  }, []);
  // The gear opens the project config (IMPORTS.md): the hidden settings node, shown in the main pane
  // by the ordinary (editable) yamlover data view — it is NOT in the TOC tree, so navigate directly
  // with the default format rather than the tree-based `navigate` (which can't find a hidden node).
  const openSettings = useCallback(() => {
    const p = ":.yamlover:settings.yamlover";
    writeUrl(p, DEFAULT_FORMAT, false);
    setCurrent(p);
    setFormat(DEFAULT_FORMAT);
  }, []);
  // Which LHS tab is open — the TOC tree or the settings/actions list. The activity
  // bar (an icon strip along the pane's bottom edge) switches between them.
  const [leftTab, setLeftTab] = useState<"toc" | "settings">("toc");
  const [leftWidth, setLeftWidth] = useState<number>(320);
  const [rightWidth, setRightWidth] = useState<number>(300); // the fragments pane (when shown)
  // The TOC (LHS) and the fragments pane (RHS) collapse independently; the choice persists.
  const [leftCollapsed, setLeftCollapsed] = useState<boolean>(() => persistedFlag("yo-left-collapsed"));
  const [rightCollapsed, setRightCollapsed] = useState<boolean>(() => persistedFlag("yo-right-collapsed"));
  useEffect(() => { try { localStorage.setItem("yo-left-collapsed", leftCollapsed ? "1" : "0"); } catch { /* ignore */ } }, [leftCollapsed]);
  useEffect(() => { try { localStorage.setItem("yo-right-collapsed", rightCollapsed ? "1" : "0"); } catch { /* ignore */ } }, [rightCollapsed]);
  const mainRef = useRef<HTMLElement>(null); // RHS pane — focused on TOC click so the keyboard drives the viewer

  // The current entity's fragments (tagged regions) drive the RHS panel; it auto-hides when there
  // are none. Fetched here (not only in NodeView) so "has fragments" can gate the layout from App.
  // The DATA views (yamlover / json5p / schema) show the fragments *in the data* (overlay entries),
  // so the panel would duplicate them — it accompanies only the rendered views.
  const fragGroups = fragmentGroups(useAnnotations(current));
  const fragmentsAvailable = fragGroups.length > 0 && !FORMATS.includes(format); // gates the RHS splitter
  const showFragments = fragmentsAvailable && !rightCollapsed;

  // The breadcrumb head is the ROOT given on the command line (blank if omitted).
  useEffect(() => {
    fetchInfo().then((i) => setRootLabel(i.root)).catch(() => {});
  }, []);

  // The PROJECT settings layer for viewer preferences (reading width, theme): fetched once per
  // load — the browser settings document overrides it, so live refresh is not worth the plumbing.
  // applyTheme() first stamps the browser layer's theme (the mirror already painted it pre-React);
  // primeProjectSettings re-applies once the project layer arrives.
  useEffect(() => {
    applyTheme();
    primeProjectSettings();
  }, []);

  // Long-running server tasks (indexing, hashing, …): seeded from /api/tasks (a page loaded
  // mid-task), updated by `{type:"task"}` SSE frames; finished ones linger ~3s then drop.
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  useEffect(() => {
    fetchTasks().then(setTasks).catch(() => {});
  }, []);
  const upsertTask = useCallback((t: TaskInfo) => {
    setTasks((prev) => [...prev.filter((x) => x.id !== t.id), t].sort((a, b) => a.startedAt - b.startedAt));
    if (t.state !== "running") {
      setTimeout(() => setTasks((prev) => prev.filter((x) => x.id !== t.id)), 3000);
    }
  }, []);

  // Whether the initial URL pinned a representation; if not, a landing node that
  // has a renderer opens in its rendered view (decided once the TOC loads).
  const explicitFormat = useRef(new URLSearchParams(window.location.search).has("format"));

  // Reflect the initial path+format back into the URL (so ?format= is present).
  useEffect(() => {
    writeUrl(current, format, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the TOC's first few levels; deeper branches load on expand.
  useEffect(() => {
    fetchTree(":", INITIAL_DEPTH)
      .then(setTree)
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // First time the landing node appears in the TOC (immediately when shallow,
  // after lazy-loading the path when deep-linked), open it in its renderer's
  // view — unless the URL pinned a representation. Runs once; later tab switches
  // and in-app navigation make their own choice.
  const resolvedLanding = useRef(false);
  useEffect(() => {
    if (explicitFormat.current || resolvedLanding.current || !tree) return;
    const n = findNode(tree, current);
    if (!n) return; // not loaded along the path yet — wait for the next pass
    resolvedLanding.current = true;
    const rn = rendererName(n, n.concrete);
    if (rn) {
      setFormat(rn);
      writeUrl(current, rn, true);
    }
  }, [tree, current]);

  // Fetch a collapsed branch's children and splice them into the tree in place.
  // `levels` is how deep to pull (default one): a renderer whose TOC rows sit
  // deeper than its direct children (a chapter, surfacing subchapters from under
  // its `children` wrapper) asks for more, so one expand reveals them.
  const loadChildren = useCallback(async (path: string, levels = INITIAL_DEPTH) => {
    const sub = await fetchTree(path, levels);
    setTree((t) => (t ? replaceChildren(t, path, sub.children) : t));
  }, []);

  // Reveal the current node: lazily load the branches along its path (one level
  // per pass; each load re-runs this until the whole path is present), so a
  // deep-linked / pasted URL gets its TOC entry expanded and selected.
  useEffect(() => {
    if (!tree) return;
    const next = nextToLoad(tree, current);
    if (next) loadChildren(next).catch(() => {});
  }, [tree, current, loadChildren]);

  // Live refresh: the server watches the filesystem and pushes each reindex diff over SSE
  // (/api/events). For every changed path we re-fetch its deepest LOADED tree branch (merged
  // in, so expanded subtrees stay open), and re-fetch the node pane when the current node is
  // touched. Unloaded branches need nothing — they fetch fresh on expand anyway.
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const currentRef = useRef(current);
  currentRef.current = current;
  const [refreshSignal, setRefreshSignal] = useState(0);

  const refreshBranches = useCallback(async (paths: string[]) => {
    const t = treeRef.current;
    if (!t) return;
    const targets = new Set<string>();
    for (const p of paths) {
      const segs = strToSegs(p);
      let best = ":";
      // walk INCLUDES the changed node itself (k === segs.length): an edit inside a document must
      // refresh the document's own loaded branch — its subchapter rows and labels — not just the
      // ancestor listing that names the document.
      for (let k = 0; k <= segs.length; k++) {
        const anc = segsToStr(segs.slice(0, k));
        const node = findNode(t, anc);
        if (!node) break;
        if (anc === ":" || node.children.length > 0) best = anc;
      }
      targets.add(best);
    }
    const list = [...targets].filter((a) => ![...targets].some((b) => b !== a && isAncestorPath(b, a)));
    await Promise.all(
      list.map(async (p) => {
        // fetch as deep as the user has this branch loaded: mergeBranch keeps rows past the fetch
        // boundary, so a shallower fetch would leave the expanded tail showing stale labels.
        const found = findNode(treeRef.current ?? t, p);
        const sub = await fetchTree(p, Math.max(INITIAL_DEPTH, found ? loadedDepth(found) : 0));
        setTree((prev) => (prev ? mergeAt(prev, p, sub) : prev));
      }),
    );
  }, []);

  // Cold-start recovery: a page opened before the FIRST index landed has no tree (the initial
  // fetch 404'd on an empty store). When the index task finishes — or any diff arrives —
  // retry the initial fetches and clear the stale error.
  const retryInitial = useCallback(() => {
    if (treeRef.current) return;
    fetchTree(":", INITIAL_DEPTH)
      .then((t) => {
        setTree(t);
        setError(null);
      })
      .catch(() => {});
    fetchInfo().then((i) => setRootLabel(i.root)).catch(() => {});
  }, []);

  useEffect(() => {
    if (typeof EventSource === "undefined") return; // test envs (jsdom) have no SSE
    const es = new EventSource(api("/api/events"));
    // `open` fires on the initial connect AND on every auto-RECONNECT. A reconnect means the stream
    // was down — typically the SERVER RESTARTED. Changes that landed while we were disconnected may
    // have arrived with NO frame we saw (a fast reindex can finish before the browser reconnects), so
    // a view that errored during the outage would otherwise stay broken forever. On reconnect, force
    // a re-sync: refetch the loaded tree and the current node so the page heals itself.
    let opened = false;
    es.onopen = () => {
      if (!opened) { opened = true; return; } // initial connect — the direct initial fetches cover it
      retryInitial(); // cold: fetch the tree if we still have none
      fetchTree(":", INITIAL_DEPTH).then((t) => setTree((prev) => (prev ? mergeAt(prev, ":", t) : t))).catch(() => {});
      setRefreshSignal((s) => s + 1); // NodeView refetches (and clears any stale "no such node" error)
    };
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { type?: string };
        if (msg.type === "task") {
          const t = (msg as unknown as { task: TaskInfo }).task;
          upsertTask(t);
          if (t.state === "done") retryInitial(); // no-op once the tree is loaded
          return;
        }
        const diff = msg as unknown as {
          added: string[]; changed: string[]; removed: string[];
          moved?: { from: string; to: string }[]; // inferred moves (frame-compatible: optional)
        };
        retryInitial(); // no-op once the tree is loaded
        const paths = [...diff.added, ...diff.changed, ...diff.removed,
          ...(diff.moved ?? []).flatMap((m) => [m.from, m.to])];
        if (!paths.length) return;
        // Re-broadcast for the useDiffBump subscribers (live.ts — the unified change flow):
        // hooks outside this component's prop reach refetch from the same diff currency.
        broadcastDiff({ paths, removed: diff.removed });
        refreshBranches(paths).catch(() => {});
        const cur = currentRef.current;
        // The viewed node (or a document holding it) vanished from disk — e.g. the file was
        // deleted while its page (even its editor) was open. Leave the tombstone: navigate to
        // the removed node's PARENT, the nearest thing that still exists.
        const gone = diff.removed.find((p) => p === cur || isAncestorPath(p, cur));
        if (gone) {
          const parent = segsToStr(strToSegs(gone).slice(0, -1));
          navigateRef.current(parent === "" ? ":" : parent);
          return;
        }
        if (paths.some((p) => p === cur || isAncestorPath(p, cur) || isAncestorPath(cur, p))) {
          setRefreshSignal((s) => s + 1);
        }
      } catch {
        // a malformed frame — ignore
      }
    };
    return () => es.close();
  }, [refreshBranches, upsertTask, retryInitial]);

  // Keep state in sync with the browser's back/forward buttons.
  useEffect(() => {
    const onPop = () => {
      setCurrent(pathFromUrl());
      setFormat(formatFromUrl(DEFAULT_FORMAT) as Format);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Navigating changes the path. The format carries over, except: a target that
  // has a renderer opens in that renderer's view (so e.g. a chapter reads as a
  // page, with its tab active), and leaving a renderer node drops a stale renderer
  // format back to the default. A target absent from the TOC keeps the current
  // format — reading deeper into a rendered tree stays rendered. NodeView makes
  // the final call from the fetched node's (type, format).
  const navigate = useCallback(
    (p: string) => {
      const target = tree ? findNode(tree, p) : null;
      let f: Format = format;
      if (target) {
        const rn = rendererName(target, target.concrete);
        f = rn ?? (formatTravelsTo(format, target.concrete) ? format : DEFAULT_FORMAT);
      }
      writeUrl(p, f, false);
      setCurrent(p);
      if (f !== format) setFormat(f);
    },
    [format, tree],
  );

  // Selecting a TOC row navigates AND hands keyboard focus to the RHS pane, so
  // Ctrl-PgDn/PgUp (and plain scroll keys) drive the viewer right after a click.
  // Scoped to the tree — crumbs and in-content links keep plain `navigate`.
  const selectFromToc = useCallback(
    (p: string) => {
      navigate(p);
      mainRef.current?.focus();
    },
    [navigate],
  );

  // Right-click a TOC row → the whole-node tag picker, plus "＋ New <schema>" (with a concrete
  // selector) for every schema creatable at that row (a directory / a chapter). Creating navigates
  // into the new object and opens it UNLOCKED (chapter editor / editable yamlover view).
  const [unlockSignal, setUnlockSignal] = useState(0);
  const { openAt: openTocMenu, tagMenu: tocMenu } = useExplorerTagMenu({
    onCreate: (schema, parent, concrete) =>
      void (schema === NODE_SCHEMA ? createNode(parent, concrete) : createObject(schema, parent, concrete))
        .then(async (r) => {
          // the fresh node is not in the TOC yet, so a plain navigate would CARRY the current
          // format onto it (e.g. the folder's `large-icons`) — harmless while the node is empty,
          // but once edits make it a CONTAINER the stale format becomes one of its tabs and the
          // post-lock refetch would open the explorer instead of the data view. Load its branch
          // (the TOC gains the file too) and land in the node's OWN default view.
          let f: Format = DEFAULT_FORMAT;
          try {
            const sub = await fetchTree(parent || ":", INITIAL_DEPTH);
            setTree((t) => (t ? replaceChildren(t, parent || ":", sub.children) : t));
            const fresh = sub.children.find((c) => c.path === r.path);
            if (fresh) f = (rendererName(fresh, fresh.concrete) as Format) ?? DEFAULT_FORMAT;
          } catch { /* the default format still lands */ }
          writeUrl(r.path, f, false);
          setCurrent(r.path);
          setFormat(f);
          setUnlockSignal((s) => s + 1);
        })
        .catch((e) => window.alert("create failed: " + (e as Error).message)),
  });
  const onTocContext = useCallback((n: TreeNode, x: number, y: number) => openTocMenu(n.path, x, y, n), [openTocMenu]);

  // Ctrl/Alt + Down / Up step the selection to the next / previous TOC entry in
  // document order (Alt as well as Ctrl because Ctrl+Up/Down is taken by macOS
  // Mission Control). Attached once; reads live state through refs so the listener
  // stays stable. `navigate` reveals + scrolls the new row (Tree's selected effect).
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.altKey) || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const order = flattenToc(treeRef.current);
      const i = order.indexOf(currentRef.current);
      if (i < 0) return; // current not in the loaded TOC yet — nothing to step from
      const next = Math.min(Math.max(i + (e.key === "ArrowDown" ? 1 : -1), 0), order.length - 1);
      e.preventDefault();
      if (next !== i) navigateRef.current(order[next]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const changeFormat = useCallback(
    (f: Format) => {
      writeUrl(current, f, true);
      setFormat(f);
    },
    [current],
  );

  // A paste/upload added a file (and maybe a chapter chunk) at `p`. Reload that branch of the TOC
  // so a new directory child shows up; fall back to the root when the branch isn't loaded yet.
  const onContentChanged = useCallback(
    (p: string) => {
      const target = tree ? findNode(tree, p) : null;
      loadChildren(target ? p : ":").catch(() => {});
    },
    [tree, loadChildren],
  );

  // A file pasted/dropped onto a directory MEMBER landed in the enclosing dir — open it. We fetch
  // the dir's branch first (so the TOC shows the file AND we learn its type/format), then navigate
  // to it in its renderer's view (an image opens as an image, not as data). Falls back to a plain
  // navigate if the branch fetch fails.
  const onOpenUploaded = useCallback(
    async (result: PasteResult) => {
      const dir = result.dir ?? ":";
      try {
        const sub = await fetchTree(dir, INITIAL_DEPTH);
        setTree((t) => (t ? replaceChildren(t, dir, sub.children) : t));
        const fileNode = sub.children.find((c) => c.path === result.path);
        const f: Format = (fileNode ? rendererName(fileNode, fileNode.concrete) : null) ?? DEFAULT_FORMAT;
        writeUrl(result.path, f, false);
        setCurrent(result.path);
        setFormat(f);
      } catch {
        navigate(result.path);
      }
    },
    [navigate],
  );

  // --- draggable splitters (LHS tree + RHS fragments) ---------------------- //
  const dragging = useRef<"left" | "right" | null>(null);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragging.current === "left") {
        setLeftWidth(Math.min(Math.max(e.clientX, 160), window.innerWidth - 240));
      } else if (dragging.current === "right") {
        setRightWidth(Math.min(Math.max(window.innerWidth - e.clientX, 200), window.innerWidth - 240));
      }
    };
    const onUp = () => {
      dragging.current = null;
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);
  const startDrag = (side: "left" | "right") => {
    dragging.current = side;
    document.body.style.userSelect = "none";
  };

  // Settings-tab action: install the LLM-agent guidance docs (AGENTS.md + CLAUDE.md) into
  // this project's root. The guidance is a marker-fenced block, so an existing file gets it
  // appended (or updated in place) without clobbering the human's own rules — safe to repeat, no
  // confirm needed. The written files flow back over SSE (useDiffBump), so the tree self-refreshes.
  const installDocs = useCallback(async () => {
    if (docsState === "busy") return;
    setDocsState("busy");
    try {
      const { files } = await installAgentDocs();
      const wrote = files.filter((f) => f.status !== "exists").map((f) => f.name);
      setError(null);
      window.alert(
        wrote.length
          ? `Installed agent guide: ${wrote.join(", ")}.`
          : "Agent guide is already up to date.",
      );
    } catch (e) {
      setError(`agent docs: ${(e as Error).message}`);
    } finally {
      setDocsState("idle");
    }
  }, [docsState]);

  return (
    <div className="app">
      <header className="topbar">
        <nav className="crumbs">
          {crumbs(current, rootLabel).map((c, i) => (
            <span key={c.path}>
              {i > 0 && <span className="crumb-sep">:</span>}
              <a
                className="crumb"
                href={c.path}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(c.path);
                }}
              >
                {c.label}
              </a>
            </span>
          ))}
        </nav>
        {/* the right group is pinned to the topbar's right edge (via `.topbar-right`), so the
            task strip always hugs the RHS pane. */}
        <div className="topbar-right">
          <TaskStrip tasks={tasks} />
        </div>
      </header>

      <div className="body">
        {!leftCollapsed && (
          <aside className="pane left" style={{ width: leftWidth }}>
            <div className="left-content">
              {leftTab === "settings" ? (
                <div className="side-actions">
                  <button
                    type="button"
                    className="side-action"
                    title="Project settings (settings.yamlover)"
                    onClick={openSettings}
                  >
                    <span className="side-action-icon" aria-hidden="true">⚙</span>
                    <span className="side-action-title">Project settings</span>
                  </button>
                  <button
                    type="button"
                    className="side-action"
                    title="Local settings (this device — stored in this browser)"
                    onClick={openBrowserSettings}
                  >
                    <span className="side-action-icon" aria-hidden="true">{"⛭"}</span>
                    <span className="side-action-title">Local settings</span>
                  </button>
                  <button
                    type="button"
                    className="side-action"
                    disabled={docsState === "busy"}
                    title="Install the LLM agent guide (AGENTS.md + CLAUDE.md) into this project"
                    onClick={installDocs}
                  >
                    <span className="side-action-icon" aria-hidden="true">🤖</span>
                    <span className="side-action-title">Install LLM agent guide</span>
                  </button>
                </div>
              ) : (() => {
                // no tree yet + a server task running ⇒ the index is still being built — show
                // its progress instead of a stale fetch error / a bare "loading…"
                const running = !tree ? tasks.find((t) => t.state === "running") : undefined;
                if (running) {
                  const { done, total } = running.progress;
                  return <div className="loading">{running.label}… {total ? `${done}/${total}` : ""}</div>;
                }
                if (error) return <div className="error">{error}</div>;
                if (!tree) return <div className="loading">loading…</div>;
                return <Tree node={tree} current={current} onSelect={selectFromToc} onLoadChildren={loadChildren} onContext={onTocContext} />;
              })()}
            </div>
            <nav className="activity-bar" aria-label="Sidebar tabs">
              <button
                type="button"
                className={"activity-tab" + (leftTab === "toc" ? " active" : "")}
                title="Table of contents"
                aria-label="Table of contents"
                aria-pressed={leftTab === "toc"}
                onClick={() => setLeftTab("toc")}
              >
                ☰
              </button>
              <button
                type="button"
                className={"activity-tab" + (leftTab === "settings" ? " active" : "")}
                title="Settings"
                aria-label="Settings"
                aria-pressed={leftTab === "settings"}
                onClick={() => setLeftTab("settings")}
              >
                ⚙
              </button>
            </nav>
          </aside>
        )}
        <Splitter
          collapsed={leftCollapsed}
          glyph={leftCollapsed ? "»" : "«"}
          label={leftCollapsed ? "Show the tree" : "Hide the tree"}
          onToggle={() => setLeftCollapsed((v) => !v)}
          onDragStart={() => startDrag("left")}
        />
        <main className="pane right" ref={mainRef} tabIndex={-1}>
          {(() => {
            // The browser-settings page: its VIRTUAL path (`:.browser:…`) never names a server
            // node — the document lives in localStorage — so it renders its own view, not NodeView.
            if (isBrowserSettingsPath(current)) return <BrowserSettingsView onNavigate={navigate} />;
            // Cold start: the content fetch 404s ("no such node") until the FIRST index lands,
            // just like the tree. Show the index progress instead of NodeView's raw error; once
            // the tree is loaded NodeView renders and (re)fetches normally (refreshSignal/diff).
            const running = !tree ? tasks.find((t) => t.state === "running") : undefined;
            if (running) {
              const { done, total } = running.progress;
              return <div className="loading">{running.label}… {total ? `${done}/${total}` : ""}</div>;
            }
            return <NodeView path={current} format={format} refreshSignal={refreshSignal} unlockSignal={unlockSignal} onFormat={changeFormat} onNavigate={navigate} onContentChanged={onContentChanged} onOpenUploaded={onOpenUploaded} />;
          })()}
        </main>
        {fragmentsAvailable && (
          <>
            <Splitter
              collapsed={rightCollapsed}
              glyph={rightCollapsed ? "«" : "»"}
              label={rightCollapsed ? "Show fragments" : "Hide fragments"}
              onToggle={() => setRightCollapsed((v) => !v)}
              onDragStart={() => startDrag("right")}
            />
            {showFragments && <Fragments path={current} groups={fragGroups} width={rightWidth} onNavigate={navigate} />}
          </>
        )}
      </div>
      {tocMenu}
    </div>
  );
}
