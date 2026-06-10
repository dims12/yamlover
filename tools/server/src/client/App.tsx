import { useCallback, useEffect, useRef, useState } from "react";
import { fetchInfo, fetchTree, PasteResult, TreeNode } from "./api";
import { Tree } from "./Tree";
import { NodeView, Format, FORMATS, DEFAULT_FORMAT } from "./NodeView";
import { rendererName } from "./renderers/registry";

const isStandardFormat = (f: Format) => (FORMATS as string[]).includes(f);
import { crumbs, formatFromUrl, isAncestorPath, pathFromUrl, segsToStr, strToSegs, writeUrl } from "./paths";

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

export function App() {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<string>(pathFromUrl());
  const [format, setFormat] = useState<Format>(formatFromUrl(DEFAULT_FORMAT) as Format);
  const [rootLabel, setRootLabel] = useState<string>(""); // CLI ROOT (breadcrumb head)
  const [leftWidth, setLeftWidth] = useState<number>(320);

  // The breadcrumb head is the ROOT given on the command line (blank if omitted).
  useEffect(() => {
    fetchInfo().then((i) => setRootLabel(i.root)).catch(() => {});
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
    fetchTree("/", INITIAL_DEPTH)
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
    const rn = rendererName(n.type, n.format);
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
      let best = "/";
      for (let k = 0; k < segs.length; k++) {
        const anc = segsToStr(segs.slice(0, k));
        const node = findNode(t, anc);
        if (!node) break;
        if (anc === "/" || node.children.length > 0) best = anc;
      }
      targets.add(best);
    }
    const list = [...targets].filter((a) => ![...targets].some((b) => b !== a && isAncestorPath(b, a)));
    await Promise.all(
      list.map(async (p) => {
        const sub = await fetchTree(p, INITIAL_DEPTH);
        setTree((prev) => (prev ? mergeAt(prev, p, sub) : prev));
      }),
    );
  }, []);

  useEffect(() => {
    if (typeof EventSource === "undefined") return; // test envs (jsdom) have no SSE
    const es = new EventSource("/api/events");
    es.onmessage = (ev) => {
      try {
        const diff = JSON.parse(ev.data) as { added: string[]; changed: string[]; removed: string[] };
        const paths = [...diff.added, ...diff.changed, ...diff.removed];
        if (!paths.length) return;
        refreshBranches(paths).catch(() => {});
        const cur = currentRef.current;
        if (paths.some((p) => p === cur || isAncestorPath(p, cur) || isAncestorPath(cur, p))) {
          setRefreshSignal((s) => s + 1);
        }
      } catch {
        // a malformed frame — ignore
      }
    };
    return () => es.close();
  }, [refreshBranches]);

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
        const rn = rendererName(target.type, target.format);
        f = rn ?? (isStandardFormat(format) ? format : DEFAULT_FORMAT);
      }
      writeUrl(p, f, false);
      setCurrent(p);
      if (f !== format) setFormat(f);
    },
    [format, tree],
  );

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
      loadChildren(target ? p : "/").catch(() => {});
    },
    [tree, loadChildren],
  );

  // A file pasted/dropped onto a directory MEMBER landed in the enclosing dir — open it. We fetch
  // the dir's branch first (so the TOC shows the file AND we learn its type/format), then navigate
  // to it in its renderer's view (an image opens as an image, not as data). Falls back to a plain
  // navigate if the branch fetch fails.
  const onOpenUploaded = useCallback(
    async (result: PasteResult) => {
      const dir = result.dir ?? "/";
      try {
        const sub = await fetchTree(dir, INITIAL_DEPTH);
        setTree((t) => (t ? replaceChildren(t, dir, sub.children) : t));
        const fileNode = sub.children.find((c) => c.path === result.path);
        const f: Format = (fileNode ? rendererName(fileNode.type, fileNode.format) : null) ?? DEFAULT_FORMAT;
        writeUrl(result.path, f, false);
        setCurrent(result.path);
        setFormat(f);
      } catch {
        navigate(result.path);
      }
    },
    [navigate],
  );

  // --- draggable splitter -------------------------------------------------- //
  const dragging = useRef(false);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      setLeftWidth(Math.min(Math.max(e.clientX, 160), window.innerWidth - 240));
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <nav className="crumbs">
          {crumbs(current, rootLabel).map((c, i) => (
            <span key={c.path}>
              {i > 0 && <span className="crumb-sep">/</span>}
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
      </header>

      <div className="body">
        <aside className="pane left" style={{ width: leftWidth }}>
          {error && <div className="error">{error}</div>}
          {!error && !tree && <div className="loading">loading…</div>}
          {tree && (
            <Tree node={tree} current={current} onSelect={navigate} onLoadChildren={loadChildren} />
          )}
        </aside>
        <div
          className="splitter"
          onMouseDown={() => {
            dragging.current = true;
            document.body.style.userSelect = "none";
          }}
        />
        <main className="pane right">
          <NodeView path={current} format={format} refreshSignal={refreshSignal} onFormat={changeFormat} onNavigate={navigate} onContentChanged={onContentChanged} onOpenUploaded={onOpenUploaded} />
        </main>
      </div>
    </div>
  );
}
