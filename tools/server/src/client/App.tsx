import { useCallback, useEffect, useRef, useState } from "react";
import { fetchInfo, fetchTasks, fetchTree, installAgentDocs, PasteResult, TaskInfo, TreeNode } from "./api";
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
import { broadcastDiff } from "./live";

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

/** The TOC rows in document (pre-order) order, mirroring exactly what `Tree`
 *  shows — `tocView` applies the same per-renderer unwrap/filter (chapters
 *  surface subchapters, dirs show children). Used by Ctrl-PgDn/PgUp to step the
 *  selection to the neighbouring entry. Covers only the LOADED tree: per-branch
 *  collapse state lives in each `Tree`'s local `open`, not here — but a branch
 *  starts open once its children are loaded, so loaded ≈ visible in practice;
 *  deep unloaded branches simply aren't reachable until expanded (lazy load). */
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
  const [leftWidth, setLeftWidth] = useState<number>(320);
  const mainRef = useRef<HTMLElement>(null); // RHS pane — focused on TOC click so the keyboard drives the viewer

  // The breadcrumb head is the ROOT given on the command line (blank if omitted).
  useEffect(() => {
    fetchInfo().then((i) => setRootLabel(i.root)).catch(() => {});
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
      for (let k = 0; k < segs.length; k++) {
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
        const sub = await fetchTree(p, INITIAL_DEPTH);
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
    const es = new EventSource("/api/events");
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

  // Leftmost breadcrumb action: install the LLM-agent guidance docs (AGENTS.md + CLAUDE.md) into
  // this project's root. Skip-and-report by default; if everything already exists, offer to
  // overwrite. The new files flow back over SSE (useDiffBump), so the tree refreshes itself.
  const installDocs = useCallback(async () => {
    if (docsState === "busy") return;
    setDocsState("busy");
    try {
      let { files } = await installAgentDocs();
      if (files.every((f) => f.status === "exists")) {
        const names = files.map((f) => f.name).join(" and ");
        if (window.confirm(`${names} already exist in this project. Overwrite with the bundled version?`)) {
          files = (await installAgentDocs(true)).files;
        }
      }
      const wrote = files.filter((f) => f.status !== "exists").map((f) => f.name);
      setError(null);
      if (wrote.length) window.alert(`Installed agent guide: ${wrote.join(", ")}.`);
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
          <button
            type="button"
            className="crumb-action"
            disabled={docsState === "busy"}
            title="Install the LLM agent guide (AGENTS.md + CLAUDE.md) into this project"
            aria-label="Install LLM agent guide"
            onClick={installDocs}
          >
            🤖
          </button>
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
        <TaskStrip tasks={tasks} />
      </header>

      <div className="body">
        <aside className="pane left" style={{ width: leftWidth }}>
          {(() => {
            // no tree yet + a server task running ⇒ the index is still being built — show
            // its progress instead of a stale fetch error / a bare "loading…"
            const running = !tree ? tasks.find((t) => t.state === "running") : undefined;
            if (running) {
              const { done, total } = running.progress;
              return <div className="loading">{running.label}… {total ? `${done}/${total}` : ""}</div>;
            }
            if (error) return <div className="error">{error}</div>;
            if (!tree) return <div className="loading">loading…</div>;
            return <Tree node={tree} current={current} onSelect={selectFromToc} onLoadChildren={loadChildren} />;
          })()}
        </aside>
        <div
          className="splitter"
          onMouseDown={() => {
            dragging.current = true;
            document.body.style.userSelect = "none";
          }}
        />
        <main className="pane right" ref={mainRef} tabIndex={-1}>
          {(() => {
            // Cold start: the content fetch 404s ("no such node") until the FIRST index lands,
            // just like the tree. Show the index progress instead of NodeView's raw error; once
            // the tree is loaded NodeView renders and (re)fetches normally (refreshSignal/diff).
            const running = !tree ? tasks.find((t) => t.state === "running") : undefined;
            if (running) {
              const { done, total } = running.progress;
              return <div className="loading">{running.label}… {total ? `${done}/${total}` : ""}</div>;
            }
            return <NodeView path={current} format={format} refreshSignal={refreshSignal} onFormat={changeFormat} onNavigate={navigate} onContentChanged={onContentChanged} onOpenUploaded={onOpenUploaded} />;
          })()}
        </main>
      </div>
    </div>
  );
}
