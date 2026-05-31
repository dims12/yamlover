import { useCallback, useEffect, useRef, useState } from "react";
import { fetchInfo, fetchTree, TreeNode } from "./api";
import { Tree } from "./Tree";
import { NodeView, Format, FORMATS, DEFAULT_FORMAT } from "./NodeView";
import { rendererName } from "./renderers/registry";

const isStandardFormat = (f: Format) => (FORMATS as string[]).includes(f);
import { crumbs, formatFromUrl, pathFromUrl, segsToStr, strToSegs, writeUrl } from "./paths";

// Levels of the TOC fetched at once — initially and on each lazy expand.
const INITIAL_DEPTH = 3;

/** Return a copy of `tree` with the children of the node at `path` replaced. */
function replaceChildren(tree: TreeNode, path: string, children: TreeNode[]): TreeNode {
  if (tree.path === path) return { ...tree, children };
  if (!tree.children.length) return tree;
  return { ...tree, children: tree.children.map((c) => replaceChildren(c, path, children)) };
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
      .then((t) => {
        setTree(t);
        if (!explicitFormat.current) {
          const n = findNode(t, current);
          const rn = n ? rendererName(n.type, n.format) : null;
          if (rn) {
            setFormat(rn);
            writeUrl(current, rn, true);
          }
        }
      })
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch a collapsed branch's children and splice them into the tree in place.
  const loadChildren = useCallback(async (path: string) => {
    const sub = await fetchTree(path, INITIAL_DEPTH);
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
          <NodeView path={current} format={format} onFormat={changeFormat} onNavigate={navigate} />
        </main>
      </div>
    </div>
  );
}
